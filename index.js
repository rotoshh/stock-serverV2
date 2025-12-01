// index.js — RiskWise AI Server (optimized risk calc)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const dayjs = require('dayjs');
const WebSocket = require('ws');

const { getRealTimePrice: getAlpacaPrice } = require('./alpacaPriceFetcher');
const { getRealTimePrice: getFinnhubPrice } = require('./finnhubPriceFetcher');
const { sendEmail } = require('./emailService');
const { analyzeStockRisk } = require('./riskAnalyzer');
const { sendPushNotification } = require('./pushServices');
const log = console;

const app = express();
const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';

if (!FINNHUB_KEY) log.warn('WARNING: FINNHUB_API_KEY not set — event polling and news will not work.');

// CONFIG: tune these via env if needed
const MIN_RISK_INTERVAL_MS = Number(process.env.MIN_RISK_INTERVAL_MS || 5 * 60 * 1000); // default: 5 minutes between risk calcs per symbol
const EVENT_RISK_COOLDOWN_MS = Number(process.env.EVENT_RISK_COOLDOWN_MS || 60 * 1000); // min interval for event-driven calc per symbol
const PORTFOLIO_RECALC_COOLDOWN_MS = Number(process.env.PORTFOLIO_RECALC_COOLDOWN_MS || 30 * 1000); // min interval between portfolio recalc
const PRICE_CHANGE_RISK_THRESHOLD_PCT = Number(process.env.PRICE_CHANGE_RISK_THRESHOLD_PCT || 1); // percent change to trigger risk calc
const LOG_THROTTLE_MS = Number(process.env.LOG_THROTTLE_MS || 60 * 1000); // throttle repetitive logs per symbol

// CORS
const allowedOrigins = [
  'https://preview--risk-wise-396ab87e.base44.app',
  'http://localhost:3000',
  'https://ta-01kbdmpk0e2bjyfzym639j663v-5173.wo-tal2sab99o2fihwqy0q42txk2.w.modal.host',
  'https://ta-01kbe334re2jwh46v0ck7y2gj6-5173.wo-fg8v2hmvq5sdzfghiamr6fed6.w.modal.host',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

// ====== MEMORY DB ======
const userPortfolios = {};      // userId -> { stocks: { SYMBOL: { shares, entryPrice, ... } }, alpacaKeys, userEmail, totalInvestment, maxLossPercent }
const userPrices = {};          // userId -> { SYMBOL: { price, time } }
const priceHistory15Min = {};   // userId -> { SYMBOL: { price, time } }
const sseClients = {};          // userId -> [res,...]
const userPushSubs = {};        // userId -> pushSubscription
const seenFinnhubEvents = {};   // ticker -> { eventId: timestamp }

// added helpers state
// per-symbol last portfolio risk calc timestamps are stored on portfolio.stocks[symbol].lastRiskAt
// per-user last portfolio recalc timestamp
const userLastPortfolioRecalcAt = {}; // userId -> timestamp

// ====== Finnhub WS with safe reconnect/backoff & subscribe limit ======
let finnhubSocket = null;
let subscribedTickers = new Set();
let reconnectDelayMs = 10_000;
const RECONNECT_MAX_MS = 60_000;
const FINNHUB_FREE_TICKER_LIMIT = 30;

function connectFinnhubStream() {
  if (!FINNHUB_KEY) { log.warn('⚠️ No FINNHUB_API_KEY — skipping live price stream'); return; }
  if (finnhubSocket && (finnhubSocket.readyState === WebSocket.OPEN || finnhubSocket.readyState === WebSocket.CONNECTING)) {
    log.info('🟢 Finnhub WebSocket already open/connecting — skipping new connect.');
    return;
  }

  try {
    finnhubSocket = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

    finnhubSocket.on('open', () => {
      log.info('📡 Connected to Finnhub live price stream');
      reconnectDelayMs = 10_000;
      for (const symbol of subscribedTickers) {
        try { finnhubSocket.send(JSON.stringify({ type: 'subscribe', symbol })); } catch (e) { log.error('subscribe failed', e.message); }
      }
    });

    finnhubSocket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.type === 'trade' && Array.isArray(data.data)) {
          data.data.forEach(t => {
            const { s: symbol, p: price } = t;
            if (!symbol) return;
            // update all portfolios that watch this symbol — same behavior as the old code
            for (const userId in userPortfolios) {
              const portfolio = userPortfolios[userId];
              if (!portfolio || !portfolio.stocks) continue;
              if (portfolio.stocks[symbol]) {
                // save per-user price cache
                if (!userPrices[userId]) userPrices[userId] = {};
                userPrices[userId][symbol] = { price, time: Date.now() };

                // also update portfolio lastPrice
                portfolio.stocks[symbol].lastPrice = price;

                // SSE price only (no automatic risk calc here)
                try {
                  pushUpdate(userId, {
                    stockTicker: symbol,
                    price,
                    stopLoss: portfolio.stocks[symbol].stopLoss || null,
                    risk: portfolio.stocks[symbol].overallRisk ?? portfolio.stocks[symbol].risk ?? null
                  });
                } catch (e) { /* ignore */ }

                pushUpdate(userId, { type: 'price', symbol, price });
              }
            }
          });
        }
      } catch (err) {
        log.error('⚠️ Finnhub stream parse error', err.message);
      }
    });

    finnhubSocket.on('close', (code, reason) => {
      log.warn('🔌 Finnhub WebSocket closed — reconnecting in a bit...', code, reason?.toString?.() || reason);
      setTimeout(() => { reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2); connectFinnhubStream(); }, reconnectDelayMs);
    });

    finnhubSocket.on('error', (err) => {
      log.error('❌ Finnhub WS error:', err?.message || err);
      try { finnhubSocket.close(); } catch (e) {}
    });
  } catch (err) {
    log.error('Failed to create Finnhub WebSocket', err.message);
    setTimeout(connectFinnhubStream, reconnectDelayMs);
    reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
  }
}

function subscribeToLiveTicker(symbol) {
  if (!symbol || !FINNHUB_KEY) return;
  if (subscribedTickers.has(symbol)) return;
  if (subscribedTickers.size >= FINNHUB_FREE_TICKER_LIMIT) {
    log.warn(`⚠️ Skipping live subscribe for ${symbol} — reached safe limit (${FINNHUB_FREE_TICKER_LIMIT})`);
    return;
  }
  subscribedTickers.add(symbol);
  if (finnhubSocket && finnhubSocket.readyState === WebSocket.OPEN) {
    try { finnhubSocket.send(JSON.stringify({ type: 'subscribe', symbol })); log.info(`🔔 Subscribed to live ticker ${symbol}`); } catch (e) { log.error('Failed to send subscribe message for', symbol, e.message); }
  }
}

// ====== GLOBAL PRICE CACHE (to avoid duplicate calls & rate limit) ======
const priceCache = {}; // symbol -> { price, ts, source }

const PRICE_CACHE_TTL_MS = 2000; // 2s TTL (adjustable)

async function fetchPriceFromProviders(symbol, preferAlpacaKeys = null) {
  // preferAlpacaKeys: { key, secret } or null
  // Try Alpaca if keys provided; on 429 or error -> fallback to Finnhub
  try {
    if (preferAlpacaKeys) {
      try {
        const p = await getAlpacaPrice(symbol, preferAlpacaKeys.key, preferAlpacaKeys.secret);
        return { price: p, source: 'alpaca' };
      } catch (alpErr) {
        // If rate-limit (429) or other error, log and fallback
        log.warn(`שגיאה בשליפת מחיר עבור ${symbol} מ-Alpaca: ${alpErr.message}`);
        if (alpErr.response && alpErr.response.status === 429) {
          log.warn(`Alpaca rate limit for ${symbol} — falling back to Finnhub`);
        }
        // continue to Finnhub fallback
      }
    }
    // Finnhub fallback
    try {
      const p2 = await getFinnhubPrice(symbol);
      return { price: p2, source: 'finnhub' };
    } catch (finErr) {
      log.error(`Finnhub price fetch failed for ${symbol}: ${finErr.message}`);
      throw finErr;
    }
  } catch (e) {
    throw e;
  }
}

async function getCachedPrice(symbol, preferAlpacaKeys = null) {
  const now = Date.now();
  const cached = priceCache[symbol];
  if (cached && (now - cached.ts) <= PRICE_CACHE_TTL_MS) {
    return { price: cached.price, source: cached.source, cached: true };
  }
  // fetch fresh
  const res = await fetchPriceFromProviders(symbol, preferAlpacaKeys);
  priceCache[symbol] = { price: res.price, ts: now, source: res.source };
  return { price: res.price, source: res.source, cached: false };
}

connectFinnhubStream();

// ====== SSE helpers ======
function pushUpdate(userId, data) {
  if (!sseClients[userId]) return;
  sseClients[userId].forEach(res => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  });
  // light-weight log for debugging — throttle repetitive identical messages
  tryThrottleLog(userId, data);
}

function tryThrottleLog(userId, data) {
  // simple throttled logging: only log detailed payloads at most once per LOG_THROTTLE_MS per user
  const now = Date.now();
  userLastLog = userLastLogMap[userId] || { ts: 0, last: null };
  if (!userLastLogMap[userId]) userLastLogMap[userId] = userLastLog;
  // we log only the type and symbol (if present) to avoid huge noise
  if (!userLastLog.ts || (now - userLastLog.ts) > LOG_THROTTLE_MS) {
    userLastLog.ts = now;
    userLastLog.last = data;
    log.info(`📡 נשלח עדכון SSE ל-${userId}:`, summarizeForLog(data));
  }
}

function summarizeForLog(data) {
  if (!data) return data;
  if (data.type === 'price') return { type: data.type, symbol: data.symbol, price: data.price };
  if (data.stockTicker) return { stockTicker: data.stockTicker, price: data.price, stopLoss: data.stopLoss, risk: data.risk };
  if (data.type === 'risk-update') return { type: data.type, symbol: data.symbol, risk: data.risk };
  if (data.type === 'finnhub-event') return { type: data.type, symbol: data.symbol, headline: data.event?.headline?.slice(0,80) };
  return data;
}

const userLastLogMap = {};

// keep SSE alive
setInterval(() => {
  for (const userId in sseClients) {
    sseClients[userId].forEach(res => {
      try { res.write(`data: ${JSON.stringify({ type: "ping", ts: Date.now() })}\n\n`); } catch (e) {}
    });
  }
}, 30_000);

// wrapper to allow recalculation for specific kind: 'alpaca' or 'manual'
async function recalcPortfolioStopLossesForKind(userId, kind) {
  const up = userPortfolios[userId];
  if (!up) return;
  const portfolio = up[kind];
  if (!portfolio || !portfolio.stocks) return;
  // reuse existing recalc logic but expecting portfolio shape like before
  return recalcPortfolioStopLossesGeneric(userId, portfolio);
}

// extract original logic into a generic that accepts portfolio object
async function recalcPortfolioStopLossesGeneric(userId, portfolio) {
  // same code as your previous recalcPortfolioStopLosses but WITHOUT reading userPortfolios[userId] directly.
  // For brevity in this message I'll assume we copy the body of recalcPortfolioStopLosses but reading 'portfolio' param.
  // Replace your recalcPortfolioStopLosses with the content below (copy/paste from your original recalc but use `portfolio`).
  // --- BEGIN (paste your recalc function body here, replacing references to userPortfolios[userId] with 'portfolio') ---
  const symbols = Object.keys(portfolio.stocks);
  if (symbols.length === 0) return;

  const prices = {};
  for (const symbol of symbols) {
    const s = portfolio.stocks[symbol];
    if (s && typeof s.lastPrice === 'number') { prices[symbol] = s.lastPrice; continue; }
    try {
      // if portfolio has alpacaKeys use them; else no prefer
      const prefer = portfolio.alpacaKeys ? portfolio.alpacaKeys : null;
      const cached = await getCachedPrice(symbol, prefer);
      prices[symbol] = cached.price;
    } catch (e) {
      log.error('price fetch failed for', symbol, e.message);
      prices[symbol] = null;
    }
  }

  let portfolioValue = 0;
  const posValues = {};
  for (const symbol of symbols) {
    const s = portfolio.stocks[symbol];
    const shares = Number(s.shares || s.quantity || 0);
    const entry = Number(s.entryPrice || s.entry_price || 0);
    const current = Number(prices[symbol] || entry || 0);
    const pv = shares * current;
    posValues[symbol] = { shares, entryPrice: entry || current, currentPrice: current, positionValue: pv };
    portfolioValue += pv;
  }
  if (portfolioValue <= 0) return;

  const riskScores = {};
  let sumRisk = 0;
  for (const symbol of symbols) {
    const s = portfolio.stocks[symbol];
    const r = Number(s.overallRisk) || Number(s.risk) || 0;
    riskScores[symbol] = r;
    sumRisk += r;
  }

  const weights = {};
  if (sumRisk <= 0) {
    const equal = 1 / symbols.length;
    for (const symbol of symbols) weights[symbol] = equal;
  } else {
    for (const symbol of symbols) weights[symbol] = riskScores[symbol] / sumRisk;
  }

  const maxLossPercent = Number(portfolio.maxLossPercent ?? portfolio.totalMaxLossPercent ?? 0);
  const totalAllowedLossAmount = portfolioValue * (maxLossPercent / 100);

  const updates = {};
  for (const symbol of symbols) {
    const pv = posValues[symbol].positionValue;
    const entry = posValues[symbol].entryPrice || posValues[symbol].currentPrice;
    const shares = posValues[symbol].shares;
    const allocatedLoss = totalAllowedLossAmount * weights[symbol];
    let allowedFrac = pv > 0 ? allocatedLoss / pv : 0;
    if (!isFinite(allowedFrac) || allowedFrac < 0) allowedFrac = 0;
    let stopPrice = entry * (1 - allowedFrac);
    if (stopPrice < 0) stopPrice = 0;
    updates[symbol] = { stopPrice: Number(stopPrice.toFixed(4)), allocatedLoss: Number(allocatedLoss.toFixed(2)), weight: weights[symbol] };
  }

  for (const symbol of symbols) {
    const prev = portfolio.stocks[symbol].stopLoss ?? null;
    const newStop = updates[symbol].stopPrice;
    if (prev === null || Math.abs(prev - newStop) > 0.01) {
      portfolio.stocks[symbol].stopLoss = newStop;
      pushUpdate(userId, { type: 'stoploss-updated', symbol, newStop, allocatedLoss: updates[symbol].allocatedLoss, weight: updates[symbol].weight });

      // send push/mail only for real portfolios with user subscription/email
      try {
        const upMeta = userPortfolios[userId];
        if (upMeta && userPushSubs[userId]) {
          await sendPushNotification(userPushSubs[userId], {
            title: `עדכון סטופ לוס – ${symbol}`,
            body: `סטופ לוס חדש נקבע על $${newStop} (מחשוב תחשיבי)`,
            icon: '/icons/stoploss.png'
          });
          log.info(`📲 נשלחה התראת Push עדכון סטופ לוס ל-${userId} עבור ${symbol}`);
        }
      } catch (pushErr) { log.error('Push error sending stoploss update', pushErr.message); }

      if (userPortfolios[userId] && userPortfolios[userId].userEmail) {
        try { await sendEmail({ to: userPortfolios[userId].userEmail, subject: `עדכון סטופ לוס - ${symbol}`, html: `<p>סטופ לוס חדש ל-${symbol}: <b>$${newStop}</b></p><p>משקל סיכון יחסי: ${Math.round(updates[symbol].weight * 100)}%</p>` }); log.info(`📧 נשלח מייל עדכון סטופ לוס עבור ${symbol} (${userId})`); } catch (mailErr) { log.error('Mail error on stoploss update', mailErr.message); }
      }
    }
  }
  // --- END generic recalc ---
}

// ====== Risk wrapper (uses analyzeStockRisk) ======
// Add "force" and "reason" so callers can decide when to bypass cooldowns.
async function calculateFullRisk(userId, symbol, currentPrice, portfolio, { force = false, reason = '' } = {}) {
  try {
    if (!portfolio || !portfolio.stocks || !portfolio.stocks[symbol]) return null;

    const now = Date.now();
    const s = portfolio.stocks[symbol];
    s.lastRiskAt = s.lastRiskAt || 0;

    if (!force && (now - s.lastRiskAt) < MIN_RISK_INTERVAL_MS) {
      // skip recalculation to avoid spam
      log.info && log.info(`⏱️ Skipping risk calc for ${symbol} (cooldown). reason=${reason}`);
      return null;
    }

    // mark when we started (prevents bursts from other callers)
    s.lastRiskAt = now;

    const analysis = await analyzeStockRisk(symbol, currentPrice);
    const overallRiskScore = analysis?.overallRiskScore ?? analysis?.riskScore ?? null;

    portfolio.stocks[symbol].overallRisk = overallRiskScore;
    portfolio.stocks[symbol].beta = analysis.beta ?? portfolio.stocks[symbol].beta;
    portfolio.stocks[symbol].volatility = analysis.volatility ?? portfolio.stocks[symbol].volatility;
    portfolio.stocks[symbol].sentiment = analysis.sentiment ?? portfolio.stocks[symbol].sentiment;
    portfolio.stocks[symbol].earningsImpact = analysis.earningsImpact ?? portfolio.stocks[symbol].earningsImpact;
    portfolio.stocks[symbol].analysis = analysis;

    // throttle repetitive risk logs per symbol
    const lastLogged = portfolio.stocks[symbol].lastLoggedRiskAt || 0;
    if ((Date.now() - lastLogged) > LOG_THROTTLE_MS) {
      portfolio.stocks[symbol].lastLoggedRiskAt = Date.now();
      log.info(`📊 ${symbol} סיכון כולל: ${overallRiskScore}/10 | β=${analysis.beta} σ=${analysis.volatility}`);
    }

    pushUpdate(userId, { type: 'risk-update', symbol, risk: overallRiskScore, details: analysis });
    return { overallRiskScore, analysis };
  } catch (e) { log.error(`❌ שגיאה בחישוב סיכון עבור ${symbol}: ${e.message}`); return null; }
}

// deprecated fallback (kept for compatibility)
async function updateStopLossAndNotify(userId, symbol, portfolio, currentPrice, overallRiskScore) {
  try {
    const oldStopLoss = portfolio.stocks[symbol].stopLoss || 0;
    const newStopLoss = Number((currentPrice * (1 - (overallRiskScore / 100))).toFixed(2));
    if (Math.abs(newStopLoss - oldStopLoss) > 0.01) {
      portfolio.stocks[symbol].stopLoss = newStopLoss;
      pushUpdate(userId, { type: 'stoploss-updated', symbol, newStopLoss, risk: overallRiskScore });
    }
  } catch (err) { log.error('updateStopLossAndNotify error', err.message); }
}

// ====== 15-min drop checker ======
async function checkFifteenMinuteDrop(userId, symbol, currentPrice, portfolio) {
  if (!priceHistory15Min[userId]) priceHistory15Min[userId] = {};
  const now = Date.now();
  const history = priceHistory15Min[userId][symbol];

  if (history && (now - history.time) <= 15 * 60 * 1000) {
    const change = ((currentPrice - history.price) / history.price) * 100;
    if (change <= -5) {
      log.warn(`📉 ירידה ${change.toFixed(2)}% ב-15 דק' עבור ${symbol} (${userId})`);
      // treat as important trigger => force a risk calc (but still respect MIN_RISK_INTERVAL_MS to avoid loops)
      const res = await calculateFullRisk(userId, symbol, currentPrice, portfolio, { force: true, reason: '15min-drop' });
      if (res) await updateStopLossAndNotify(userId, symbol, portfolio, currentPrice, res.overallRiskScore);
      if (userPushSubs[userId]) {
        try { await sendPushNotification(userPushSubs[userId], { title: `📉 ירידה חדה: ${symbol}`, body: `${symbol} ירדה ${change.toFixed(2)}% ב-15 הדקות האחרונות.`, icon: '/icons/drop.png' }); log.info(`📲 נשלחה התראת Push ירידה חדה ל-${userId}`); } catch (e) { log.error('Push error pada 15min drop', e.message); }
      }
      pushUpdate(userId, { type: '15min-drop', symbol, changePercent: change, price: currentPrice });
    }
  }
  priceHistory15Min[userId][symbol] = { price: currentPrice, time: now };
}

async function checkAndUpdatePrices() {
  // Build a global map symbol -> list of contexts needing this symbol
  const symbolContexts = {}; // symbol -> [ { userId, kind: 'alpaca'|'manual', portfolioRef, preferAlpacaKeys } ]

  for (const userId in userPortfolios) {
    const up = userPortfolios[userId];
    if (!up) continue;
    // manual
    if (up.manual && up.manual.stocks) {
      for (const sym in up.manual.stocks) {
        symbolContexts[sym] = symbolContexts[sym] || [];
        symbolContexts[sym].push({ userId, kind: 'manual', portfolioRef: up.manual, preferAlpacaKeys: null });
      }
    }
    // alpaca
    if (up.alpaca && up.alpaca.stocks) {
      for (const sym in up.alpaca.stocks) {
        symbolContexts[sym] = symbolContexts[sym] || [];
        symbolContexts[sym].push({ userId, kind: 'alpaca', portfolioRef: up.alpaca, preferAlpacaKeys: up.alpaca.alpacaKeys });
      }
    }
  }

  // For each symbol fetch price once (prefer Alpaca if any context requested it)
  for (const symbol of Object.keys(symbolContexts)) {
    try {
      // decide preferAlpacaKeys if any context has alpaca preference (choose first)
      const prefer = symbolContexts[symbol].find(c => c.preferAlpacaKeys)?.preferAlpacaKeys ?? null;
      const { price, source } = await getCachedPrice(symbol, prefer);
      // Now update each context that requested this symbol
      for (const ctx of symbolContexts[symbol]) {
        const { userId, portfolioRef, kind } = ctx;
        // save per-user price cache (old code used userPrices)
        if (!userPrices[userId]) userPrices[userId] = {};
        userPrices[userId][symbol] = { price, time: Date.now() };

        // update portfolio object
        portfolioRef.stocks[symbol].lastPrice = price;

        // SSE: send price update
        pushUpdate(userId, {
          stockTicker: symbol,
          price,
          stopLoss: portfolioRef.stocks[symbol].stopLoss || null,
          risk: portfolioRef.stocks[symbol].overallRisk || portfolioRef.stocks[symbol].risk || null
        });
        pushUpdate(userId, { type: 'price', symbol, price });

        // 15min drop check (pass the right portfolio)
        await checkFifteenMinuteDrop(userId, symbol, price, portfolioRef);

        // decide if compute risk: only if price change >=1% against lastPrice for this user
        const lastPrice = userPrices[userId][symbol]?.price;
        const changePercent = lastPrice ? Math.abs((price - lastPrice) / lastPrice) * 100 : Infinity;
        if (changePercent >= 1 || !portfolioRef.stocks[symbol].overallRisk) {
          const res = await calculateFullRisk(userId, symbol, price, portfolioRef);
          if (res) await updateStopLossAndNotify(userId, symbol, portfolioRef, price, res.overallRiskScore);
        }
      }
    } catch (err) {
      log.error(`❌ שגיאה בעדכון ${symbol}: ${err.message}`);
      // do not spam: continue
    }
  }

  // after all symbols — recalc stoplosses for each user's portfolios separately
  for (const userId in userPortfolios) {
    try {
      if (userPortfolios[userId].manual) await recalcPortfolioStopLossesForKind(userId, 'manual');
      if (userPortfolios[userId].alpaca) await recalcPortfolioStopLossesForKind(userId, 'alpaca');
    } catch (e) { log.error('recalcPortfolioStopLosses error', e.message); }
  }
}

// ====== Finnhub event polling (news + earnings) ======
async function fetchCompanyNews(symbol, fromISO, toISO) {
  if (!FINNHUB_KEY) return [];
  try {
    const url = 'https://finnhub.io/api/v1/company-news';
    const res = await axios.get(url, { params: { symbol, from: fromISO, to: toISO, token: FINNHUB_KEY }, timeout: 10000 });
    return res.data || [];
  } catch (err) { log.error('fetchCompanyNews error', symbol, err.message); return []; }
}

async function fetchEarnings(symbol) {
  if (!FINNHUB_KEY) return [];
  try { const url = 'https://finnhub.io/api/v1/stock/earnings'; const res = await axios.get(url, { params: { symbol, token: FINNHUB_KEY }, timeout: 10000 }); return res.data || []; } catch (err) { log.error('fetchEarnings error', symbol, err.message); return []; }
}

async function handleEventForTicker(symbol, event) {
  const eventId = event.id || event.gid || `${symbol}::${event.headline || event.category || event.datetime || event.date || Math.random()}`;
  const now = Date.now();
  seenFinnhubEvents[symbol] = seenFinnhubEvents[symbol] || {};
  if (seenFinnhubEvents[symbol][eventId] && (now - seenFinnhubEvents[symbol][eventId] < 24*60*60*1000)) return;
  seenFinnhubEvents[symbol][eventId] = now;

  log.info(`🛰️ אירוע חדש ל-${symbol}:`, event.headline || event.summary || event.type || event);

  for (const userId in userPortfolios) {
    const p = userPortfolios[userId];
    if (!p.stocks || !p.stocks[symbol]) continue;
    try {
      // event-driven risk calcs: limit to one per SYMBOL per EVENT_RISK_COOLDOWN_MS
      const lastRisk = p.stocks[symbol].lastRiskAt || 0;
      if ((now - lastRisk) < EVENT_RISK_COOLDOWN_MS) {
        log.info(`⏱️ Skipping event-driven risk for ${symbol} (cooldown). headline=${event.headline?.slice(0,80)}`);
        pushUpdate(userId, { type: 'finnhub-event', symbol, event, risk: p.stocks[symbol].overallRisk });
        continue;
      }

      const price = p.alpacaKeys ? await getAlpacaPrice(symbol, p.alpacaKeys.key, p.alpacaKeys.secret) : await getFinnhubPrice(symbol);
      const res = await calculateFullRisk(userId, symbol, price, p, { force: true, reason: 'finnhub-event' });
      if (res) {
        // notify (push + mail) but keep notifications deduped by seenFinnhubEvents and handled cooldowns
        if (userPushSubs[userId]) {
          try { await sendPushNotification(userPushSubs[userId], { title: `חדשות ל־${symbol}`, body: `${event.headline || 'אירוע משמעותי'} — הסיכון עכשיו: ${res.overallRiskScore}/10`, icon: '/icons/news.png', data: { symbol, event } }); } catch (pushErr) { log.error('Push error on event notify', pushErr.message); }
        }
        if (p.userEmail) { try { await sendEmail({ to: p.userEmail, subject: `אירוע חשוב ב־${symbol}: ${event.headline || 'אירוע'}`, html: `<h3>אירוע ב־${symbol}</h3><p>${event.headline || event.summary || JSON.stringify(event)}</p><p>רמת סיכון עכשווית: ${res.overallRiskScore}/10</p>` }); } catch (mailErr) { log.error('Mail error on event notify', mailErr.message); } }
        pushUpdate(userId, { type: 'finnhub-event', symbol, event, risk: res.overallRiskScore });
      }
    } catch (err) { log.error('handleEventForTicker error', err.message); }
  }
}

const FINNHUB_POLL_MINUTES = Number(process.env.FINNHUB_POLL_MINUTES || 5);
async function pollFinnhubEvents() {
  if (!FINNHUB_KEY) return;
  try {
    const tickersSet = new Set();
    for (const uid in userPortfolios) { const p = userPortfolios[uid]; if (!p.stocks) continue; for (const s in p.stocks) tickersSet.add(s); }
    const tickers = Array.from(tickersSet);
    if (tickers.length === 0) return;
    const toISO = dayjs().format('YYYY-MM-DD');
    const fromISO = dayjs().subtract(1,'day').format('YYYY-MM-DD');
    for (const symbol of tickers) {
      try {
        const news = await fetchCompanyNews(symbol, fromISO, toISO);
        for (const item of news) await handleEventForTicker(symbol, item);
        const earnings = await fetchEarnings(symbol);
        if (Array.isArray(earnings) && earnings.length > 0) for (const e of earnings) await handleEventForTicker(symbol, e);
      } catch (err) { log.error('pollFinnhubEvents per-ticker error', symbol, err.message); }
    }
  } catch (err) { log.error('pollFinnhubEvents error', err.message); }
}

setInterval(pollFinnhubEvents, FINNHUB_POLL_MINUTES * 60_000);
pollFinnhubEvents().catch(err => log.error('initial poll error', err.message));

// ====== HTTP Routes ======
app.get('/', (req, res) => res.send('✅ RiskWise AI Server Online (Events + Push)'));

// update-portfolio (supports both manual and alpaca portfolios for same user)
app.post('/update-portfolio', (req, res) => {
  log.info('🌐 POST /update-portfolio', JSON.stringify(req.body));
  const { userId, stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment, maxLossPercent, type } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  // initialize user entry if needed
  if (!userPortfolios[userId]) userPortfolios[userId] = { manual: null, alpaca: null, userEmail: null, portfolioRiskLevel: null, totalInvestment: null, maxLossPercent: null };

  // Save common meta
  if (userEmail) userPortfolios[userId].userEmail = userEmail;
  if (typeof portfolioRiskLevel !== 'undefined') userPortfolios[userId].portfolioRiskLevel = portfolioRiskLevel;
  if (typeof totalInvestment !== 'undefined') userPortfolios[userId].totalInvestment = totalInvestment;
  if (typeof maxLossPercent !== 'undefined') userPortfolios[userId].maxLossPercent = maxLossPercent;

  // Decide where to put stocks: if alpacaKeys present -> alpaca, otherwise manual.
  if (alpacaKeys) {
    userPortfolios[userId].alpaca = { stocks: stocks || {}, alpacaKeys };
    log.info(`🔁 Alpaca portfolio updated for ${userId}:`, Object.keys(stocks || {}));
    Object.keys(stocks || {}).forEach(symbol => subscribeToLiveTicker(symbol));
  } else if (stocks) {
    userPortfolios[userId].manual = { stocks };
    log.info(`🔁 Manual portfolio updated for ${userId}:`, Object.keys(stocks || {}));
    Object.keys(stocks || {}).forEach(symbol => subscribeToLiveTicker(symbol));
  } else {
    // If called to clear one of them, allow payload type to indicate (optional)
    if (type === 'clear-alpaca') userPortfolios[userId].alpaca = null;
    if (type === 'clear-manual') userPortfolios[userId].manual = null;
  }

  // ensure price cache holder per user
  if (!userPrices[userId]) userPrices[userId] = {};

  // recalc stoplosses for both portfolios async
  if (userPortfolios[userId].alpaca) recalcPortfolioStopLossesForKind(userId, 'alpaca').catch(err => log.error('initial recalc alpaca', err.message));
  if (userPortfolios[userId].manual) recalcPortfolioStopLossesForKind(userId, 'manual').catch(err => log.error('initial recalc manual', err.message));

  res.json({ message: 'Portfolio updated' });
});

// fetch portfolio
app.get('/portfolio/:userId', (req, res) => {
  const userId = req.params.userId;
  log.info('🔍 GET /portfolio', userId);
  const portfolio = userPortfolios[userId];
  if (!portfolio) return res.status(404).json({ error: 'Not found' });
  res.json(portfolio);
});

// push subscribe
app.post('/subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  if (!userId || !subscription) return res.status(400).json({ error: 'Missing userId or subscription' });
  userPushSubs[userId] = subscription;
  log.info(`🔔 משתמש ${userId} נרשם להתראות Push`);
  res.json({ message: 'Subscribed successfully for push notifications' });
});

// SSE
app.get('/events/:userId', (req, res) => {
  const userId = req.params.userId;
  log.info('📡 SSE connect', userId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  if (!sseClients[userId]) sseClients[userId] = [];
  sseClients[userId].push(res);
  req.on('close', () => {
    log.warn('❌ SSE closed for', userId);
    sseClients[userId] = sseClients[userId].filter(r => r !== res);
  });
});

// risk endpoints (unchanged)
app.get('/risk/:ticker', async (req, res) => {
  const ticker = (req.params.ticker || '').toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try { const analysis = await analyzeStockRisk(ticker); const overallRiskScore = analysis?.overallRiskScore ?? analysis?.riskScore ?? null; res.json({ ticker, risk: overallRiskScore, analysis }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/risk/bulk', async (req, res) => {
  const tickers = req.body.tickers || [];
  if (!Array.isArray(tickers) || tickers.length === 0) return res.status(400).json({ error: 'tickers required' });
  try { const promises = tickers.map(t => analyzeStockRisk(t)); const results = await Promise.all(promises); const mapped = tickers.map((t,i) => ({ ticker: t.toUpperCase(), risk: results[i]?.overallRiskScore ?? results[i]?.riskScore ?? null, analysis: results[i] })); res.json({ results: mapped }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/webhook/event', async (req, res) => {
  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  // clear seen events for this ticker so webhook can force reprocessing if needed
  seenFinnhubEvents[ticker] = {};
  for (const userId in userPortfolios) {
    const p = userPortfolios[userId];
    if (p.stocks && p.stocks[ticker]) {
      try {
        const price = p.alpacaKeys ? await getAlpacaPrice(ticker, p.alpacaKeys.key, p.alpacaKeys.secret) : await getFinnhubPrice(ticker);
        const resCalc = await calculateFullRisk(userId, ticker, price, p, { force: true, reason: 'webhook' });
        if (resCalc) { await updateStopLossAndNotify(userId, ticker, p, price, resCalc.overallRiskScore); pushUpdate(userId, { type: 'webhook-recalc', ticker, price, risk: resCalc.overallRiskScore }); }
      } catch (err) { log.error('Webhook recalculation error for', ticker, err.message); }
    }
  }
  res.json({ ok: true });
});

// Start server + loop
app.listen(PORT, () => {
  log.info(`✅ Server started on port ${PORT}`);
  setInterval(checkAndUpdatePrices, 60 * 1000);
  checkAndUpdatePrices().catch(e => log.error('initial price check error', e.message));
});

// weekly cron
cron.schedule('0 14 * * 5', async () => {
  try { log.info('Weekly scheduled run: checkAndUpdatePrices'); await checkAndUpdatePrices(); await pollFinnhubEvents(); } catch (e) { log.error('Scheduled job error', e.message); }
});

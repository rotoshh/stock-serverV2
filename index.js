// ===========================================
// index.js – RiskWise AI Server (Push + Event Polling + Finnhub WS)
// ===========================================
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
const { sendPushNotification } = require('./pushServices'); // פונקציה ששולחת push דרך web-push
const log = console;

const app = express();
const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';

// safety: minimal config
if (!FINNHUB_KEY) log.warn('WARNING: FINNHUB_API_KEY not set — event polling and news will not work.');

// ---- CORS ----
const allowedOrigins = [
  'https://preview--risk-wise-396ab87e.base44.app',
  'http://localhost:3000',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

// ====== MEMORY DB ======
const userPortfolios = {};      // userId -> { stocks: { SYMBOL: {...} }, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment }
const priceHistory15Min = {};   // userId -> { SYMBOL: { price, time } }
const sseClients = {};          // userId -> [res, ...]
const userPushSubs = {};        // userId -> pushSubscription
const seenFinnhubEvents = {};   // ticker -> { eventId: timestamp } to avoid duplicate notifications

// ====== Finnhub WebSocket (real-time) with safe reconnect/backoff ======
let finnhubSocket = null;
let subscribedTickers = new Set();
let reconnectDelayMs = 10_000; // start 10s, exponential backoff up to cap
const RECONNECT_MAX_MS = 60_000; // max 60s
const FINNHUB_FREE_TICKER_LIMIT = 30; // safe default for free plan

function connectFinnhubStream() {
  if (!FINNHUB_KEY) {
    log.warn('⚠️ No FINNHUB_API_KEY — skipping live price stream');
    return;
  }

  // avoid opening duplicate sockets
  if (finnhubSocket && (finnhubSocket.readyState === WebSocket.OPEN || finnhubSocket.readyState === WebSocket.CONNECTING)) {
    log.info('🟢 Finnhub WebSocket already open/connecting — skipping new connect.');
    return;
  }

  try {
    finnhubSocket = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

    finnhubSocket.on('open', () => {
      log.info('📡 Connected to Finnhub live price stream');
      // reset backoff
      reconnectDelayMs = 10_000;
      // subscribe existing tickers
      for (const symbol of subscribedTickers) {
        try {
          finnhubSocket.send(JSON.stringify({ type: 'subscribe', symbol }));
        } catch (e) {
          log.error('Failed to subscribe to', symbol, e.message);
        }
      }
    });

    finnhubSocket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        // Finnhub trade messages: { type: 'trade', data: [ { s: 'AAPL', p: 123.45, ... }, ... ] }
        if (data.type === 'trade' && Array.isArray(data.data)) {
          data.data.forEach(t => {
            const { s: symbol, p: price } = t;
            if (!symbol) return;
            // broadcast to users who watch this symbol
            for (const userId in userPortfolios) {
              const portfolio = userPortfolios[userId];
              if (!portfolio || !portfolio.stocks) continue;
              if (portfolio.stocks[symbol]) {
                portfolio.stocks[symbol].lastPrice = price;
                // quick price SSE (type 'price')
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
      // schedule reconnect with backoff
      setTimeout(() => {
        reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
        connectFinnhubStream();
      }, reconnectDelayMs);
    });

    finnhubSocket.on('error', (err) => {
      // often 429 or network-related
      log.error('❌ Finnhub WS error:', err?.message || err);
      try {
        finnhubSocket.close();
      } catch (e) {}
    });
  } catch (err) {
    log.error('Failed to create Finnhub WebSocket', err.message);
    setTimeout(connectFinnhubStream, reconnectDelayMs);
    reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
  }
}

// subscribe helper - enforces a limit for free tier
function subscribeToLiveTicker(symbol) {
  if (!symbol || !FINNHUB_KEY) return;
  if (subscribedTickers.has(symbol)) return;

  // enforce safe limit for free tier to avoid 429
  if (subscribedTickers.size >= FINNHUB_FREE_TICKER_LIMIT) {
    log.warn(`⚠️ Skipping live subscribe for ${symbol} — reached safe limit (${FINNHUB_FREE_TICKER_LIMIT})`);
    return;
  }

  subscribedTickers.add(symbol);
  if (finnhubSocket && finnhubSocket.readyState === WebSocket.OPEN) {
    try {
      finnhubSocket.send(JSON.stringify({ type: 'subscribe', symbol }));
      log.info(`🔔 Subscribed to live ticker ${symbol}`);
    } catch (e) {
      log.error('Failed to send subscribe message for', symbol, e.message);
    }
  }
}

// start websocket connection (if key present)
connectFinnhubStream();

// ====== SSE HELPERS ======
function pushUpdate(userId, data) {
  if (sseClients[userId]) {
    sseClients[userId].forEach(res => {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        // ignore write errors for closed clients
      }
    });
    log.info(`📡 נשלח עדכון SSE ל-${userId}:`, data);
  }
}

// keep SSE alive (ping every 30s)
setInterval(() => {
  for (const userId in sseClients) {
    sseClients[userId].forEach(res => {
      try { res.write(`data: ${JSON.stringify({ type: "ping", ts: Date.now() })}\n\n`); } catch (e) {}
    });
  }
}, 30_000);

// ====== Risk calculation wrapper ======
async function calculateFullRisk(userId, symbol, currentPrice, portfolio) {
  try {
    const analysis = await analyzeStockRisk(symbol, currentPrice);

    // normalize field names (support analyzeStockRisk returning riskScore or overallRiskScore)
    const overallRiskScore = analysis?.overallRiskScore ?? analysis?.riskScore ?? null;

    // update portfolio state
    portfolio.stocks[symbol].overallRisk = overallRiskScore;
    portfolio.stocks[symbol].beta = analysis.beta ?? portfolio.stocks[symbol].beta;
    portfolio.stocks[symbol].volatility = analysis.volatility ?? portfolio.stocks[symbol].volatility;
    portfolio.stocks[symbol].sentiment = analysis.sentiment ?? portfolio.stocks[symbol].sentiment;
    portfolio.stocks[symbol].earningsImpact = analysis.earningsImpact ?? portfolio.stocks[symbol].earningsImpact;
    portfolio.stocks[symbol].analysis = analysis;

    // SSE
    pushUpdate(userId, {
      type: 'risk-update',
      symbol,
      risk: overallRiskScore,
      details: analysis
    });

    log.info(`📊 ${symbol} סיכון כולל: ${overallRiskScore}/10 | β=${analysis.beta} σ=${analysis.volatility}`);
    return { overallRiskScore, analysis };
  } catch (e) {
    log.error(`❌ שגיאה בחישוב סיכון עבור ${symbol}: ${e.message}`);
    return null;
  }
}

// ====== update stop-loss + notify (mail + push + sse) ======
async function updateStopLossAndNotify(userId, symbol, portfolio, currentPrice, overallRiskScore) {
  try {
    const oldStopLoss = portfolio.stocks[symbol].stopLoss || 0;
    // Example rule: stopLoss = currentPrice * (1 - overallRiskScore/100) — you can change this formula
    const newStopLoss = Number((currentPrice * (1 - (overallRiskScore / 100))).toFixed(2));

    if (Math.abs(newStopLoss - oldStopLoss) > 0.01) {
      portfolio.stocks[symbol].stopLoss = newStopLoss;

      const msg = `
        <h2>📉 עדכון סטופ לוס</h2>
        <p>המניה <strong>${symbol}</strong> עודכנה על ידי מערכת הסיכון.</p>
        <p>סטופ לוס חדש: <strong>$${newStopLoss}</strong></p>
        <p>רמת סיכון: ${overallRiskScore}</p>
      `;

      // send email
      if (portfolio.userEmail) {
        try {
          await sendEmail({ to: portfolio.userEmail, subject: `עדכון סטופ לוס - ${symbol}`, html: msg });
          log.info(`📧 נשלח מייל עדכון סטופ לוס עבור ${symbol} (${userId})`);
        } catch (mailErr) {
          log.error('שגיאה בשליחת אימייל:', mailErr.message);
        }
      }

      // SSE alert
      pushUpdate(userId, { type: 'stoploss-updated', symbol, newStopLoss, risk: overallRiskScore });

      // push notification
      if (userPushSubs[userId]) {
        try {
          await sendPushNotification(userPushSubs[userId], {
            title: `עדכון סטופ לוס – ${symbol}`,
            body: `סטופ לוס חדש נקבע על $${newStopLoss} (סיכון ${overallRiskScore}/10)`,
            icon: '/icons/stoploss.png'
          });
          log.info(`📲 נשלחה התראת Push עדכון סטופ לוס ל-${userId}`);
        } catch (pushErr) {
          log.error('שגיאה בשליחת Push:', pushErr.message);
        }
      }
    }
  } catch (err) {
    log.error('updateStopLossAndNotify error', err.message);
  }
}

// ====== Fifteen-minute drop checker ======
async function checkFifteenMinuteDrop(userId, symbol, currentPrice, portfolio) {
  if (!priceHistory15Min[userId]) priceHistory15Min[userId] = {};
  const now = Date.now();
  const history = priceHistory15Min[userId][symbol];

  if (history && (now - history.time) <= 15 * 60 * 1000) {
    const change = ((currentPrice - history.price) / history.price) * 100;
    if (change <= -5) {
      log.warn(`📉 ירידה ${change.toFixed(2)}% ב-15 דק' עבור ${symbol} (${userId})`);

      // recalc risk
      const res = await calculateFullRisk(userId, symbol, currentPrice, portfolio);
      if (res) {
        await updateStopLossAndNotify(userId, symbol, portfolio, currentPrice, res.overallRiskScore);
      }

      // push alert
      if (userPushSubs[userId]) {
        try {
          await sendPushNotification(userPushSubs[userId], {
            title: `📉 ירידה חדה: ${symbol}`,
            body: `${symbol} ירדה ${change.toFixed(2)}% ב-15 הדקות האחרונות.`,
            icon: '/icons/drop.png'
          });
          log.info(`📲 נשלחה התראת Push ירידה חדה ל-${userId}`);
        } catch (e) {
          log.error('שגיאת Push pada 15min drop', e.message);
        }
      }

      // SSE already sent by calculateFullRisk
      pushUpdate(userId, { type: '15min-drop', symbol, changePercent: change, price: currentPrice });
    }
  }
  priceHistory15Min[userId][symbol] = { price: currentPrice, time: now };
}

// ====== Price update loop ======
async function checkAndUpdatePrices() {
  for (const userId in userPortfolios) {
    const portfolio = userPortfolios[userId];
    if (!portfolio || !portfolio.stocks) continue;

    for (const symbol in portfolio.stocks) {
      try {
        const price = portfolio.alpacaKeys
          ? await getAlpacaPrice(symbol, portfolio.alpacaKeys.key, portfolio.alpacaKeys.secret)
          : await getFinnhubPrice(symbol);

        // quick SSE price update
        pushUpdate(userId, { type: 'price', symbol, price });

        // check 15min drop and react
        await checkFifteenMinuteDrop(userId, symbol, price, portfolio);

        // calculate advanced risk and update stoploss
        const res = await calculateFullRisk(userId, symbol, price, portfolio);
        if (res) await updateStopLossAndNotify(userId, symbol, portfolio, price, res.overallRiskScore);

      } catch (err) {
        log.error(`❌ שגיאה בעדכון ${symbol} (${userId}): ${err.message}`);
      }
    }
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
  try {
    const url = 'https://finnhub.io/api/v1/stock/earnings';
    const res = await axios.get(url, { params: { symbol, token: FINNHUB_KEY }, timeout: 10000 });
    return res.data || [];
  } catch (err) { log.error('fetchEarnings error', symbol, err.message); return []; }
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
      const price = p.alpacaKeys ? await getAlpacaPrice(symbol, p.alpacaKeys.key, p.alpacaKeys.secret) : await getFinnhubPrice(symbol);
      const res = await calculateFullRisk(userId, symbol, price, p);

      if (res) {
        // push notification for event
        if (userPushSubs[userId]) {
          try {
            await sendPushNotification(userPushSubs[userId], {
              title: `חדשות ל־${symbol}`,
              body: `${event.headline ? event.headline : 'אירוע משמעותי'} — הסיכון עכשיו: ${res.overallRiskScore}/10`,
              icon: '/icons/news.png',
              data: { symbol, event }
            });
            log.info(`📲 נשלחה Push על אירוע ל-${userId} עבור ${symbol}`);
          } catch (pushErr) {
            log.error('Push error on event notify', pushErr.message);
          }
        }

        // email summary (optional for big events)
        if (p.userEmail) {
          try {
            await sendEmail({
              to: p.userEmail,
              subject: `אירוע חשוב ב־${symbol}: ${event.headline ? event.headline : 'אירוע'}`,
              html: `<h3>אירוע ב־${symbol}</h3><p>${event.headline || event.summary || JSON.stringify(event)}</p><p>רמת סיכון עכשווית: ${res.overallRiskScore}/10</p>`
            });
            log.info(`📧 נשלח מייל אירוע ל-${userId} עבור ${symbol}`);
          } catch (mailErr) {
            log.error('Mail error on event notify', mailErr.message);
          }
        }

        // SSE event
        pushUpdate(userId, { type: 'finnhub-event', symbol, event, risk: res.overallRiskScore });
      }
    } catch (err) {
      log.error('handleEventForTicker error', err.message);
    }
  }
}

const FINNHUB_POLL_MINUTES = Number(process.env.FINNHUB_POLL_MINUTES || 5);
async function pollFinnhubEvents() {
  if (!FINNHUB_KEY) return;
  try {
    // gather unique tickers watched across users
    const tickersSet = new Set();
    for (const uid in userPortfolios) {
      const p = userPortfolios[uid];
      if (!p.stocks) continue;
      for (const s in p.stocks) tickersSet.add(s);
    }
    const tickers = Array.from(tickersSet);
    if (tickers.length === 0) return;

    const toISO = dayjs().format('YYYY-MM-DD');
    const fromISO = dayjs().subtract(1,'day').format('YYYY-MM-DD');

    for (const symbol of tickers) {
      try {
        // company news
        const news = await fetchCompanyNews(symbol, fromISO, toISO);
        for (const item of news) await handleEventForTicker(symbol, item);

        // earnings (latest quarter)
        const earnings = await fetchEarnings(symbol);
        if (Array.isArray(earnings) && earnings.length > 0) {
          for (const e of earnings) await handleEventForTicker(symbol, e);
        }
      } catch (err) { log.error('pollFinnhubEvents per-ticker error', symbol, err.message); }
    }
  } catch (err) { log.error('pollFinnhubEvents error', err.message); }
}

// schedule event polling
setInterval(pollFinnhubEvents, FINNHUB_POLL_MINUTES * 60_000);
pollFinnhubEvents().catch(err => log.error('initial poll error', err.message));

// ====== HTTP Routes ======
app.get('/', (req, res) => res.send('✅ RiskWise AI Server Online (Events + Push)'));

app.post('/update-portfolio', (req, res) => {
  const { userId, stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment } = req.body;
  if (!userId || !stocks) return res.status(400).json({ error: 'חסרים נתונים' });

  // sanitize/normalize stocks object shape expected by server:
  // stocks = { "AAPL": { sector: 'Technology', ... }, "TSLA": {...} }
  userPortfolios[userId] = { stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment };
  log.info(`🔁 Portfolio updated for ${userId}:`, Object.keys(stocks || {}));

  // subscribe to live tickers (respecting limit)
  Object.keys(stocks || {}).forEach(symbol => subscribeToLiveTicker(symbol));

  res.json({ message: 'Portfolio updated' });
});

app.post('/subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  if (!userId || !subscription) return res.status(400).json({ error: 'Missing userId or subscription' });
  userPushSubs[userId] = subscription;
  log.info(`🔔 משתמש ${userId} נרשם להתראות Push`);
  res.json({ message: 'Subscribed successfully for push notifications' });
});

app.get('/events/:userId', (req, res) => {
  const userId = req.params.userId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  if (!sseClients[userId]) sseClients[userId] = [];
  sseClients[userId].push(res);
  req.on('close', () => {
    sseClients[userId] = sseClients[userId].filter(r => r !== res);
  });
});

app.get('/risk/:ticker', async (req, res) => {
  const ticker = (req.params.ticker || '').toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    // no user context — call analyzer directly
    const analysis = await analyzeStockRisk(ticker);
    const overallRiskScore = analysis?.overallRiskScore ?? analysis?.riskScore ?? null;
    res.json({ ticker, risk: overallRiskScore, analysis });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/risk/bulk', async (req, res) => {
  const tickers = req.body.tickers || [];
  if (!Array.isArray(tickers) || tickers.length === 0) return res.status(400).json({ error: 'tickers required' });
  try {
    const promises = tickers.map(t => analyzeStockRisk(t));
    const results = await Promise.all(promises);
    const mapped = tickers.map((t, i) => ({ ticker: t.toUpperCase(), risk: results[i]?.overallRiskScore ?? results[i]?.riskScore ?? null, analysis: results[i] }));
    res.json({ results: mapped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// webhook endpoint to force recalculation
app.post('/webhook/event', async (req, res) => {
  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  // clear seen events for ticker to allow re-notify if desired
  seenFinnhubEvents[ticker] = {};

  // trigger recalculation for users watching ticker
  for (const userId in userPortfolios) {
    const p = userPortfolios[userId];
    if (p.stocks && p.stocks[ticker]) {
      try {
        const price = p.alpacaKeys ? await getAlpacaPrice(ticker, p.alpacaKeys.key, p.alpacaKeys.secret) : await getFinnhubPrice(ticker);
        const resCalc = await calculateFullRisk(userId, ticker, price, p);
        if (resCalc) {
          await updateStopLossAndNotify(userId, ticker, p, price, resCalc.overallRiskScore);
          pushUpdate(userId, { type: 'webhook-recalc', ticker, price, risk: resCalc.overallRiskScore });
        }
      } catch (err) {
        log.error('Webhook recalculation error for', ticker, err.message);
      }
    }
  }

  res.json({ ok: true });
});

// ====== Cron Weekly Risk Recalculation ======
cron.schedule('0 12 * * FRI', async () => {
  log.info('🔁 Cron: Weekly risk recalculation triggered');
  for (const userId in userPortfolios) {
    const portfolio = userPortfolios[userId];
    if (!portfolio || !portfolio.stocks) continue;
    for (const symbol in portfolio.stocks) {
      try {
        const price = portfolio.alpacaKeys ? await getAlpacaPrice(symbol, portfolio.alpacaKeys.key, portfolio.alpacaKeys.secret) : await getFinnhubPrice(symbol);
        const res = await calculateFullRisk(userId, symbol, price, portfolio);
        if (res) await updateStopLossAndNotify(userId, symbol, portfolio, price, res.overallRiskScore);
      } catch (e) {
        log.error('Weekly cron error for', symbol, e.message);
      }
    }
  }
});

// ====== Start server + polling loop ======
app.listen(PORT, () => {
  log.info(`✅ Server started on port ${PORT}`);
  // Run price-check every minute
  setInterval(checkAndUpdatePrices, 60 * 1000);
  // initial run
  checkAndUpdatePrices().catch(e => log.error('initial price check error', e.message));
});

// Weekly cron example (Friday 14:00)
cron.schedule('0 14 * * 5', async () => {
  try {
    log.info('Weekly scheduled run: checkAndUpdatePrices');
    await checkAndUpdatePrices();
    await pollFinnhubEvents();
  } catch (e) {
    log.error('Scheduled job error', e.message);
  }
});

// riskAnalyzer.js
// CommonJS module - analyzeStockRisk(symbol, currentPrice)
// Uses Finnhub as data source (requires FINNHUB_API_KEY in env)

const axios = require('axios');
const NodeCache = require('node-cache');
const regression = require('regression');
const dayjs = require('dayjs');

const cache = new NodeCache({ stdTTL: 60 * 10 }); // 10 minutes cache
const FINNHUB_API = 'https://finnhub.io/api/v1';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';

const WINDOWS = { short: 7, medium: 30, long: 90 };

// Weights for the composite score (can be tuned)
const WEIGHTS = {
  beta: 0.10,
  volatility: 0.10,
  sharpe: 0.05,
  drawdown: 0.05,
  volumeVol: 0.05,
  debtToEquity: 0.05,
  interestCoverage: 0.05,
  fcfStability: 0.05,
  earningsVariability: 0.05,
  relativeStrength: 0.05,
  eventRisk: 0.10,
  vix: 0.03,
  sectorVolatility: 0.03,
  sentiment: 0.04
};

// ---------- Helpers ----------
function normalize(value, min = 0, max = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return 0.5;
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

function computeReturnsFromCloses(closes, timestamps) {
  // returns array of {date, ret}
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const r = (closes[i] - closes[i - 1]) / closes[i - 1];
    out.push({ date: dayjs.unix(timestamps[i]).format('YYYY-MM-DD'), ret: r });
  }
  return out;
}

function annualizedVolatilityFromReturns(returns) {
  if (!returns || returns.length < 2) return 0;
  const vals = returns.map(r => r.ret);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (vals.length - 1);
  const dailyStd = Math.sqrt(variance);
  return dailyStd * Math.sqrt(252);
}

function maxDrawdownFromCloses(closes) {
  if (!closes || closes.length === 0) return 0;
  let peak = -Infinity;
  let maxDD = 0;
  for (const p of closes) {
    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// very small keyword-based fallback sentiment (used if news-sentiment endpoint not available)
function sentimentScoreFromNewsItems(newsItems) {
  if (!newsItems || newsItems.length === 0) return 0.5;
  const negative = ['lawsuit', 'recall', 'miss', 'drop', 'cut', 'layoff', 'bankrupt', 'fraud', 'investigation', 'downgrade', 'sell'];
  const positive = ['beat', 'top', 'upgrade', 'buyback', 'raise', 'acquire', 'acquisition', 'partnership', 'upgrade', 'buy'];
  let score = 0;
  for (const n of newsItems) {
    const title = (n.headline || n.summary || '').toLowerCase();
    for (const w of negative) if (title.includes(w)) score -= 1;
    for (const w of positive) if (title.includes(w)) score += 1;
  }
  const norm = (score + newsItems.length) / (2 * newsItems.length);
  return Math.max(0, Math.min(1, norm));
}

// ---------- Finnhub fetchers (with cache) ----------
async function finnhubGet(path, params = {}) {
  if (!FINNHUB_KEY) throw new Error('FINNHUB_API_KEY not set');
  const url = `${FINNHUB_API}/${path}`;
  const resp = await axios.get(url, { params: { ...params, token: FINNHUB_KEY }, timeout: 10000 });
  return resp.data;
}

async function fetchHistoricalPrices(ticker, days = 365) {
  const key = `hist:${ticker}:${days}`;
  const c = cache.get(key);
  if (c) return c;
  const to = dayjs();
  const from = to.subtract(days, 'day');
  const params = { symbol: ticker, resolution: 'D', from: Math.floor(from.unix()), to: Math.floor(to.unix()) };
  const data = await finnhubGet('stock/candle', params);
  if (!data || data.s !== 'ok') throw new Error(`No historical data for ${ticker}`);
  const res = { closes: data.c, times: data.t };
  cache.set(key, res, 60 * 5);
  return res;
}

async function fetchFundamentals(ticker) {
  const key = `fund:${ticker}`;
  const c = cache.get(key);
  if (c) return c;
  try {
    const profile = await finnhubGet('stock/profile2', { symbol: ticker });
    const metrics = await finnhubGet('stock/metric', { symbol: ticker, metric: 'all' }).catch(() => ({}));
    const financials = await finnhubGet('stock/financials-reported', { symbol: ticker, frequency: 'annual' }).catch(() => ({}));
    const payload = { profile, metrics, financials };
    cache.set(key, payload, 60 * 60);
    return payload;
  } catch (e) {
    return null;
  }
}

async function fetchEarnings(ticker) {
  const key = `earnings:${ticker}`;
  const c = cache.get(key);
  if (c) return c;
  try {
    const data = await finnhubGet('stock/earnings', { symbol: ticker }).catch(() => []);
    cache.set(key, data, 60 * 30);
    return data;
  } catch (e) {
    return [];
  }
}

async function fetchNews(ticker, fromDays = 7) {
  const key = `news:${ticker}:${fromDays}`;
  const c = cache.get(key);
  if (c) return c;
  try {
    const from = dayjs().subtract(fromDays, 'day').format('YYYY-MM-DD');
    const to = dayjs().format('YYYY-MM-DD');
    // try company-news first
    const data = await finnhubGet('company-news', { symbol: ticker, from, to }).catch(() => []);
    cache.set(key, data, 60 * 10);
    return data;
  } catch (e) {
    return [];
  }
}

async function fetchVIX() {
  const key = 'vix';
  const c = cache.get(key);
  if (c) return c;
  try {
    const to = dayjs();
    const from = to.subtract(30, 'day');
    const params = { symbol: '^VIX', resolution: 'D', from: Math.floor(from.unix()), to: Math.floor(to.unix()) };
    const data = await finnhubGet('stock/candle', params).catch(() => null);
    if (data && data.s === 'ok' && data.c && data.c.length) {
      const last = data.c[data.c.length - 1];
      cache.set(key, last, 60 * 30);
      return last;
    }
  } catch (e) { /**/ }
  cache.set(key, 20, 60 * 30);
  return 20;
}

// ---------- Core analyzer function ----------
async function analyzeStockRisk(symbol, currentPrice = null) {
  try {
    symbol = (symbol || '').toUpperCase();
    if (!symbol) throw new Error('symbol required');

    // try cache first
    const cacheKey = `analyze:${symbol}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // 1) historical prices for ticker and S&P
    const [hist, spxHist] = await Promise.all([
      fetchHistoricalPrices(symbol, 365).catch(() => null),
      fetchHistoricalPrices('^GSPC', 365).catch(() => fetchHistoricalPrices('SPY', 365).catch(() => null))
    ]);

    // compute returns & volatility
    let returnsTicker = [], returnsSPX = [];
    let volShort = 0, volMed = 0, volLong = 0, volComposite = 0, drawdown90 = 0;
    if (hist && hist.closes && hist.closes.length > 10) {
      returnsTicker = computeReturnsFromCloses(hist.closes, hist.times);
      const shortSlice = { closes: hist.closes.slice(- (WINDOWS.short + 1)), times: hist.times.slice(- (WINDOWS.short + 1)) };
      const medSlice = { closes: hist.closes.slice(- (WINDOWS.medium + 1)), times: hist.times.slice(- (WINDOWS.medium + 1)) };
      const longSlice = { closes: hist.closes.slice(- (WINDOWS.long + 1)), times: hist.times.slice(- (WINDOWS.long + 1)) };
      volShort = annualizedVolatilityFromReturns(computeReturnsFromCloses(shortSlice.closes, shortSlice.times));
      volMed = annualizedVolatilityFromReturns(computeReturnsFromCloses(medSlice.closes, medSlice.times));
      volLong = annualizedVolatilityFromReturns(computeReturnsFromCloses(longSlice.closes, longSlice.times));
      volComposite = (volShort + volMed + volLong) / 3;
      drawdown90 = maxDrawdownFromCloses(longSlice.closes);
    }

    if (spxHist && spxHist.closes && spxHist.closes.length > 10) {
      returnsSPX = computeReturnsFromCloses(spxHist.closes, spxHist.times);
    }

    // 2) beta (regression)
    let beta = 1;
    try {
      if (returnsTicker.length >= 20 && returnsSPX.length >= 20) {
        // align ends
        const minLen = Math.min(returnsTicker.length, returnsSPX.length);
        const x = returnsSPX.slice(-minLen).map(r => r.ret);
        const y = returnsTicker.slice(-minLen).map(r => r.ret);
        const data = x.map((xi, i) => [xi, y[i]]);
        const result = regression.linear(data, { precision: 6 });
        beta = result?.equation?.[0] ?? 1;
      } else {
        // fallback: use profile.beta if available later
        beta = 1;
      }
    } catch (e) {
      beta = 1;
    }

    // 3) fundamentals & metrics
    const fundamentals = await fetchFundamentals(symbol).catch(() => null);
    const metrics = fundamentals?.metrics?.metric || {};
    const profile = fundamentals?.profile || {};
    const dToE = metrics?.debtToEquity ?? (profile?.marketCapitalization ? 0.5 : 0.5);
    const interestCoverage = metrics?.interestCoverage ?? 5;
    const sharpe = metrics?.sharpeRatio ?? 0.5;
    const fcfPerShare = metrics?.freeCashFlowPerShare ?? null;

    // FCF stability simple heuristic
    const fcfStability = fcfPerShare ? normalize(fcfPerShare, -1, 5) : 0.5;

    // 4) earnings & surprises
    const earningsData = await fetchEarnings(symbol).catch(() => []);
    let earningsImpact = 0;
    if (Array.isArray(earningsData) && earningsData.length > 0) {
      const last = earningsData[0];
      if (typeof last.actual === 'number' && typeof last.estimate === 'number') {
        const surprisePct = (last.actual - last.estimate) / (Math.abs(last.estimate) || 1);
        earningsImpact = surprisePct; // can be negative or positive
      } else {
        earningsImpact = 0;
      }
    }

    // 5) news & sentiment
    const newsItems = await fetchNews(symbol, 14).catch(() => []);
    // try Finnhub news-sentiment if available
    let sentiment = 0.5;
    try {
      // finnhub has news-sentiment endpoint for tickers
      const ns = await axios.get(`${FINNHUB_API}/news-sentiment`, { params: { symbol, token: FINNHUB_KEY }, timeout: 8000 }).then(r => r.data).catch(() => null);
      if (ns && typeof ns.sentiment === 'object') {
        // ns.sentiment example: { positive: x, negative: y, neutral: z }
        const pos = ns.sentiment.positive || 0;
        const neg = ns.sentiment.negative || 0;
        sentiment = (pos + 1e-6) / (pos + neg + 1e-6); // map 0..1 (higher = more positive)
      } else {
        sentiment = sentimentScoreFromNewsItems(newsItems);
      }
    } catch (e) {
      sentiment = sentimentScoreFromNewsItems(newsItems);
    }

    // 6) VIX approximation
    const vix = await fetchVIX().catch(() => 20);

    // 7) relative strength
    const rs = (returnsTicker.length && returnsSPX.length) ? (() => {
      const len = Math.min(returnsTicker.length, returnsSPX.length, WINDOWS.long);
      if (len < 5) return 0.5;
      const tSlice = returnsTicker.slice(-len).map(r => r.ret);
      const sSlice = returnsSPX.slice(-len).map(r => r.ret);
      const tCum = tSlice.reduce((a, b) => a * (1 + b), 1) - 1;
      const sCum = sSlice.reduce((a, b) => a * (1 + b), 1) - 1;
      const ratio = (1 + tCum) / (1 + sCum) - 1;
      return normalize(ratio, -0.5, 0.5);
    })() : 0.5;

    // 8) compute normalized scores where 1 = high risk
    const betaScore = normalize(beta, 0, 2.5); // >2.5 high risk
    const volScore = normalize(volComposite, 0, 1); // 100% vol -> 1
    const sharpeScore = 1 - normalize(sharpe, -1, 2); // lower sharpe -> higher risk
    const drawdownScore = normalize(drawdown90, 0, 0.8);
    const debtScore = normalize(dToE, 0, 2);
    const interestCoverageScore = 1 - normalize(interestCoverage, 0, 20);
    const fcfScore = 1 - fcfStability;
    const earningsVarScore = 1 - normalize(Math.abs(earningsImpact), 0, 1); // big surprise -> more impact (we'll use eventRisk later)
    const rsScore = 1 - rs; // better RS -> lower risk
    const eventRiskScore = (() => {
      // combine negative sentiment and negative earnings surprise
      const newsRisk = 1 - sentiment; // low sentiment -> higher risk
      const surpriseRisk = (earningsImpact < 0) ? normalize(-earningsImpact, 0, 1) : 0; // negative surprise increases risk
      return Math.max(newsRisk, surpriseRisk);
    })();
    const vixScore = normalize(vix, 10, 40);
    const sectorVolScore = volScore; // placeholder
    const sentimentScore = 1 - sentiment; // lower sentiment -> higher risk

    // 9) composite weighted sum (0..1)
    const composite = (
      WEIGHTS.beta * betaScore +
      WEIGHTS.volatility * volScore +
      WEIGHTS.sharpe * sharpeScore +
      WEIGHTS.drawdown * drawdownScore +
      WEIGHTS.volumeVol * 0.5 + // placeholder for volume volatility
      WEIGHTS.debtToEquity * debtScore +
      WEIGHTS.interestCoverage * interestCoverageScore +
      WEIGHTS.fcfStability * fcfScore +
      WEIGHTS.earningsVariability * (1 - earningsVarScore) + // more variability -> higher risk
      WEIGHTS.relativeStrength * rsScore +
      WEIGHTS.eventRisk * eventRiskScore +
      WEIGHTS.vix * vixScore +
      WEIGHTS.sectorVolatility * sectorVolScore +
      WEIGHTS.sentiment * sentimentScore
    );

    // map composite 0..1 to 1..10 (higher composite -> higher risk)
    const overallRiskScore = Math.min(10, Math.max(1, Math.round((composite * 9) + 1)));

    const explanation = {
      beta: { value: beta, score: betaScore },
      volatility: { short: volShort, med: volMed, long: volLong, composite: volComposite, score: volScore },
      drawdown90,
      debtToEquity: dToE,
      interestCoverage,
      fcfPerShare,
      fcfStability,
      earningsImpact,
      eventRiskScore,
      sentiment,
      vix,
      relativeStrength: rs,
      compositeRaw: composite
    };

    const result = {
      overallRiskScore,
      beta,
      volatility: volComposite,
      sentiment,
      earningsImpact,
      explanation,
      analyzedAt: new Date().toISOString()
    };

    cache.set(cacheKey, result, 60 * 5);
    return result;
  } catch (err) {
    // On error return conservative medium risk
    return {
      overallRiskScore: 5,
      beta: 1,
      volatility: 0,
      sentiment: 0.5,
      earningsImpact: 0,
      explanation: { error: err.message },
      analyzedAt: new Date().toISOString()
    };
  }
}

module.exports = { analyzeStockRisk, /* optional: clearCache */ clearCache: (key) => cache.del(key) };

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { getRealTimePrice: getAlpacaPrice } = require('./alpacaPriceFetcher');
const { getRealTimePrice: getFinnhubPrice } = require('./finnhubPriceFetcher');
const { generateJSONFromHF } = require('./hfClient');

const log = console;
const app = express();

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
app.use(express.json({ limit: '1mb' }));

// ====== MEMORY DB ======
const userPortfolios = {};
const userPrices = {};
const priceHistory15Min = {};
const userRiskCache = {};
const sseClients = {}; 

// ====== MAKE NOTIFIER ======
const lastAlerts = {};
function alertKey(userId, symbol, type) {
  return `${userId}:${symbol}:${type}`;
}
function shouldThrottle(userId, symbol, type, windowMs = 10 * 60 * 1000) {
  const k = alertKey(userId, symbol, type);
  const now = Date.now();
  if (!lastAlerts[k] || (now - lastAlerts[k]) > windowMs) {
    lastAlerts[k] = now;
    return false;
  }
  return true;
}


async function notifyMake(event) {
  try {
    if (!process.env.MAKE_WEBHOOK_URL) return;

    const res = await fetch(process.env.MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...event,
        source: "riskwise-server",
        ts: new Date().toISOString()
      })
    });

    log.info(`📤 נשלחה התראה ל-Make (${event.type}) → ${res.status}`);
  } catch (err) {
    log.error("❌ שגיאה בשליחת התראה ל-Make:", err.message);
  }
}

// ====== PROMPT TEMPLATE ======
const PROMPT_TEMPLATE = `
אתה מנוע סיכון כמותי. החזר JSON חוקי בלבד.
{
  "risk_score": number,
  "stop_loss_percent": number,
  "stop_loss_price": number,
  "rationale": string
}
נתוני המניה:
- טיקר: {TICKER}
- מחיר נוכחי: {CURRENT_PRICE}
- כמות: {QUANTITY}
- סכום מושקע: {AMOUNT_INVESTED}
- סקטור: {SECTOR}
`;

// ====== SSE HELPERS ======
function pushUpdate(userId, data) {
  if (sseClients[userId]) {
    sseClients[userId].forEach(res => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    });
    log.info(`📡 נשלח עדכון SSE ל-${userId}:`, data);
  }
}
setInterval(() => {
  for (const userId in sseClients) {
    sseClients[userId].forEach(res => {
      res.write(`data: ${JSON.stringify({ type: "ping", ts: Date.now() })}\n\n`);
    });
  }
}, 30000);

// ====== FUNCTIONS ======
async function calculateAdvancedRisk(stockData, userId) {
  try {
    const { ticker, currentPrice } = stockData;
    if (!userRiskCache[userId]) userRiskCache[userId] = {};

    const cached = userRiskCache[userId][ticker];
    if (cached) {
      const changePercent = Math.abs(currentPrice - cached.price) / cached.price * 100;
      if (changePercent < 5) {
        log.info(`⚡ שימוש בנתוני מטמון לריסק ${ticker} עבור ${userId}`);
        return cached.result;
      }
    }

    const prompt = PROMPT_TEMPLATE
      .replace('{TICKER}', ticker)
      .replace('{CURRENT_PRICE}', currentPrice)
      .replace('{QUANTITY}', stockData.quantity)
      .replace('{AMOUNT_INVESTED}', stockData.amountInvested)
      .replace('{SECTOR}', stockData.sector || 'לא מוגדר');

    const result = await generateJSONFromHF(prompt);

    let stop_loss_percent = Number(result.stop_loss_percent) || 10;
    let stop_loss_price = Number(result.stop_loss_price) || currentPrice * (1 - stop_loss_percent / 100);

    const clean = {
      risk_score: Math.min(Math.max(Number(result.risk_score) || 5, 1), 10),
      stop_loss_percent: +stop_loss_percent.toFixed(2),
      stop_loss_price: +stop_loss_price.toFixed(2),
      rationale: String(result.rationale || '').slice(0, 200)
    };

    userRiskCache[userId][ticker] = { price: currentPrice, result: clean };
    log.info(`✅ חישוב ריסק עבור ${ticker} (${userId}) →`, clean);

    if (!shouldThrottle(userId, ticker, "STOP_LOSS_UPDATED", 5 * 60 * 1000)) {
      await notifyMake({
        type: "STOP_LOSS_UPDATED",
        userId,
        symbol: ticker,
        price: currentPrice,
        stopLoss: clean.stop_loss_price,
        risk: clean.risk_score
      });
    }

    return clean;
  } catch (e) {
    log.error(`❌ שגיאה בחישוב ריסק למניה ${stockData.ticker}: ${e.message}`);
    return null;
  }
}

async function checkFifteenMinuteDrop(userId, symbol, currentPrice, portfolio) {
  if (!priceHistory15Min[userId]) priceHistory15Min[userId] = {};
  const now = Date.now();
  const history = priceHistory15Min[userId][symbol];

  if (history && now - history.time <= 15 * 60 * 1000) {
    const change = ((currentPrice - history.price) / history.price) * 100;
    if (change <= -5) {
      log.warn(`📉 ירידה ${change.toFixed(2)}% ב-15 דק' עבור ${symbol} (${userId})`);

      if (!shouldThrottle(userId, symbol, "FIFTEEN_MIN_DROP", 10 * 60 * 1000)) {
        await notifyMake({
          type: "FIFTEEN_MIN_DROP",
          userId,
          symbol,
          price: currentPrice,
          changePercent: +change.toFixed(2)
        });
      }

      const riskResult = await calculateAdvancedRisk({
        ticker: symbol, currentPrice,
        quantity: portfolio.stocks[symbol].quantity || 1,
        amountInvested: portfolio.stocks[symbol].amountInvested || currentPrice,
        sector: portfolio.stocks[symbol].sector || 'לא מוגדר'
      }, userId);

      if (riskResult) {
        portfolio.stocks[symbol].stopLoss = riskResult.stop_loss_price;
        portfolio.stocks[symbol].risk = riskResult.risk_score;
      }
    }
  }

  priceHistory15Min[userId][symbol] = { price: currentPrice, time: now };
}

async function checkAndUpdatePrices() {
  for (const userId in userPortfolios) {
    const portfolio = userPortfolios[userId];
    if (!userPrices[userId]) userPrices[userId] = {};

    for (const symbol in portfolio.stocks) {
      try {
        let price = portfolio.alpacaKeys
          ? await getAlpacaPrice(symbol, portfolio.alpacaKeys.key, portfolio.alpacaKeys.secret)
          : await getFinnhubPrice(symbol);

        userPrices[userId][symbol] = { price, time: Date.now() };

        const riskResult = await calculateAdvancedRisk({
          ticker: symbol,
          currentPrice: price,
          quantity: portfolio.stocks[symbol].quantity || 1,
          amountInvested: portfolio.stocks[symbol].amountInvested || price,
          sector: portfolio.stocks[symbol].sector || 'לא מוגדר'
        }, userId);

        if (riskResult) {
          portfolio.stocks[symbol].stopLoss = riskResult.stop_loss_price;
          portfolio.stocks[symbol].risk = riskResult.risk_score;
        }

        if (portfolio.stocks[symbol].stopLoss && price <= portfolio.stocks[symbol].stopLoss) {
          if (!shouldThrottle(userId, symbol, "STOP_LOSS_HIT", 60 * 1000)) {
            await notifyMake({
              type: "STOP_LOSS_HIT",
              userId,
              symbol,
              price,
              stopLoss: portfolio.stocks[symbol].stopLoss
            });
          }
        }

        await checkFifteenMinuteDrop(userId, symbol, price, portfolio);

        pushUpdate(userId, {
          stockTicker: symbol,
          price,
          stopLoss: portfolio.stocks[symbol].stopLoss || null,
          risk: portfolio.stocks[symbol].risk || null
        });

        log.info(`📊 ${symbol} (${userId}) → $${price} | SL: ${portfolio.stocks[symbol].stopLoss}`);
      } catch (err) {
        log.error(`❌ שגיאה במחיר ${symbol}: ${err.message}`);
      }
    }
  }
}

// ====== ROUTES ======
app.get('/', (req, res) => res.send('✅ RiskWise API Online'));

app.post('/update-portfolio', (req, res) => {
  log.info("📥 התקבלה בקשת עדכון תיק:", req.body);
  const { userId, stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment } = req.body;
  if (!userId || !stocks) {
    log.error("❌ בקשה חסרה נתונים:", req.body);
    return res.status(400).json({ error: 'חסרים נתונים' });
  }
  userPortfolios[userId] = { stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment };
  log.info(`📁 תיק נשמר בהצלחה עבור ${userId}`);
  res.json({ message: 'Portfolio updated' });
});

app.get('/portfolio/:userId', (req, res) => {
  const userId = req.params.userId;
  log.info(`🔍 בקשת שליפת תיק עבור ${userId}`);
  const portfolio = userPortfolios[userId];
  if (!portfolio) {
    log.error(`❌ לא נמצא תיק עבור ${userId}`);
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(portfolio);
});

// 🔴 חיבור SSE
app.get('/events/:userId', (req, res) => {
  const userId = req.params.userId;
  log.info(`📡 חיבור SSE נפתח עבור ${userId}`);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  if (!sseClients[userId]) sseClients[userId] = [];
  sseClients[userId].push(res);
  req.on('close', () => {
    log.warn(`❌ חיבור SSE נסגר עבור ${userId}`);
    sseClients[userId] = sseClients[userId].filter(r => r !== res);
  });
});

// 🚨 ROUTE זמני לבדיקה ידנית של MAKE 🚨
// אפשר למחוק/להעיר אחרי שסיימת לבדוק
app.get('/test-make', async (req, res) => {
  try {
    await notifyMake({
      type: "TEST_EVENT",
      userId: "demoUser",
      symbol: "AAPL",
      price: 150,
      stopLoss: 140,
      risk: 5,
      message: "זוהי בדיקת חיבור ידנית ל-Make"
    });
    res.json({ success: true, message: "התראה נשלחה ל-Make" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}); 

// ====== JOBS ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log.info(`✅ Server started on port ${PORT}`);
  setInterval(checkAndUpdatePrices, 60 * 1000);
});
cron.schedule('0 14 * * 5', checkAndUpdatePrices);
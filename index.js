require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const { getRealTimePrice: getAlpacaPrice } = require('./alpacaPriceFetcher');
const { getRealTimePrice: getFinnhubPrice } = require('./finnhubPriceFetcher');
const { generateJSONFromHF } = require('./hfClient');
const { calculateRiskAndStopLoss } = require('./riskCalculator');

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
const sseClients = {}; // לקוחות SSE
const lastAlerts = {}; // למניעת הצפה

// ====== EMAIL TRANSPORTER ======
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

async function sendEmail(to, subject, text) {
  try {
    await transporter.sendMail({
      from: `"RiskWise Alerts" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      text
    });
    log.info(`📧 נשלח מייל אל ${to}: ${subject}`);
  } catch (err) {
    log.error("❌ שגיאה בשליחת מייל:", err.message);
  }
}

// ====== MAKE NOTIFIER ======
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
      body: JSON.stringify({ ...event, ts: new Date().toISOString() })
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

// שמירה על חיבור SSE חי (ping כל 30 שניות)
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

    // בדיקת מטמון
    const cached = userRiskCache[userId][ticker];
    if (cached) {
      const changePercent = Math.abs(currentPrice - cached.price) / cached.price * 100;
      if (changePercent < 3) return cached.result;
    }

    const portfolio = userPortfolios[userId];
    const priceHistory = [currentPrice * 0.98, currentPrice * 1.01, currentPrice * 0.99, currentPrice * 1.02, currentPrice]; // זמני — תוכל להחליף בהיסטוריה אמיתית בהמשך

    const stock = {
      ticker,
      entry_price: stockData.amountInvested || currentPrice,
      sector: stockData.sector || 'לא ידוע',
    };

    // כאן הקריאה למודל של Base44
    const result = calculateRiskAndStopLoss(stock, priceHistory, portfolio.portfolioRiskLevel || 50);

    const clean = {
      risk_score: result.riskScore,
      stop_loss_price: result.stopLossPrice,
    };

    userRiskCache[userId][ticker] = { price: currentPrice, result: clean };

    return clean;
  } catch (err) {
    log.error(`❌ שגיאה בחישוב סיכון למניה ${stockData.ticker}: ${err.message}`);
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
      const portfolio = userPortfolios[userId];
      if (!shouldThrottle(userId, symbol, "FIFTEEN_MIN_DROP", 10 * 60 * 1000)) {
        await sendEmail(
          portfolio.userEmail || process.env.ALERT_EMAIL,
          `📉 15min Drop Alert (${symbol})`,
          `משתמש: ${userId}\nמניה: ${symbol}\nירידה: ${change.toFixed(2)}%\nמחיר נוכחי: ${currentPrice}`
        );
        await notifyMake({ type: "FIFTEEN_MIN_DROP", userId, symbol, price: currentPrice, changePercent: change.toFixed(2) });
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
            await sendEmail(
              portfolio.userEmail || process.env.ALERT_EMAIL,
              `🚨 Stop Loss Hit (${symbol})`,
              `משתמש: ${userId}\nמניה: ${symbol}\nמחיר נוכחי: ${price}\nStop Loss: ${portfolio.stocks[symbol].stopLoss}`
            );
            await notifyMake({ type: "STOP_LOSS_HIT", userId, symbol, price, stopLoss: portfolio.stocks[symbol].stopLoss });
          }
        }

        await checkFifteenMinuteDrop(userId, symbol, price, portfolio);

        pushUpdate(userId, {
          stockTicker: symbol,
          price,
          stopLoss: portfolio.stocks[symbol].stopLoss || null,
          risk: portfolio.stocks[symbol].risk || null
        });

      } catch (err) {
        log.error(`❌ שגיאה במחיר ${symbol}: ${err.message}`);
      }
    }
  }
}

// ====== ROUTES ======
app.get('/', (req, res) => res.send('✅ RiskWise API Online'));

app.post('/update-portfolio', (req, res) => {
  const { userId, stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment } = req.body;
  if (!userId || !stocks) return res.status(400).json({ error: 'חסרים נתונים' });
  userPortfolios[userId] = { stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment };
  res.json({ message: 'Portfolio updated' });
});

app.get('/portfolio/:userId', (req, res) => {
  const portfolio = userPortfolios[req.params.userId];
  if (!portfolio) return res.status(404).json({ error: 'Not found' });
  res.json(portfolio);
});

// 🔴 חיבור SSE
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

// ====== JOBS ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log.info(`✅ Server started on port ${PORT}`);
  setInterval(checkAndUpdatePrices, 60 * 1000);
});
cron.schedule('0 14 * * 5', checkAndUpdatePrices);
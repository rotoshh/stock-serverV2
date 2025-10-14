require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { getRealTimePrice: getAlpacaPrice } = require('./alpacaPriceFetcher');
const { getRealTimePrice: getFinnhubPrice } = require('./finnhubPriceFetcher');
const { sendEmail } = require('./emailService');
const { calculateRiskAndStopLoss } = require('./riskCalculator'); // ✅ שימוש במודל Base44 החדש

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
const sseClients = {}; // לקוחות SSE

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

// ====== חישוב סיכון וסטופ לוס בעזרת Base44 ======
async function calculateRiskBase44(stockData, portfolioRiskLevel = 50) {
  try {
    const { ticker, currentPrice, sector } = stockData;

    // שלב 1: הדמיית היסטוריית מחירים (או שימוש אמיתי בעתיד)
    const priceHistory = [];
    for (let i = 0; i < 60; i++) {
      const change = (Math.random() - 0.5) * 0.05;
      const price = currentPrice * (1 + change);
      priceHistory.push(price);
    }

    // שלב 2: חישוב לפי המודל של Base44
    const result = calculateRiskAndStopLoss({
      ticker,
      entry_price: currentPrice,
      sector: sector || 'לא מוגדר'
    }, priceHistory, portfolioRiskLevel);

    return result;
  } catch (e) {
    log.error(`❌ שגיאה בחישוב ריסק Base44: ${e.message}`);
    return null;
  }
}

// ====== עדכון סטופ לוס ושליחת מייל ======
async function updateStopLossAndNotify(userId, symbol, portfolio, riskData, currentPrice) {
  const oldStopLoss = portfolio.stocks[symbol].stopLoss || 0;
  const newStopLoss = riskData.stopLossPrice;
  if (Math.abs(newStopLoss - oldStopLoss) > 0.01) {
    portfolio.stocks[symbol].stopLoss = newStopLoss;
    const msg = `
      <h2>📉 עדכון סטופ לוס</h2>
      <p>המניה <strong>${symbol}</strong> עודכנה על ידי מערכת הסיכון.</p>
      <p>סטופ לוס חדש: <strong>$${newStopLoss.toFixed(2)}</strong></p>
      <p>רמת סיכון: ${riskData.riskScore}</p>
    `;
    await sendEmail({
      to: portfolio.userEmail,
      subject: `עדכון סטופ לוס - ${symbol}`,
      html: msg
    });
    log.info(`📧 נשלח מייל עדכון סטופ לוס עבור ${symbol} (${userId})`);
  }
}

// ====== בדיקה של ירידה של 5% ב-15 דקות ======
async function checkFifteenMinuteDrop(userId, symbol, currentPrice, portfolio) {
  if (!priceHistory15Min[userId]) priceHistory15Min[userId] = {};
  const now = Date.now();
  const history = priceHistory15Min[userId][symbol];

  if (history && now - history.time <= 15 * 60 * 1000) {
    const change = ((currentPrice - history.price) / history.price) * 100;
    if (change <= -5) {
      log.warn(`📉 ירידה ${change.toFixed(2)}% ב-15 דק' עבור ${symbol} (${userId})`);
      const riskResult = await calculateRiskBase44({
        ticker: symbol, currentPrice,
        sector: portfolio.stocks[symbol].sector
      }, portfolio.portfolioRiskLevel);
      if (riskResult) {
        await updateStopLossAndNotify(userId, symbol, portfolio, riskResult, currentPrice);
      }
    }
  }
  priceHistory15Min[userId][symbol] = { price: currentPrice, time: now };
}

// ====== בדיקת מחירים ======
async function checkAndUpdatePrices() {
  for (const userId in userPortfolios) {
    const portfolio = userPortfolios[userId];
    for (const symbol in portfolio.stocks) {
      try {
        const price = portfolio.alpacaKeys
          ? await getAlpacaPrice(symbol, portfolio.alpacaKeys.key, portfolio.alpacaKeys.secret)
          : await getFinnhubPrice(symbol);

        const riskResult = await calculateRiskBase44({
          ticker: symbol,
          currentPrice: price,
          sector: portfolio.stocks[symbol].sector
        }, portfolio.portfolioRiskLevel);

        if (riskResult) {
          portfolio.stocks[symbol].stopLoss = riskResult.stopLossPrice;
          portfolio.stocks[symbol].risk = riskResult.riskScore;
          await updateStopLossAndNotify(userId, symbol, portfolio, riskResult, price);
        }

        pushUpdate(userId, {
          stockTicker: symbol,
          price,
          stopLoss: portfolio.stocks[symbol].stopLoss,
          risk: portfolio.stocks[symbol].risk
        });

        log.info(`📊 ${symbol} (${userId}) → $${price} | SL: ${portfolio.stocks[symbol].stopLoss}`);
      } catch (err) {
        log.error(`❌ שגיאה במחיר ${symbol}: ${err.message}`);
      }
    }
  }
}

// ====== ROUTES ======
app.get('/', (req, res) => res.send('✅ RiskWise API (Base44 model) Online'));

app.post('/update-portfolio', (req, res) => {
  const { userId, stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment } = req.body;
  if (!userId || !stocks) return res.status(400).json({ error: 'חסרים נתונים' });
  userPortfolios[userId] = { stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment };
  res.json({ message: 'Portfolio updated' });
});

// 🔴 SSE
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
  setInterval(checkAndUpdatePrices, 60 * 1000); // כל דקה
});
cron.schedule('0 14 * * 5', checkAndUpdatePrices);

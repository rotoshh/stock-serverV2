require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
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
const sseClients = {}; // לקוחות SSE

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
  }
}

// ====== FUNCTIONS ======
async function calculateAdvancedRisk(stockData, userId) {
  try {
    const { ticker, currentPrice } = stockData;
    if (!userRiskCache[userId]) userRiskCache[userId] = {};
    const cached = userRiskCache[userId][ticker];
    if (cached) {
      const changePercent = Math.abs(currentPrice - cached.price) / cached.price * 100;
      if (changePercent < 5) return cached.result;
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
    return clean;
  } catch (e) {
    log.error(`❌ Error in risk calculation for ${stockData.ticker}: ${e.message}`);
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

        // חישוב AI לסטופ לוס וריסק
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

        await checkFifteenMinuteDrop(userId, symbol, price, portfolio);

        // שליחה ל-Frontend
        pushUpdate(userId, {
          stockTicker: symbol,
          price,
          stopLoss: portfolio.stocks[symbol].stopLoss || null,
          risk: portfolio.stocks[symbol].risk || null
        });

      } catch (err) {
        log.error(`❌ Error price ${symbol}: ${err.message}`);
      }
    }
  }
}

// ====== ROUTES ======
app.get('/', (req, res) => res.send('✅ RiskWise API Online'));

app.post('/update-portfolio', (req, res) => {
  const { userId, stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment } = req.body;
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
  setInterval(checkAndUpdatePrices, 5 * 60 * 1000);
});

cron.schedule('0 14 * * 5', checkAndUpdatePrices);

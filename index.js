require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const { getRealTimePrice: getAlpacaPrice } = require('./alpacaPriceFetcher');
const { getRealTimePrice: getFinnhubPrice } = require('./finnhubPriceFetcher');
const { sendEmail } = require('./emailService');
const { sendPushNotification } = require('./pushServices');
const { generateJSONFromHF } = require('./hfClient');

const log = console;
const app = express();

// ---- CORS + JSON SAFE ----
const allowedOrigins = [
  'https://preview--risk-wise-396ab87e.base44.app', // דומיין של VibeCoding/Base44
  'http://localhost:3000',  // לפיתוח מקומי
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
const clients = []; // לקוחות SSE

// ====== SSE ======
app.get('/stream/:userId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const userId = req.params.userId;
  clients.push({ userId, res });

  req.on('close', () => {
    const idx = clients.findIndex(c => c.res === res);
    if (idx !== -1) clients.splice(idx, 1);
  });
});

function pushUpdate(userId, data) {
  clients
    .filter(c => c.userId === userId)
    .forEach(c => c.res.write(`data: ${JSON.stringify(data)}\n\n`));
}

// ====== PROMPT TEMPLATE ======
const PROMPT_TEMPLATE = `
אתה מנוע סיכון כמותי. החזר JSON חוקי *בלבד* (ללא טקסט נוסף, ללא backticks).
השדות והפורמט המדויקים:
{
  "risk_score": number (1-10),
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

חוקים:
- החזר JSON חוקי בלבד.
- ודא ש-"stop_loss_price" עקבי עם "stop_loss_percent" והמחיר הנוכחי.
`;

// ====== FUNCTIONS ======
async function calculateAdvancedRisk(stockData, userId) {
  try {
    const { ticker, currentPrice } = stockData;
    if (!userRiskCache[userId]) userRiskCache[userId] = {};
    const cached = userRiskCache[userId][ticker];
    if (cached) {
      const changePercent = Math.abs(currentPrice - cached.price) / cached.price * 100;
      if (changePercent < 5) {
        log.info(`⚠️ שימוש בנתוני סיכון מהמטמון עבור ${ticker}`);
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

    const risk_score = Number(result.risk_score);
    let stop_loss_percent = Number(result.stop_loss_percent);
    let stop_loss_price = Number(result.stop_loss_price);

    if (!Number.isFinite(stop_loss_percent) || stop_loss_percent <= 0 || stop_loss_percent >= 90) {
      stop_loss_percent = 10;
    }
    if (!Number.isFinite(stop_loss_price) || stop_loss_price <= 0) {
      stop_loss_price = currentPrice * (1 - stop_loss_percent / 100);
    }

    const clean = {
      risk_score: Number.isFinite(risk_score) ? Math.min(Math.max(risk_score, 1), 10) : 5,
      stop_loss_percent: +stop_loss_percent.toFixed(2),
      stop_loss_price: +stop_loss_price.toFixed(2),
      rationale: String(result.rationale || '').slice(0, 200)
    };

    userRiskCache[userId][ticker] = {
      price: currentPrice,
      result: clean,
      timestamp: Date.now()
    };

    log.info(`✅ Risk score for ${ticker}: ${clean.risk_score}, SL: ${clean.stop_loss_price} (${clean.stop_loss_percent}%)`);
    return clean;
  } catch (error) {
    log.error(`❌ Error in risk calculation for ${stockData.ticker}: ${error.message}`);
    return {
      risk_score: 5,
      stop_loss_percent: 10,
      stop_loss_price: +(stockData.currentPrice * 0.9).toFixed(2),
      rationale: "Fallback stop loss בגלל שגיאה"
    };
  }
}

async function sendAllNotifications(userId, portfolio, notification) {
  if (!portfolio.userNotifications) portfolio.userNotifications = [];
  portfolio.userNotifications.push(notification);
  await sendPushNotification(userId, notification.message);
  pushUpdate(userId, notification);
}

async function updateStopLossAndNotify(userId, stockSymbol, portfolio, riskData, currentPrice) {
  const oldStopLoss = portfolio.stocks[stockSymbol].stopLoss || 0;
  const riskLevelPercent = portfolio.portfolioRiskLevel || 10;

  const modelStop = riskData?.stop_loss_price;
  const newStopLoss = Number.isFinite(modelStop)
    ? Number(modelStop)
    : currentPrice * (1 - riskLevelPercent / 100);

  if (Math.abs(newStopLoss - oldStopLoss) > 0.01) {
    portfolio.stocks[stockSymbol].stopLoss = newStopLoss;

    await sendEmail({
      to: portfolio.userEmail,
      subject: `📉 התראת Stop Loss עבור ${stockSymbol}`,
      html: `<h1>התראה ממערכת RiskWise</h1><p>הסטופ לוס של <strong>${stockSymbol}</strong> עודכן ל: <strong>$${newStopLoss.toFixed(2)}</strong></p>`
    });

    const notification = {
      id: Date.now() + Math.random(),
      type: 'stop_loss_update',
      message: `סטופ לוס חדש למניה ${stockSymbol}: $${newStopLoss.toFixed(2)}`,
      timestamp: new Date().toISOString(),
      stockTicker: stockSymbol,
      newStopLoss,
      read: false
    };
    await sendAllNotifications(userId, portfolio, notification);

    pushUpdate(userId, { symbol: stockSymbol, stopLoss: newStopLoss, price: currentPrice });

    if (currentPrice <= newStopLoss) {
      return { shouldSell: true, newStopLoss };
    }
  }
  return { shouldSell: false };
}

// ... (שאר הפונקציות שלך נשארות ללא שינוי, הוספתי pushUpdate בתוך checkAndUpdatePrices וגם ב-sellStock)

// ====== ROUTES ======
app.get('/', (req, res) => {
  res.send('RiskWise Auto-Trader API Online (HF Inference + SSE)');
});

app.post('/update-portfolio', (req, res) => {
  const { userId, stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment } = req.body;
  if (!userId || !stocks || !userEmail || !portfolioRiskLevel || !totalInvestment) {
    return res.status(400).json({ error: 'חסרים נתונים נדרשים' });
  }

  userPortfolios[userId] = {
    stocks,
    alpacaKeys,
    userEmail,
    portfolioRiskLevel,
    totalInvestment,
    userNotifications: []
  };

  log.info(`📁 תיק עודכן עבור משתמש ${userId}`);
  res.json({ message: 'התיק נשמר בהצלחה' });
});

app.get('/portfolio/:userId', (req, res) => {
  const portfolio = userPortfolios[req.params.userId];
  if (!portfolio) return res.status(404).json({ error: 'תיק לא נמצא' });
  res.json(portfolio);
});

// ====== JOBS ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log.info(`✅ Server started on port ${PORT}`);
  setInterval(checkAndUpdatePrices, 5 * 60 * 1000);
});

cron.schedule('0 14 * * 5', () => {
  log.info('📆 ריצת חישוב שבועית (שישי)');
  checkAndUpdatePrices();
});

cron.schedule('0 10 * * *', () => {
  log.info('📊 בדיקת דוחות כספיים יומית');
  checkEarningsReports();
});

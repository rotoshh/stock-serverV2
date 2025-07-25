require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const OpenAI = require('openai');
const { sendEmail } = require('./utils/emailService'); // ✅ נוספה השורה הזו
const log = console;

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- מאגרי נתונים בזיכרון ---
const userPortfolios = {};
const userPrices = {};

// --- תבנית לפרומפט ---
const PROMPT_TEMPLATE = `בצע ניתוח סיכון מתקדם וכמותי ברמה מוסדית עבור המניה {TICKER} כדי לקבוע ציון סיכון מדויק.

*פרטי השקעה:*
- מחיר נוכחי: {CURRENT_PRICE}
- כמות: {QUANTITY}
- סכום מושקע: {AMOUNT_INVESTED}
- סקטור: {SECTOR}
...
*תן ציון סיכון סופי מ-1 עד 10 מבוסס על ניתוח כמותי מדויק.*`;

async function calculateAdvancedRisk(stockData) {
  try {
    const prompt = PROMPT_TEMPLATE
      .replace('{TICKER}', stockData.ticker)
      .replace('{CURRENT_PRICE}', stockData.currentPrice)
      .replace('{QUANTITY}', stockData.quantity)
      .replace('{AMOUNT_INVESTED}', stockData.amountInvested)
      .replace('{SECTOR}', stockData.sector || 'לא מוגדר');

    log.info(`Requesting risk analysis for ${stockData.ticker}`);

    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    log.info(`Risk score for ${stockData.ticker}: ${result.risk_score}`);

    return result;
  } catch (error) {
    log.error(`Error in risk calculation for ${stockData.ticker}: ${error.message}`);
    return null;
  }
}

async function updateStopLossAndNotify(userId, stockSymbol, portfolio, riskData, currentPrice) {
  const oldStopLoss = portfolio.stocks[stockSymbol].stopLoss || 0;
  const riskLevelPercent = portfolio.portfolioRiskLevel || 10;
  const newStopLoss = currentPrice * (1 - riskLevelPercent / 100);

  if (Math.abs(newStopLoss - oldStopLoss) > 0.01) {
    portfolio.stocks[stockSymbol].stopLoss = newStopLoss;

    // ✅ שליחת מייל דרך Gmail
    await sendEmail({
      to: portfolio.userEmail,
      subject: `📉 התראת Stop Loss עבור ${stockSymbol}`,
      html: `
        <h1>התראה ממערכת RiskWise</h1>
        <p>הסטופ לוס של <strong>${stockSymbol}</strong> עודכן ל: <strong>$${newStopLoss.toFixed(2)}</strong></p>
        <p>בהצלחה במסחר,</p>
        <p>צוות RiskWise</p>
      `
    });

    if (!portfolio.userNotifications) portfolio.userNotifications = [];
    portfolio.userNotifications.push({
      id: Date.now() + Math.random(),
      type: 'stop_loss_update',
      message: `סטופ לוס חדש למניה ${stockSymbol}: $${newStopLoss.toFixed(2)}`,
      timestamp: new Date().toISOString(),
      stockTicker: stockSymbol,
      newStopLoss,
      read: false
    });

    if (currentPrice <= newStopLoss) {
      return { shouldSell: true, newStopLoss };
    }
  }
  return { shouldSell: false };
}

app.post('/update-portfolio', (req, res) => {
  const { userId, stocks, alpacaKeys, userEmail, portfolioRiskLevel, totalInvestment } = req.body;

  if (!userId || !stocks || !userEmail || !portfolioRiskLevel || !totalInvestment) {
    return res.status(400).json({ error: 'חסרים נתונים נדרשים (userId, stocks, userEmail, portfolioRiskLevel, totalInvestment)' });
  }

  userPortfolios[userId] = {
    stocks,
    alpacaKeys,
    userEmail,
    portfolioRiskLevel,
    totalInvestment,
    userNotifications: []
  };

  log.info(`תיק עודכן עבור משתמש ${userId}`);
  res.json({ message: 'התיק נשמר בהצלחה' });
});

async function checkAndUpdatePrices() {
  for (const userId in userPortfolios) {
    const portfolio = userPortfolios[userId];
    if (!userPrices[userId]) userPrices[userId] = {};

    for (const symbol in portfolio.stocks) {
      try {
        const price = +(100 + Math.random() * 50).toFixed(2);

        const prevPrice = userPrices[userId][symbol]?.price || null;
        userPrices[userId][symbol] = { price, time: Date.now() };

        log.info(`${userId} - ${symbol}: $${price} (סטופ לוס: ${portfolio.stocks[symbol].stopLoss})`);

        let shouldRecalculateRisk = false;
        if (prevPrice === null) shouldRecalculateRisk = true;
        else {
          const changePercent = Math.abs(price - prevPrice) / prevPrice * 100;
          if (changePercent >= 5) shouldRecalculateRisk = true;
        }

        if (shouldRecalculateRisk) {
          const stockData = {
            ticker: symbol,
            currentPrice: price,
            quantity: portfolio.stocks[symbol].quantity || 1,
            amountInvested: portfolio.stocks[symbol].amountInvested || price * (portfolio.stocks[symbol].quantity || 1),
            sector: portfolio.stocks[symbol].sector || 'לא מוגדר'
          };

          const riskResult = await calculateAdvancedRisk(stockData);

          if (riskResult) {
            const { shouldSell, newStopLoss } = await updateStopLossAndNotify(userId, symbol, portfolio, riskResult, price);

            if (shouldSell) {
              await sellStock(userId, symbol, portfolio.stocks[symbol].quantity, price);
              log.info(`מכירת מניה ${symbol} למשתמש ${userId} במחיר $${price} בעקבות סטופ לוס`);
            }
          }
        }
      } catch (err) {
        log.error(`שגיאה בעדכון מחיר עבור ${symbol} למשתמש ${userId}: ${err.message}`);
      }
    }
  }
}

async function sellStock(userId, symbol, quantity, price) {
  const portfolio = userPortfolios[userId];
  if (!portfolio || !portfolio.alpacaKeys) {
    log.warn(`אין מפתחות Alpaca למשתמש ${userId} - לא מבצעים מכירה אמיתית`);
    portfolio.userNotifications.push({
      id: Date.now() + Math.random(),
      type: 'simulated_sell',
      message: `בוצעה סימולציית מכירה למניה ${symbol} בכמות ${quantity} במחיר $${price}`,
      timestamp: new Date().toISOString(),
      stockTicker: symbol,
      read: false
    });
    return;
  }

  try {
    const { key, secret } = portfolio.alpacaKeys;
    const alpacaApi = axios.create({
      baseURL: 'https://paper-api.alpaca.markets',
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret,
      }
    });

    await alpacaApi.post('/v2/orders', {
      symbol,
      qty: quantity,
      side: 'sell',
      type: 'market',
      time_in_force: 'day'
    });

    log.info(`מכירה בוצעה ב-Alpaca עבור ${symbol} - כמות: ${quantity}`);
    portfolio.userNotifications.push({
      id: Date.now() + Math.random(),
      type: 'sell_order',
      message: `בוצעה מכירה אוטומטית למניה ${symbol} בכמות ${quantity}`,
      timestamp: new Date().toISOString(),
      stockTicker: symbol,
      read: false
    });

  } catch (error) {
    log.error(`שגיאה במכירה ב-Alpaca עבור ${symbol}: ${error.message}`);
  }
}

app.get('/', (req, res) => {
  res.send('RiskWise Auto-Trader API Online');
});

app.get('/portfolio/:userId', (req, res) => {
  const portfolio = userPortfolios[req.params.userId];
  if (!portfolio) return res.status(404).json({ error: 'תיק לא נמצא' });
  res.json(portfolio);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log.info(`Server started on port ${PORT}`);
  setInterval(checkAndUpdatePrices, 5 * 60 * 1000);
});

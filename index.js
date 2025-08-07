require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const OpenAI = require('openai');
const cron = require('node-cron');
const { getRealTimePrice: getAlpacaPrice } = require('./alpacaPriceFetcher');
const { getRealTimePrice: getFinnhubPrice } = require('./finnhubPriceFetcher');
const { sendEmail } = require('./emailService');
const { sendPushNotification } = require('./pushServices');
const log = console;

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const userPortfolios = {};
const userPrices = {};
const priceHistory15Min = {};
const userRiskCache = {};

const PROMPT_TEMPLATE = `בצע ניתוח סיכון מתקדם וכמותי ברמה מוסדית עבור המניה {TICKER} כדי לקבוע ציון סיכון מדויק.
*פרטי השקעה:*
- מחיר נוכחי: {CURRENT_PRICE}
- כמות: {QUANTITY}
- סכום מושקע: {AMOUNT_INVESTED}
- סקטור: {SECTOR}
...
*תן ציון סיכון סופי מ-1 עד 10 מבוסס על ניתוח כמותי מדויק.*`;

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

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    userRiskCache[userId][ticker] = {
      price: currentPrice,
      result,
      timestamp: Date.now()
    };

    log.info(`✅ Risk score for ${ticker}: ${result.risk_score}`);
    return result;
  } catch (error) {
    log.error(`❌ Error in risk calculation for ${stockData.ticker}: ${error.message}`);
    return null;
  }
}

async function sendAllNotifications(userId, portfolio, notification) {
  if (!portfolio.userNotifications) portfolio.userNotifications = [];
  portfolio.userNotifications.push(notification);
  await sendPushNotification(userId, notification.message);
}

async function updateStopLossAndNotify(userId, stockSymbol, portfolio, riskData, currentPrice) {
  const oldStopLoss = portfolio.stocks[stockSymbol].stopLoss || 0;
  const riskLevelPercent = portfolio.portfolioRiskLevel || 10;
  const newStopLoss = currentPrice * (1 - riskLevelPercent / 100);

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

    if (currentPrice <= newStopLoss) {
      return { shouldSell: true, newStopLoss };
    }
  }
  return { shouldSell: false };
}

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

async function sellStock(userId, symbol, quantity, price) {
  const portfolio = userPortfolios[userId];
  if (!portfolio || !portfolio.alpacaKeys) {
    const msg = `📢 הגיע הזמן למכור את ${symbol} לפי סימולציה`;
    log.warn(`🚫 אין Alpaca למשתמש ${userId} - ${msg}`);
    await sendAllNotifications(userId, portfolio, {
      id: Date.now() + Math.random(),
      type: 'simulated_sell',
      message: msg,
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

    const msg = `💸 בוצעה מכירה אוטומטית למניה ${symbol} בכמות ${quantity}`;
    log.info(msg);
    await sendAllNotifications(userId, portfolio, {
      id: Date.now() + Math.random(),
      type: 'sell_order',
      message: msg,
      timestamp: new Date().toISOString(),
      stockTicker: symbol,
      read: false
    });

  } catch (error) {
    log.error(`❌ שגיאה במכירה ב-Alpaca עבור ${symbol}: ${error.message}`);
  }
}

async function checkFifteenMinuteDrop(userId, symbol, currentPrice, portfolio) {
  if (!priceHistory15Min[userId]) priceHistory15Min[userId] = {};
  const now = Date.now();
  const history = priceHistory15Min[userId][symbol];

  if (history && now - history.time <= 15 * 60 * 1000) {
    const change = ((currentPrice - history.price) / history.price) * 100;
    if (change <= -5) {
      log.info(`📉 ירידה של ${change.toFixed(2)}% ב-15 דקות במניה ${symbol} למשתמש ${userId}`);

      const stockData = {
        ticker: symbol,
        currentPrice,
        quantity: portfolio.stocks[symbol].quantity || 1,
        amountInvested: portfolio.stocks[symbol].amountInvested || currentPrice * (portfolio.stocks[symbol].quantity || 1),
        sector: portfolio.stocks[symbol].sector || 'לא מוגדר'
      };

      const riskResult = await calculateAdvancedRisk(stockData, userId);
      if (riskResult) {
        const { shouldSell } = await updateStopLossAndNotify(userId, symbol, portfolio, riskResult, currentPrice);
        const message = `⚠️ ירידה של 5% ב-15 דקות במניה ${symbol} - ${shouldSell ? 'בוצעה מכירה!' : 'סטופ לוס עודכן'}`;
        await sendPushNotification(userId, message);

        if (shouldSell) {
          await sellStock(userId, symbol, portfolio.stocks[symbol].quantity, currentPrice);
        }
      }
    }
  }

  priceHistory15Min[userId][symbol] = { price: currentPrice, time: now };
}

async function checkEarningsReports() {
  const today = new Date().toISOString().split('T')[0];

  for (const userId in userPortfolios) {
    const portfolio = userPortfolios[userId];
    for (const symbol in portfolio.stocks) {
      try {
        const response = await axios.get('https://finnhub.io/api/v1/calendar/earnings', {
          params: { symbol, from: today, to: today, token: process.env.FINNHUB_API_KEY }
        });

        const earningsToday = response.data?.earningsCalendar?.some(r => r.symbol === symbol);
        if (earningsToday) {
          log.info(`📢 ${symbol} - דוח כספי היום. מחשבים סיכון מחדש...`);
          const price = await getFinnhubPrice(symbol);
          const stockData = {
            ticker: symbol,
            currentPrice: price,
            quantity: portfolio.stocks[symbol].quantity || 1,
            amountInvested: portfolio.stocks[symbol].amountInvested || price * (portfolio.stocks[symbol].quantity || 1),
            sector: portfolio.stocks[symbol].sector || 'לא מוגדר'
          };

          const riskResult = await calculateAdvancedRisk(stockData, userId);
          if (riskResult) {
            await updateStopLossAndNotify(userId, symbol, portfolio, riskResult, price);
            await sendPushNotification(userId, `📢 עדכון סיכון למניה ${symbol} בעקבות דוחות כספיים`);
          }
        }
      } catch (err) {
        log.error(`❌ שגיאה בבדיקת דוחות כספיים עבור ${symbol}: ${err.message}`);
      }
    }
  }
}

async function checkAndUpdatePrices() {
  for (const userId in userPortfolios) {
    const portfolio = userPortfolios[userId];
    if (!userPrices[userId]) userPrices[userId] = {};

    for (const symbol in portfolio.stocks) {
      try {
        let price;
        if (portfolio.alpacaKeys?.key && portfolio.alpacaKeys?.secret) {
          price = await getAlpacaPrice(symbol, portfolio.alpacaKeys.key, portfolio.alpacaKeys.secret);
        } else {
          price = await getFinnhubPrice(symbol);
        }

        const prevPrice = userPrices[userId][symbol]?.price || null;
        userPrices[userId][symbol] = { price, time: Date.now() };
        log.info(`${userId} - ${symbol}: $${price} (סטופ לוס: ${portfolio.stocks[symbol].stopLoss})`);

        if (!portfolio.stocks[symbol].stopLoss) {
          const stockData = {
            ticker: symbol,
            currentPrice: price,
            quantity: portfolio.stocks[symbol].quantity || 1,
            amountInvested: portfolio.stocks[symbol].amountInvested || price * (portfolio.stocks[symbol].quantity || 1),
            sector: portfolio.stocks[symbol].sector || 'לא מוגדר'
          };

          const riskResult = await calculateAdvancedRisk(stockData, userId);
          if (riskResult) {
            const { shouldSell } = await updateStopLossAndNotify(userId, symbol, portfolio, riskResult, price);
            if (shouldSell) {
              await sellStock(userId, symbol, portfolio.stocks[symbol].quantity, price);
              await sendPushNotification(userId, `💸 מכירה בוצעה אוטומטית: ${symbol} במחיר $${price}`);
            }
          }
        }

        await checkFifteenMinuteDrop(userId, symbol, price, portfolio);

        const changePercent = prevPrice ? Math.abs(price - prevPrice) / prevPrice * 100 : 0;
        if (changePercent >= 5) {
          const stockData = {
            ticker: symbol,
            currentPrice: price,
            quantity: portfolio.stocks[symbol].quantity || 1,
            amountInvested: portfolio.stocks[symbol].amountInvested || price * (portfolio.stocks[symbol].quantity || 1),
            sector: portfolio.stocks[symbol].sector || 'לא מוגדר'
          };

          const riskResult = await calculateAdvancedRisk(stockData, userId);
          if (riskResult) {
            const { shouldSell } = await updateStopLossAndNotify(userId, symbol, portfolio, riskResult, price);
            if (shouldSell) {
              await sellStock(userId, symbol, portfolio.stocks[symbol].quantity, price);
              await sendPushNotification(userId, `💸 מכירה בוצעה אוטומטית: ${symbol} במחיר $${price}`);
            }
          }
        }
      } catch (err) {
        log.error(`❌ שגיאה בעדכון מחיר עבור ${symbol}: ${err.message}`);
      }
    }
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
  log.info(`✅ Server started on port ${PORT}`);
  setInterval(checkAndUpdatePrices, 5 * 60 * 1000); // כל 5 דקות
});

cron.schedule('0 14 * * 5', () => {
  log.info('📆 ריצת חישוב שבועית (שישי)');
  checkAndUpdatePrices();
});

cron.schedule('0 10 * * *', () => {
  log.info('📊 בדיקת דוחות כספיים יומית');
  checkEarningsReports();
});

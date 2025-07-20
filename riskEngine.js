
const OpenAI = require('openai');
const { SendEmail } = require('@/integrations/Core'); // כפי שהצעת
const axios = require('axios');
const log = require('./logger');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// הפרומפט שהבאת
const PROMPT_TEMPLATE = `בצע ניתוח סיכון מתקדם וכמותי ברמה מוסדית עבור המניה {TICKER} כדי לקבוע ציון סיכון מדויק.

*פרטי השקעה:*
- מחיר נוכחי: {CURRENT_PRICE}
- כמות: {QUANTITY}
- סכום מושקע: {AMOUNT_INVESTED}
- סקטור: {SECTOR}

*בצע ניתוח כמותי מלא לפי הפרמטרים הבאים:*

(כאן שים את כל הטקסט כפי ששלחת... עד לסוף)

*תן ציון סיכון סופי מ-1 עד 10 מבוסס על ניתוח כמותי מדויק.*`;

async function calculateAdvancedRisk(stockData) {
  try {
    const prompt = PROMPT_TEMPLATE
      .replace('{TICKER}', stockData.ticker)
      .replace('{CURRENT_PRICE}', stockData.currentPrice)
      .replace('{QUANTITY}', stockData.quantity)
      .replace('{AMOUNT_INVESTED}', stockData.amountInvested)
      .replace('{SECTOR}', stockData.sector || 'לא מוגדר');

    log.info(📊 Requesting risk analysis for ${stockData.ticker});

    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    log.info(📈 Risk score for ${stockData.ticker}: ${result.risk_score});

    return result;
  } catch (error) {
    log.error(❌ Error in risk calculation for ${stockData.ticker}: ${error.message});
    return null;
  }
}

async function sendStopLossEmail(userEmail, stockTicker, newStopLoss) {
  try {
    await SendEmail({
      to: userEmail,
      from_name: "RiskWise Auto-Trader",
      subject: 📢 התראת Stop-Loss אוטומטית עבור ${stockTicker},
      body: `
        <h1>עדכון סטופ-לוס אוטומטי</h1>
        <p>שלום,</p>
        <p>מערכת הניטור האוטומטית זיהתה שינוי משמעותי במניית <strong>${stockTicker}</strong>.</p>
        <p>בהתאם, חושב ונקבע מחיר Stop-Loss חדש: <strong>$${newStopLoss.toFixed(2)}</strong>.</p>
        <p>צוות RiskWise</p>
      `
    });
    log.info(✅ Email alert sent to ${userEmail} for ${stockTicker});
  } catch (error) {
    log.error(❌ Failed to send email alert for ${stockTicker} to ${userEmail}: ${error.message});
  }
}

async function updateStopLossAndNotify(userId, stockSymbol, portfolio, riskData, currentPrice) {
  const oldStopLoss = portfolio.stocks[stockSymbol].stopLoss || 0;
  // נניח סטופ לוס מחושב כ: price * (1 - riskLevel/100) לדוגמה, אפשר להחליף בלוגיקה אחרת
  const riskLevelPercent = portfolio.portfolioRiskLevel || 10;
  const newStopLoss = currentPrice * (1 - riskLevelPercent / 100);

  // אם סטופ לוס השתנה מהותית (למשל יותר מ-0.1$ או אחוז כלשהו), עדכן
  if (Math.abs(newStopLoss - oldStopLoss) > 0.01) {
    portfolio.stocks[stockSymbol].stopLoss = newStopLoss;

    // שלח מייל התראה
    await sendStopLossEmail(portfolio.userEmail, stockSymbol, newStopLoss);

    // שלח התראה פנימית
    if (!portfolio.userNotifications) portfolio.userNotifications = [];
    portfolio.userNotifications.push({
      id: Date.now() + Math.random(),
      type: 'stop_loss_update',
      message: סטופ לוס חדש למניה ${stockSymbol}: $${newStopLoss.toFixed(2)},
      timestamp: new Date().toISOString(),
      stockTicker: stockSymbol,
      newStopLoss,
      read: false
    });

    // אם המחיר הנוכחי נמוך מהסטופ לוס החדש - בצע מכירה מיידית
    if (currentPrice <= newStopLoss) {
      // כאן נעביר טיפול למכירה ב- index.js
      return { shouldSell: true, newStopLoss };
    }
  }
  return { shouldSell: false };
}

module.exports = {
  calculateAdvancedRisk,
  updateStopLossAndNotify,
};

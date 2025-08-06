const axios = require('axios');

async function getRealTimePrice(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`;
  try {
    const response = await axios.get(url);
    return response.data.c; // מחיר נוכחי
  } catch (error) {
    console.error(`שגיאה בשליפת מחיר מ-Finnhub עבור ${symbol}:`, error.message);
    throw error;
  }
}

module.exports = { getRealTimePrice };


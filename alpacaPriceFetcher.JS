const axios = require('axios');

async function getRealTimePrice(symbol, key, secret) {
  try {
    const api = axios.create({
      baseURL: 'https://data.alpaca.markets/v2',
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret
      }
    });

    const res = await api.get(`/stocks/${symbol}/quotes/latest`);
    const price = res.data?.quote?.ap || null;

    if (!price) throw new Error(`No price found for ${symbol}`);
    return price;

  } catch (err) {
    console.error(`❌ שגיאה בשליפת מחיר אמיתי עבור ${symbol}:`, err.message);
    return null;
  }
}

module.exports = {
  getRealTimePrice
};
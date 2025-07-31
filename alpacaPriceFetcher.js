const axios = require('axios');

async function getRealTimePrice(ticker, alpacaKey, alpacaSecret) {
  try {
    const alpacaApi = axios.create({
      baseURL: 'https://data.alpaca.markets/v2',
      headers: {
        'APCA-API-KEY-ID': alpacaKey,
        'APCA-API-SECRET-KEY': alpacaSecret,
      }
    });

    const response = await alpacaApi.get(`/stocks/${ticker}/quotes/latest`);
    const price = response.data.quote?.ap;

    if (!price) {
      throw new Error(`אין מחיר זמין למניה ${ticker}`);
    }

    return +price.toFixed(2);
  } catch (error) {
    console.error(`שגיאה בשליפת מחיר עבור ${ticker} מ-Alpaca: ${error.message}`);
    throw error;
  }
}

module.exports = { getRealTimePrice };
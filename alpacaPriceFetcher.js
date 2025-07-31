// alpacaPriceFetcher.js
const axios = require('axios');

async function getRealTimePrice(symbol, alpacaKey, alpacaSecret) {
  const api = axios.create({
    baseURL: 'https://data.alpaca.markets/v2',
    headers: {
      'APCA-API-KEY-ID': alpacaKey,
      'APCA-API-SECRET-KEY': alpacaSecret
    }
  });

  const response = await api.get(`/stocks/${symbol}/quotes/latest`);
  return response.data.quote.ap; // מחיר בקשת קנייה
}

module.exports = { getRealTimePrice };

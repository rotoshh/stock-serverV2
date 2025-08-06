const finnhub = require('finnhub');

const api_key = finnhub.ApiClient.instance.authentications['api_key'];
api_key.apiKey = process.env.FINNHUB_API_KEY;

const finnhubClient = new finnhub.DefaultApi();

/**
 * מחזיר את המחיר הנוכחי של מניה לפי הסימול שלה
 * @param {string} symbol - סימול המניה (למשל "AAPL")
 * @returns {Promise<number>} המחיר הנוכחי
 */
function getRealTimePrice(symbol) {
  return new Promise((resolve, reject) => {
    finnhubClient.quote(symbol, (error, data) => {
      if (error) return reject(error);
      if (!data || typeof data.c !== 'number') {
        return reject(new Error(`Price not available for ${symbol}`));
      }
      resolve(data.c); // המחיר הנוכחי
    });
  });
}

module.exports = { getRealTimePrice };

const axios = require('axios');

async function generateJSONFromBase44(prompt) {
  try {
    const response = await axios.post(
      process.env.BASE44_API_URL, // ה-URL של המודל שלך
      { prompt },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.BASE44_API_KEY}` // אם יש לך מפתח גישה
        }
      }
    );

    // נניח שהתשובה מגיעה בתור אובייקט JSON עם מבנה דומה ל-HF
    const text = response.data.output || response.data.result || '';
    return JSON.parse(text);
  } catch (err) {
    console.error('❌ Error from Base44 model:', err.message);
    throw err;
  }
}

module.exports = { generateJSONFromBase44 };
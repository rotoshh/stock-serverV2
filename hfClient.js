// hfClient.js
const axios = require('axios');

/**
 * פונקציה שמבצעת קריאה ל-Hugging Face Inference API
 * מקבלת טקסט prompt ומחזירה JSON מנותח
 */
async function generateJSONFromHF(prompt) {
  try {
    const response = await axios.post(
      "https://api-inference.huggingface.co/models/tiiuae/falcon-7b-instruct",
      { inputs: prompt },
      {
        headers: {
          Authorization: `Bearer ${process.env.HF_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 60000 // טיים-אאוט של דקה
      }
    );

    const data = response.data;

    // במקרה שהמודל מחזיר טקסט ארוך
    const generated = Array.isArray(data)
      ? data[0]?.generated_text || ""
      : data.generated_text || "";

    // מנסים לפרסר ל-JSON
    try {
      return JSON.parse(generated);
    } catch (e) {
      console.error("⚠️ Failed to parse JSON from Hugging Face output:", generated);
      return {};
    }
  } catch (err) {
    console.error("❌ Hugging Face API Error:", err.response?.status, err.response?.data || err.message);
    throw err;
  }
}

module.exports = { generateJSONFromHF };

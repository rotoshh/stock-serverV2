const axios = require("axios");

async function generateJSONFromHF(prompt) {
  try {
    const response = await axios.post(
      "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2",
      { inputs: prompt },
      {
        headers: {
          Authorization: `Bearer ${process.env.HF_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.error) {
      console.error("❌ Hugging Face API Error:", response.data.error);
      return {};
    }

    // במקרה שמודל מחזיר מערך של אובייקטים
    const raw = response.data[0]?.generated_text || "";
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.error("⚠️ JSON parse failed, raw output:", raw);
      return {};
    }
  } catch (err) {
    console.error("❌ Error in Hugging Face request:", err.response?.data || err.message);
    return {};
  }
}

module.exports = { generateJSONFromHF };

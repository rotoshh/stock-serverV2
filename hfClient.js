// hfClient.js
const axios = require('axios');

const HF_MODEL = process.env.HF_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3';
const HF_API_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;
const HF_API_KEY = process.env.HUGGINGFACE_API_KEY;

// המתנה (ל-retry כשהמודל "מתעורר")
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// חילוץ JSON טהור מהטקסט
function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in model response');
  const slice = text.slice(start, end + 1);
  return JSON.parse(slice);
}

// קריאה ל-HF Inference API + ניסיונות חוזרים אם המודל בטעינה (503)
async function generateJSONFromHF(prompt, retries = 3) {
  if (!HF_API_KEY) throw new Error('Missing HUGGINGFACE_API_KEY');

  try {
    const res = await axios.post(
      HF_API_URL,
      {
        // דגשים לפרומפט: מבקש JSON בלבד
        inputs: prompt,
        parameters: {
          max_new_tokens: 400,
          temperature: 0.2,
          return_full_text: false
        }
      },
      {
        headers: { Authorization: `Bearer ${HF_API_KEY}` },
        timeout: 30000
      }
    );

    const data = res.data;
    let text;
    if (Array.isArray(data) && data[0]?.generated_text) {
      text = data[0].generated_text;
    } else if (data?.generated_text) {
      text = data.generated_text;
    } else if (typeof data === 'string') {
      text = data;
    } else {
      throw new Error('Unexpected HF response shape');
    }

    return extractJSON(text);
  } catch (err) {
    // מודלים ב-HF לפעמים מחזירים 503 כשהם "מתעוררים"
    if (retries > 0 && (err.response?.status === 503 || /loading/i.test(err.message))) {
      await wait(3000);
      return generateJSONFromHF(prompt, retries - 1);
    }
    throw err;
  }
}

module.exports = { generateJSONFromHF };

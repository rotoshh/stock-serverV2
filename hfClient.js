import fetch from "node-fetch";

async function generateJSONFromHF(prompt) {
  try {
    const res = await fetch("https://api-inference.huggingface.co/models/your-model", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inputs: prompt })
    });

    if (!res.ok) {
      throw new Error(`HF API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();

    // אם המודל מחזיר טקסט, נניח שהוא בגוף הראשון
    const output = data[0]?.generated_text || "";
    return JSON.parse(output);
  } catch (err) {
    console.error("❌ Error in Hugging Face request:", err.message);
    return {};
  }
}

export { generateJSONFromHF };

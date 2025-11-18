import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@deepgram/sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Gemini + Deepgram clients
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// -------------------------------------------------------------
// Fetch Claricall Knowledgebase Content (using axios + auth)
// -------------------------------------------------------------
async function loadKnowledgebase() {
  try {
    const resp = await axios.get(
      "https://api.claricall.space/api/organization/knowledgebase/68d3c1bbcf0bcde3eac2606b",
      {
        headers: {
          Authorization: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4ZDNjMWJiY2YwYmNkZTNlYWMyNjA2OSIsImlhdCI6MTc2MzE5MzYyNywiZXhwIjoxNzY1Nzg1NjI3fQ.ru7WvgFDRhHKuTKyUDvnDQoBhUC04HbnZltDDYy29vA`,
        },
      }
    );

    const json = resp.data;

    if (!json.success) return "";

    let finalText = "";

    json.data.forEach(entry => {
      if (!entry.preview || !entry.preview.products) return;

      entry.preview.products.forEach(product => {
        finalText += `
Product/Service: ${product.name}
Summary: ${product.summary}

Pricing:
${product.pricing.map(p => "- " + p.line).join("\n")}

FAQs:
${product.faqs.map(f => `Q: ${f.q}\nA: ${f.a}\n`).join("")}

Objections:
${product.objections.map(o => "- " + o.phrase).join("\n")}

Rebuttals:
${product.rebuttals
  .map(r => `${r.objectionPhrase}: ${r.rebuttal}`)
  .join("\n")}

Source: ${product.source}

-----------------------------
`;
      });
    });

    return finalText.trim();
  } catch (err) {
    console.error("Knowledgebase load error:", err.response?.data || err.message);
    return "";
  }
}

// Load KB on server start
let KNOWLEDGEBASE_DATA = "";
(async () => {
  KNOWLEDGEBASE_DATA = await loadKnowledgebase();
  console.log("Knowledgebase loaded. Length:", KNOWLEDGEBASE_DATA.length);
})();

// -------------------------------------------------------------
// System prompt generator
// -------------------------------------------------------------
function buildSystemPrompt() {
  return `
You are a TTS-friendly sales assistant.

Answer ONLY using the product and service information below.
Speak in short natural sentences. No emojis. No markdown.

Knowledgebase:
${KNOWLEDGEBASE_DATA}
`;
}

// -------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("agent api is running.");
});

// -------------------------------------------------------------
// TTS Streaming Endpoint
// -------------------------------------------------------------
app.post("/stream-tts", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) return res.status(400).json({ error: "Missing text" });

    const SYSTEM_PROMPT = buildSystemPrompt();

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContentStream(`${SYSTEM_PROMPT}\n\nUser: ${text}`);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Transfer-Encoding", "chunked");

    let buffer = "";

    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      if (!chunkText) continue;

      buffer += chunkText;

      if (buffer.includes(".") || buffer.length > 60) {
        await streamDeepgramTTS(buffer, res);
        buffer = "";
      }
    }

    if (buffer.trim()) await streamDeepgramTTS(buffer, res);

    res.end();
  } catch (err) {
    console.error("Streaming error:", err);
    res.status(500).json({ error: "Streaming failed" });
  }
});

// -------------------------------------------------------------
// Deepgram TTS helper
// -------------------------------------------------------------
async function streamDeepgramTTS(text, res) {
  const response = await deepgram.speak.request(
    { text },
    {
      model: "aura-2-thalia-en",
      encoding: "linear16",
      container: "wav",
    }
  );

  const stream = await response.getStream();
  if (!stream) return;

  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) res.write(Buffer.from(value));
  }
}

app.listen(8080, () =>
  console.log("✅ Claricall-KB → Gemini → Deepgram TTS API running")
);

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@deepgram/sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Gemini + Deepgram clients
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

const SYSTEM_PROMPT = `
You are a concise, TTS-friendly sales assistant. You help users by giving brief, clear responses about the iPhone 17. Speak in short, natural sentences without markdown, emojis, or special characters. Each partial response should still make sense if spoken on its own.
`;

app.get("/", (req, res) => {
  res.send("agent api is running.");
});

// ---------------------------------------------------------------------
// Endpoint: stream Gemini output as TTS audio via Deepgram
// ---------------------------------------------------------------------
app.post("/stream-tts", async (req, res) => {
  try {
    const { text } = req.body;
    console.log("Received text:", text);
    if (!text) return res.status(400).json({ error: "Missing text" });

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContentStream(`${SYSTEM_PROMPT}\n\n${text}`);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Transfer-Encoding", "chunked");

    let buffer = "";

    // process Gemini chunks as they stream
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      if (!chunkText) continue;

      buffer += chunkText;

      // send after each sentence or ~60 chars
      if (buffer.includes(".") || buffer.length > 60) {
        console.log("Sending to Deepgram:", buffer);
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

// ---------------------------------------------------------------------
// Deepgram streaming TTS helper
// ---------------------------------------------------------------------
async function streamDeepgramTTS(text, res) {
  const response = await deepgram.speak.request(
    { text },
    {
      model: "aura-2-thalia-en", // any Deepgram TTS voice model
      encoding: "linear16",      // PCM format
      container: "wav",          // output container
    }
  );

  const stream = await response.getStream();
  console.log("response from Deepgram for text:", response);
  if (!stream) {
    console.error("No stream from Deepgram");
    return;
  }

  // pipe Deepgram audio stream directly to HTTP response
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) res.write(Buffer.from(value));
  }
}

app.listen(8080, () =>
  console.log("✅ Gemini → Deepgram TTS streaming backend running")
);

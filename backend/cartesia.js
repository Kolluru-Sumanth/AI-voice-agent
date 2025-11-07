import express from "express";
import { CartesiaClient } from "@cartesia/cartesia-js";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.raw({ type: "audio/wav", limit: "10mb" }));

const client = new CartesiaClient({ apiKey: process.env.CARTESIA_API_KEY });

// TTS endpoint
app.post("/api/tts", async (req, res) => {
  try {
    const { text } = req.body;
    const response = await client.tts.bytes({
      modelId: "sonic-3",
      voice: { mode: "id", id: "694f9389-aac1-45b6-b726-9d9369183238" },
      outputFormat: { container: "wav", encoding: "pcm_s16le", sampleRate: 44100 },
      transcript: text,
    });

    const buffer = Buffer.from(await new Response(response).arrayBuffer());
    res.setHeader("Content-Type", "audio/wav");
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "TTS generation failed" });
  }
});

// STT endpoint
app.post("/api/stt", async (req, res) => {
  try {
    const audioBuffer = req.body;  
    const form = new FormData();
    form.append("file", audioBuffer, {
      filename: "audio.wav",
      contentType: "audio/wav"
    });
    form.append("model", "ink-whisper");
    form.append("language", "en");
    // If you want word-level timestamps:
    form.append("timestamp_granularities[]", "word");

    const response = await fetch("https://api.cartesia.ai/stt", {
      method: "POST",
      headers: {
        "X-API-Key": process.env.CARTESIA_API_KEY,
        // Note: Content‐Type is set automatically by FormData
      },
      body: form
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Cartesia STT error response:", errText);
      return res.status(response.status).json({ error: "Transcription failed", details: errText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("STT transcription exception:", error);
    res.status(500).json({ error: "STT transcription failed" });
  }
});


app.listen(3000, () => console.log("Server running on port 3000"));

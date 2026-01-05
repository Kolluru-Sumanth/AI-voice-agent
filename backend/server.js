import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import axios from "axios";
import { encoding_for_model } from "@dqbd/tiktoken";
import * as sdk from "microsoft-cognitiveservices-speech-sdk";

dotenv.config();

// ---------------------------------------------
// CONFIG
// ---------------------------------------------
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SPEECH_KEY = process.env.SPEECH_KEY;
const SPEECH_REGION = process.env.SPEECH_REGION;

// Tokenizer
const enc = encoding_for_model("gpt-4o");

function countTokens(text) {
  return enc.encode(text).length;
}

function countWords(text) {
  return text.trim().split(/\s+/).length;
}

// ---------------------------------------------
// KNOWLEDGE (Original logic preserved)
// ---------------------------------------------
const SYSTEM_PROMPT = `
You are a helpful AI assistant for a voice-based medical appointment system.
Respond clearly and concisely, optimized for spoken output.
Answer ONLY using the information provided below...
{
    "name": "City Care Hospital",
    "location": "Hyderabad",
    "doctors": [
        { "name": "Dr. Anjali Rao", "specialization": "Cardiologist", "timings": "Mon–Fri, 10 AM to 4 PM", "available": true, "fee": 500 },
        { "name": "Dr. Ramesh Gupta", "specialization": "Orthopedic", "timings": "Tue–Sat, 9 AM to 1 PM", "available": false, "fee": 300 }
    ]
}
`;

// ---------------------------------------------
// START WEBSOCKET SERVER
// ---------------------------------------------
const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", async (clientWs) => {
  console.log("Frontend connected");

  const conversation = [{ role: "system", content: SYSTEM_PROMPT }];

  // ---------------------------------------------
  // Azure Neural TTS Setup
  // ---------------------------------------------
  const speechConfig = sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);

  // Configure for raw PCM audio to match your frontend playback logic
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm;
  speechConfig.speechSynthesisVoiceName = "en-US-AvaMultilingualNeural";

  const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

  // Capture audio chunks from Azure and send to frontend
  synthesizer.synthesizing = (s, e) => {
    if (e.result.audioData && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: "ai_audio",
        audio: Buffer.from(e.result.audioData).toString('base64'),
      }));
    }
  };

  // ---------------------------------------------
  // Sarvam STT WebSocket (Original logic preserved)
  // ---------------------------------------------
  const sarvamWs = new WebSocket(
    "wss://api.sarvam.ai/speech-to-text/ws?language-code=unknown&model=saarika:v2.5&high_vad_sensitivity=false",
    [`api-subscription-key.${SARVAM_API_KEY}`]
  );

  sarvamWs.on("message", async (raw) => {
    const stt = JSON.parse(raw.toString());
    clientWs.send(raw.toString());

    const transcript = stt?.data?.transcript?.trim();
    if (!transcript) return;

    conversation.push({ role: "user", content: transcript });

    // Pass Azure synthesizer to the streaming function
    await queryOpenRouterStream(conversation, clientWs, synthesizer);
  });

  clientWs.on("message", (msg) => {
    if (sarvamWs.readyState === WebSocket.OPEN) {
      sarvamWs.send(msg.toString());
    }
  });

  clientWs.on("close", () => {
    sarvamWs.close();
    synthesizer.close();
  });
});

// --------------------------------------------------
// LLM STREAMING FUNCTION (Modified for Azure TTS)
// --------------------------------------------------
async function queryOpenRouterStream(conversation, clientWs, synthesizer) {
  try {
    const fullPromptText = conversation.map(m => m.content).join("\n");
    const inputTokens = countTokens(fullPromptText);
    const inputWords = countWords(fullPromptText);

    clientWs.send(JSON.stringify({ type: "token_usage", input_tokens: inputTokens, input_words: inputWords }));

    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model: "openai/gpt-4o", stream: true, messages: conversation },
      {
        responseType: "stream",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    let assistantFullResponse = "";
    let outputTokens = 0;
    let outputWords = 0;
    let sentenceBuffer = ""; // Buffers text to send full sentences to Azure

    response.data.on("data", (chunk) => {
      const lines = chunk.toString().split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.replace("data:", "").trim();

        if (jsonStr === "[DONE]") {
          // Speak any leftover text in the buffer
          if (sentenceBuffer.trim()) {
            synthesizer.speakTextAsync(sentenceBuffer.trim());
          }
          clientWs.send(JSON.stringify({ type: "ai_done" }));
          continue;
        }

        let parsed;
        try { parsed = JSON.parse(jsonStr); } catch { continue; }

        const delta = parsed?.choices?.[0]?.delta?.content;

        if (delta) {
          assistantFullResponse += delta;
          sentenceBuffer += delta;
          outputTokens += countTokens(delta);
          outputWords += countWords(delta);

          // 1. Send text to frontend immediately
          clientWs.send(JSON.stringify({ type: "ai_stream", text: delta }));

          // 2. Azure TTS Logic: Speak when we hit a sentence boundary
          // This ensures high-quality natural intonation
          if (/[.!?\n]/.test(delta)) {
            synthesizer.speakTextAsync(sentenceBuffer.trim());
            sentenceBuffer = ""; // Clear buffer
          }
        }
      }
    });

    return new Promise((resolve) => {
      response.data.on("end", () => {
        if (assistantFullResponse.trim()) {
          conversation.push({ role: "assistant", content: assistantFullResponse });
        }

        clientWs.send(JSON.stringify({
          type: "token_usage_final",
          output_tokens: outputTokens,
          output_words: outputWords,
          total_tokens: inputTokens + outputTokens
        }));
        resolve("STREAM_DONE");
      });
    });

  } catch (err) {
    console.log(err);
    clientWs.send(JSON.stringify({ type: "ai_error", text: "Error contacting AI model." }));
  }
}
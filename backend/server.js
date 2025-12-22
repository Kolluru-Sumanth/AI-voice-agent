import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import axios from "axios";
import { encoding_for_model } from "@dqbd/tiktoken";
import { v4 as uuidv4 } from "uuid"; // Recommended for context IDs
dotenv.config();

// ---------------------------------------------
// CONFIG
// ---------------------------------------------
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
// Tokenizer
const enc = encoding_for_model("gpt-4o");

function countTokens(text) {
  return enc.encode(text).length;
}

function countWords(text) {
  return text.trim().split(/\s+/).length;
}

// ---------------------------------------------
// KNOWLEDGE
// ---------------------------------------------
const knowledge = {
  "hospitals": [
    {
      "name": "City Care Hospital",
      "location": "Hyderabad",
      "doctors": [
        {
          "name": "Dr. Anjali Rao",
          "specialization": "Cardiologist",
          "timings": "Mon–Fri, 10 AM to 4 PM",
          "available": true,
          "fee": 500
        },
        {
          "name": "Dr. Ramesh Gupta",
          "specialization": "Orthopedic",
          "timings": "Tue–Sat, 9 AM to 1 PM",
          "available": false,
          "fee": 300
        }
      ]
    }
  ]
};

const SYSTEM_PROMPT = `
You are a helpful AI assistant for a voice-based medical appointment system.

Respond clearly and concisely, optimized for spoken output.

Answer ONLY using the information provided below, which contains doctor details, specializations, hospital names, timings, and availability and appointment fees.

Your job is to help users:

Find suitable doctors
Check availability
Schedule, reschedule, or cancel appointments
Provide hospital or doctor information only if present in knowledge

If the user asks for something not in knowledge, say that the information is not available.

If the user asks something unclear, ask a clarification question.

Always reply in the same language the user uses.

Do not assume or invent any details.

Keep responses short, direct, and formatted for voice systems.

This is the knowledge provided to you:
{
    "name": "City Care Hospital",
    "location": "Hyderabad",
    "doctors": [
        {
            "name": "Dr. Anjali Rao",
            "specialization": "Cardiologist",
            "timings": "Mon–Fri, 10 AM to 4 PM",
            "available": true,
            "fee": 500
        },
        {
            "name": "Dr. Ramesh Gupta",
            "specialization": "Orthopedic",
            "timings": "Tue–Sat, 9 AM to 1 PM",
            "available": false,
            "fee": 300
        }
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
  // Cartesia TTS WebSocket Setup
  // ---------------------------------------------
  const cartesiaWs = new WebSocket(
    `wss://api.cartesia.ai/tts/websocket?api_key=${CARTESIA_API_KEY}&cartesia_version=2024-06-10`
  );

  cartesiaWs.on("open", () => console.log("Connected to Cartesia TTS"));

  cartesiaWs.on("message", (data) => {
    const response = JSON.parse(data);
    console.log("Cartesia raw response type:", response.type); // Add this log

    if (response.type === "chunk") {
      clientWs.send(JSON.stringify({
        type: "ai_audio",
        audio: response.data,
      }));
    } else if (response.type === "error") {
      console.error("Cartesia Error Details:", response.error); // Log the specific error
    }
  });

  // ---------------------------------------------
  // Sarvam STT WebSocket
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

    // Pass cartesiaWs to the streaming function
    await queryOpenRouterStream(conversation, clientWs, cartesiaWs);
  });

  clientWs.on("message", (msg) => {
    if (sarvamWs.readyState === WebSocket.OPEN) {
      sarvamWs.send(msg.toString());
    }
  });

  clientWs.on("close", () => {
    sarvamWs.close();
    cartesiaWs.close();
  });
});

// --------------------------------------------------
// LLM STREAMING FUNCTION (Modified to include TTS)
// --------------------------------------------------
async function queryOpenRouterStream(conversation, clientWs, cartesiaWs) {
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

    // Create a unique ID for this specific TTS "turn"
    const context_id = uuidv4();

    response.data.on("data", (chunk) => {
      const lines = chunk.toString().split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.replace("data:", "").trim();

        if (jsonStr === "[DONE]") {
          clientWs.send(JSON.stringify({ type: "ai_done" }));
          continue;
        }

        let parsed;
        try { parsed = JSON.parse(jsonStr); } catch { continue; }

        const delta = parsed?.choices?.[0]?.delta?.content;

        if (delta) {
          assistantFullResponse += delta;
          outputTokens += countTokens(delta);
          outputWords += countWords(delta);

          // 1. Send text to frontend
          clientWs.send(JSON.stringify({ type: "ai_stream", text: delta }));

          // 2. IMMEDIATELY send text delta to Cartesia
          // ... inside your delta loop ...
          if (cartesiaWs.readyState === WebSocket.OPEN) {
            cartesiaWs.send(JSON.stringify({
              model_id: "sonic-english", // or "sonic-3"
              voice: {
                mode: "id",
                id: "b7d50908-b17c-442d-ad8d-810c63997ed9", // Try 'California Girl'
              },
              output_format: {
                container: "raw",
                encoding: "pcm_s16le",
                sample_rate: 16000,
              },
              transcript: delta,
              context_id: context_id,
              continue: true
            }));
          }
        }
      }
    });

    return new Promise((resolve) => {
      response.data.on("end", () => {
        // Finalize the Cartesia stream for this context
        if (cartesiaWs.readyState === WebSocket.OPEN) {
          cartesiaWs.send(JSON.stringify({
            context_id: context_id,
            transcript: "",
            continue: false
          }));
        }

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
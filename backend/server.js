import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import axios from "axios";
import { encoding_for_model } from "@dqbd/tiktoken";

dotenv.config();

// ---------------------------------------------
// CONFIG
// ---------------------------------------------
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

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

  // Conversation memory for this client
  const conversation = [
    { role: "system", content: SYSTEM_PROMPT }
  ];

  // ---------------------------------------------
  // Sarvam STT WebSocket
  // ---------------------------------------------
  const sarvamWs = new WebSocket(
    "wss://api.sarvam.ai/speech-to-text/ws?language-code=unknown&model=saarika:v2.5&high_vad_sensitivity=false",
    [`api-subscription-key.${SARVAM_API_KEY}`]
  );

  sarvamWs.on("open", () => console.log("Connected to Sarvam STT"));
  sarvamWs.on("close", () => console.log("Sarvam WS closed"));
  sarvamWs.on("error", (err) => console.error("Sarvam WS Error:", err));

  // Incoming STT text
  sarvamWs.on("message", async (raw) => {
    const stt = JSON.parse(raw.toString());
    console.log("STT:", stt);
    // Forward STT to frontend
    clientWs.send(raw.toString());

    const transcript = stt?.data?.transcript?.trim();
    if (!transcript) return;

    console.log("Transcript:", transcript);

    // Add user message
    conversation.push({ role: "user", content: transcript });

    // Query model
    await queryOpenRouterStream(conversation, clientWs);
  });

  // Forward frontend audio → Sarvam
  clientWs.on("message", (msg) => {
    if (sarvamWs.readyState === WebSocket.OPEN) {
      sarvamWs.send(msg.toString());
    }
  });

  clientWs.on("close", () => {
    console.log("Frontend disconnected");
    sarvamWs.close();
  });
});

console.log("Backend WebSocket server running on ws://localhost:8080");


// --------------------------------------------------
//               LLM STREAMING FUNCTION
// --------------------------------------------------
async function queryOpenRouterStream(conversation, clientWs) {
  try {
    // ---------------------------------------------
    // INPUT TOKEN & WORD COUNT
    // ---------------------------------------------
    const fullPromptText = conversation.map(m => m.content).join("\n");

    const inputTokens = countTokens(fullPromptText);
    const inputWords = countWords(fullPromptText);

    // Send input usage to frontend
    clientWs.send(
      JSON.stringify({
        type: "token_usage",
        input_tokens: inputTokens,
        input_words: inputWords
      })
    );

    // ---------------------------------------------
    // CALL OPENROUTER
    // ---------------------------------------------
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "openai/gpt-4o",
        stream: true,
        messages: conversation
      },
      {
        responseType: "stream",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:8080",
          "X-Title": "Voice Assistant"
        }
      }
    );

    let assistantFullResponse = "";
    let outputTokens = 0;
    let outputWords = 0;

    // Stream chunks
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
        try { parsed = JSON.parse(jsonStr); }
        catch { continue; }

        const delta = parsed?.choices?.[0]?.delta?.content;

        if (delta) {
          assistantFullResponse += delta;

          // Count tokens and words for this streamed chunk
          outputTokens += countTokens(delta);
          outputWords += countWords(delta);

          clientWs.send(
            JSON.stringify({
              type: "ai_stream",
              text: delta
            })
          );
        }
      }
    });

    // End of stream
    return new Promise((resolve) => {
      response.data.on("end", () => {
        if (assistantFullResponse.trim()) {
          conversation.push({
            role: "assistant",
            content: assistantFullResponse
          });
        }

        // FINAL TOKEN REPORT
        clientWs.send(
          JSON.stringify({
            type: "token_usage_final",
            output_tokens: outputTokens,
            output_words: outputWords,
            total_tokens: inputTokens + outputTokens
          })
        );

        resolve("STREAM_DONE");
      });
    });

  } catch (err) {
    console.error(
      "OpenRouter Streaming Error:",
      err.response?.data || err
    );

    clientWs.send(
      JSON.stringify({
        type: "ai_error",
        text: "Error contacting AI model."
      })
    );
  }
}

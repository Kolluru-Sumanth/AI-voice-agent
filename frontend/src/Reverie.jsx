import { useRef, useState } from "react";
import ReverieClient from "@reverieit/reverie-client";

export default function Reverie() {
  const [isListening, setIsListening] = useState(false);
  const [finalTranscript, setFinalTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [prevPartial, setPrevPartial] = useState("");
  const [language, setLanguage] = useState("en");
  const [isSpeaking, setIsSpeaking] = useState(false);

  // ---- Persistent Reverie client ----
  const reverieClientRef = useRef(null);

  if (!reverieClientRef.current) {
    reverieClientRef.current = new ReverieClient({
      apiKey: import.meta.env.VITE_REVERIE_API_KEY,
      appId: import.meta.env.VITE_REVERIE_APP_ID,
    });
  }

  const reverieClient = reverieClientRef.current;

  // ---- Play streaming TTS audio ----
  const playAudioStream = async (response) => {
    const audioCtx = new AudioContext({ sampleRate: 22050 });
    const reader = response.body.getReader();
    let playbackPosition = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const pcm16 = new Int16Array(value.buffer);
      const float32 = new Float32Array(pcm16.length);

      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / 32768;
      }

      const buffer = audioCtx.createBuffer(1, float32.length, audioCtx.sampleRate);
      buffer.copyToChannel(float32, 0);

      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start(playbackPosition);

      playbackPosition += buffer.duration;
    }
  };

  // ---- Send recognized text to your backend ----
  const sendToBackendStream = async (text) => {
    try {
      setIsSpeaking(true);

      const response = await fetch("http://localhost:8080/stream-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) throw new Error("Backend stream failed");

      await playAudioStream(response);
    } catch (err) {
      console.error("Error streaming audio:", err);
    } finally {
      setIsSpeaking(false);
    }
  };

  // ---- Setup Reverie STT ----
const initReverie = async () => {
  await reverieClient.init_stt({
    src_lang: language,
    domain: "generic",
    silence: 1,
    continuous: true,
    logging: true,
    timeout: 180,

   callback: (event) => {
  if (!event.stt_event) return;

  const { event: evtType, data } = event.stt_event;

  if (!data) return;
  if (data.startsWith?.("Send: blob")) return;

  let text = "";

  // Try JSON
  try {
    const parsed = JSON.parse(data);
    text = parsed.display_text || parsed.text || "";
  } catch {
    // Not JSON → raw text
    text = data.trim();
  }

  if (!text) return;

  console.log("Reverie:", evtType, text);

  // --------------------
  // EXACT STREAMING UI (like your reference code)
  // --------------------

  if (evtType === "PARTIAL_RESULTS") {
    // Show partial exactly as Reverie sends it
    setPartialTranscript(text);
  }

  if (evtType === "FINAL_RESULT") {
    setFinalTranscript((prev) => prev + " " + text);
    setPartialTranscript("");
    sendToBackendStream(text);
  }
},
    errorHandler: (error) => console.error("Reverie Error:", error),
  });
};



  // ---- Start/Stop Listening ----
  const toggleListening = async () => {
    if (isListening) {
      await reverieClient.stop_stt();
      setIsListening(false);
    } else {
      await initReverie();
      await reverieClient.start_stt();
      setIsListening(true);
    }
  };

return (
  <div
    style={{
      padding: "30px",
      maxWidth: "800px",
      margin: "0 auto",
      fontFamily: "Inter, sans-serif",
    }}
  >
    <h2
      style={{
        fontSize: "26px",
        fontWeight: 700,
        marginBottom: "20px",
        color: "#1a1a1a",
      }}
    >
      🎙️ Claricall AI
    </h2>

    {/* Controls */}
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "15px",
        padding: "15px",
        borderRadius: "12px",
        background: "white",
        boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        marginBottom: "20px",
      }}
    >
      {/* Language Selector */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label
          style={{
            fontSize: "14px",
            fontWeight: 600,
            marginBottom: "4px",
            color: "#555",
          }}
        >
          Language
        </label>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          style={{
            padding: "8px 12px",
            borderRadius: "8px",
            border: "1px solid #ccc",
            fontSize: "14px",
          }}
        >
          <option value="en">English</option>
          <option value="hi">Hindi (हिन्दी)</option>
          <option value="te">Telugu (తెలుగు)</option>
          <option value="ta">Tamil (தமிழ்)</option>
          <option value="bn">Bengali (বাংলা)</option>
        </select>
      </div>

      {/* Listen Button */}
      <button
        onClick={toggleListening}
        style={{
          padding: "10px 16px",
          borderRadius: "8px",
          border: "none",
          background: isListening ? "#d9534f" : "#0275d8",
          color: "white",
          fontSize: "15px",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {isListening ? "Stop Listening" : "Start Listening"}
      </button>

      {/* Speaking Indicator */}
      {isSpeaking && (
        <div
          style={{
            padding: "8px 14px",
            background: "#e8fbe8",
            color: "#2e8a2e",
            fontWeight: 600,
            borderRadius: "8px",
            fontSize: "14px",
          }}
        >
          🔊 Speaking...
        </div>
      )}
    </div>

    {/* Transcript Box */}
    <div
      style={{
        background: "#f9fafb",
        borderRadius: "12px",
        padding: "20px",
        minHeight: "220px",
        fontSize: "17px",
        lineHeight: 1.6,
        color: "#222",
        border: "1px solid #e5e7eb",
        boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
        whiteSpace: "pre-wrap",
      }}
    >
        {finalTranscript}
  {partialTranscript && <span>{partialTranscript}</span>}
    </div>
  </div>
);

}

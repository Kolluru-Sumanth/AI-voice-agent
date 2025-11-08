import { useState } from "react";
import ReverieClient from "@reverieit/reverie-client";

export default function Reverie() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [language, setLanguage] = useState("en");
  const [isSpeaking, setIsSpeaking] = useState(false);

  const reverieClient = new ReverieClient({
    apiKey: import.meta.env.VITE_REVERIE_API_KEY,
    appId: import.meta.env.VITE_REVERIE_APP_ID,
  });

  // ---- Stream audio chunks and play them live ----
const playAudioStream = async (response) => {
  const audioCtx = new AudioContext({ sampleRate: 22050 }); // Deepgram default sample rate
  const reader = response.body.getReader();

  let playbackPosition = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    // Interpret chunk as 16-bit PCM samples
    const pcm16 = new Int16Array(value.buffer);
    const float32 = new Float32Array(pcm16.length);

    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768; // normalize [-1,1]
    }

    // Create an AudioBuffer and play it
    const buffer = audioCtx.createBuffer(1, float32.length, audioCtx.sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start(playbackPosition);

    playbackPosition += buffer.duration;
  }
};


  // ---- Send recognized text to backend for Gemini + Deepgram stream ----
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

      setIsSpeaking(false);
    } catch (err) {
      console.error("Error streaming audio:", err);
      setIsSpeaking(false);
    }
  };

  // ---- Reverie STT setup ----
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
        console.log("Reverie STT Event:", evtType, data);
        if(evtType === "PARTIAL_RESULT") {
          // Optionally handle partial results
          setTranscript((prev) => prev + "\n" + data);
        }
        if (evtType === "FINAL_RESULT") {
          setTranscript((prev) => prev + "\n" + data);
          sendToBackendStream(data);
        }
      },
      errorHandler: (error) => console.error("Reverie Error:", error),
    });
  };

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
    <div style={{ padding: 20 }}>
      <h2>🎙️ Real-Time Reverie + Gemini + Deepgram Voice Assistant</h2>

      <label>
        Language:
        <select value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="en">English</option>
          <option value="hi">Hindi (हिन्दी)</option>
          <option value="te">Telugu (తెలుగు)</option>
          <option value="ta">Tamil (தமிழ்)</option>
          <option value="bn">Bengali (বাংলা)</option>
        </select>
      </label>

      <br />
      <br />

      <button onClick={toggleListening} style={{ marginRight: 10 }}>
        {isListening ? "Stop Listening" : "Start Listening"}
      </button>

      {isSpeaking && (
        <span style={{ color: "green", fontWeight: "bold" }}>
          🔊 Speaking...
        </span>
      )}

      <textarea
        rows={10}
        cols={60}
        readOnly
        value={transcript}
        style={{
          display: "block",
          marginTop: 20,
          fontSize: 16,
          padding: 10,
          background: "#f5f5f5",
        }}
      ></textarea>
    </div>
  );
}

// src/components/TextToSpeech.jsx
import { useState } from "react";

export function TextToSpeech({ apiUrl = "/api/tts" }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  const handlePlay = async () => {
    if (!text.trim()) return;
    setLoading(true);
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        throw new Error(`API returned status ${response.status}`);
      }
      const audioBlob = await response.blob();
      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
      };
      audio.play();
    } catch (error) {
      console.error("TTS playback error:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="tts-container">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Enter text to convert to speech"
        rows={4}
        style={{ width: "100%" }}
      />
      <button onClick={handlePlay} disabled={loading}>
        {loading ? "Generating…" : "Play Audio"}
      </button>
    </div>
  );
}

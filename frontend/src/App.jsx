import React, { useState, useRef } from 'react';
import './App.css';

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcriptions, setTranscriptions] = useState([]);
  const [error, setError] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef(null);
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioChunksRef = useRef([]);
  const pcmProcessorRef = useRef(null);

  const startRecording = async () => {
    try {
      // Initialize WebSocket
      wsRef.current = new WebSocket('ws://localhost:3000');

      wsRef.current.onopen = () => {
        console.log('Connected to WebSocket server');
        setError(null);
      };

      wsRef.current.onmessage = (event) => {
        console.log('Received WebSocket message:', event.data);
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'transcription') {
            setTranscriptions((prev) => [...prev, data.transcription]);
            if (data.transcription.is_final) {
              setIsTranscribing(false);
              wsRef.current.close(); // Close after final transcription
            }
          } else if (data.message) {
            console.log('Server message:', data.message);
          }
          if (data.error) {
            setError(data.error);
            setIsTranscribing(false);
          }
        } catch (err) {
          console.error('Error parsing WebSocket message:', err);
          setError('Invalid server response');
        }
      };

      wsRef.current.onclose = () => {
        console.log('WebSocket connection closed');
        setIsTranscribing(false);
      };

      wsRef.current.onerror = () => {
        console.error('WebSocket connection error');
        setError('WebSocket connection error');
      };

      // Initialize AudioContext for PCM
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // MediaRecorder for WebM (for playback)
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        setAudioUrl(URL.createObjectURL(audioBlob));
      };

      // Process audio to PCM
      const source = audioContextRef.current.createMediaStreamSource(stream);
      pcmProcessorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

      pcmProcessorRef.current.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0); // Mono channel
        // Convert float32 (-1.0 to 1.0) to int16 PCM (-32768 to 32767)
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
        }
        // Convert to Buffer for WebSocket
        const pcmBuffer = Buffer.from(pcmData.buffer);
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(pcmBuffer);
          console.log('Sent PCM chunk:', pcmBuffer.length);
        }
      };

      source.connect(pcmProcessorRef.current);
      pcmProcessorRef.current.connect(audioContextRef.current.destination);

      mediaRecorderRef.current.start(100); // WebM chunks for playback
      setIsRecording(true);
      setTranscriptions([]);
      setError(null);
      setIsTranscribing(true);
    } catch (err) {
      console.error('Start recording error:', err);
      setError('Failed to access microphone or WebSocket: ' + err.message);
    }
  };

  const stopRecording = async () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    if (pcmProcessorRef.current) {
      pcmProcessorRef.current.disconnect();
    }
    if (audioContextRef.current) {
      await audioContextRef.current.close();
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop-recording' }));
    }
  };

  return (
    <div className="App">
      <h1>Audio Recorder (Real-Time WebSocket STT)</h1>
      <div>
        <button onClick={startRecording} disabled={isRecording}>
          Start Recording
        </button>
        <button onClick={stopRecording} disabled={!isRecording}>
          Stop Recording
        </button>
      </div>
      {isTranscribing && <p>Transcribing in real-time...</p>}
      {transcriptions.length > 0 && (
        <div>
          <h3>Live Transcriptions:</h3>
          <ul>
            {transcriptions.map((t, i) => (
              <li key={i} style={{ color: t.is_final ? 'green' : 'blue' }}>
                {t.text} {t.is_final ? '(Final)' : '(Partial)'}
              </li>
            ))}
          </ul>
        </div>
      )}
      {audioUrl && (
        <div>
          <h3>Recorded Audio:</h3>
          <audio controls src={audioUrl} />
        </div>
      )}
      {error && (
        <div style={{ color: 'red' }}>
          <h3>Error:</h3>
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}

export default App;
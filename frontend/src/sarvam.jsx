import React, { useState, useEffect, useRef } from 'react';

// --- Helper Functions ---
const getTimestamp = () => {
    const now = new Date();
    return now.toLocaleTimeString("en-US", { hour12: false }) + "." + now.getMilliseconds().toString().padStart(3, "0");
};

const float32ToInt16 = (float32Array) => {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
};

const Sarvam = () => {
    // --- State ---
    const [isRecording, setIsRecording] = useState(false);
    const [status, setStatus] = useState("Disconnected");
    const [latestTranscript, setLatestTranscript] = useState("");
    const [messages, setMessages] = useState([]);

    // --- Incremental Metrics State ---
    const [metrics, setMetrics] = useState({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalOutputChars: 0,
        duration: 0
    });

    // --- Refs ---
    const socketRef = useRef(null);
    const audioContextRef = useRef(null);
    const scriptProcessorRef = useRef(null);
    const inputStreamRef = useRef(null);
    const outputScrollRef = useRef(null);
    const audioChunksRef = useRef(new Float32Array(0));
    const isAiStreamingRef = useRef(false);
    const timerRef = useRef(null);

    // --- Cost Constants (INR) ---
    const INPUT_TOKEN_RATE = 0.000225; // ($2.5/1M) * 90
    const OUTPUT_TOKEN_RATE = 0.0009;   // ($10/1M) * 90
    const CHAR_RATE = 15 / 10000;       // ₹15 per 10k characters
    const DURATION_RATE = 45 / 3600;    // ₹45 per hour (converted to per second)

    useEffect(() => {
        if (outputScrollRef.current) {
            outputScrollRef.current.scrollTop = outputScrollRef.current.scrollHeight;
        }
    }, [messages, latestTranscript]);

    const startStreaming = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, sampleRate: 16000 }
            });

            audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();

            // socketRef.current = new WebSocket("ws://localhost:8080");
            socketRef.current = new WebSocket("wss://api-agent.claricall.space");

            socketRef.current.onopen = () => {
                setStatus("Connected to backend");
                setupAudioProcessing(stream);

                timerRef.current = setInterval(() => {
                    setMetrics(prev => ({ ...prev, duration: prev.duration + 1 }));
                }, 1000);
            };

            socketRef.current.onmessage = (event) => {
                try {
                    const json = JSON.parse(event.data);
                    const time = getTimestamp();

                    if (json.type === "data") {
                        const transcript = json.data?.transcript || "";
                        if (transcript.trim()) {
                            setLatestTranscript(transcript);
                            setMessages(prev => [...prev, { type: 'user', text: transcript, time }]);
                        }
                    }

                    if (json.type === "token_usage") {
                        setMetrics(prev => ({
                            ...prev,
                            totalInputTokens: prev.totalInputTokens + json.input_tokens
                        }));
                    }

                    if (json.type === "ai_stream") {
                        const token = json.text || "";
                        // Accumulate character count incrementally
                        setMetrics(prev => ({
                            ...prev,
                            totalOutputChars: prev.totalOutputChars + token.length
                        }));

                        if (!isAiStreamingRef.current) {
                            isAiStreamingRef.current = true;
                            setMessages(prev => [...prev, { type: 'ai', text: token, time }]);
                        } else {
                            setMessages(prev => {
                                const newMsgs = [...prev];
                                const last = newMsgs.length - 1;
                                if (last >= 0 && newMsgs[last].type === 'ai') {
                                    newMsgs[last] = { ...newMsgs[last], text: newMsgs[last].text + token };
                                }
                                return newMsgs;
                            });
                        }
                    }

                    if (json.type === "token_usage_final") {
                        setMetrics(prev => ({
                            ...prev,
                            totalOutputTokens: prev.totalOutputTokens + json.output_tokens
                        }));
                    }

                    if (json.type === "ai_done") isAiStreamingRef.current = false;

                } catch (err) {
                    console.error("Parse error:", err);
                }
            };

            socketRef.current.onclose = () => stopStreaming();

        } catch (err) {
            setStatus("Error: " + err.message);
        }
    };

    const setupAudioProcessing = (stream) => {
        inputStreamRef.current = audioContextRef.current.createMediaStreamSource(stream);
        scriptProcessorRef.current = audioContextRef.current.createScriptProcessor(2048, 1, 1);
        scriptProcessorRef.current.onaudioprocess = (event) => {
            const inputData = event.inputBuffer.getChannelData(0);
            const current = audioChunksRef.current;
            const newBuf = new Float32Array(current.length + inputData.length);
            newBuf.set(current); newBuf.set(inputData, current.length);
            audioChunksRef.current = newBuf;

            if (audioChunksRef.current.length >= 800) {
                const int16 = float32ToInt16(audioChunksRef.current);
                audioChunksRef.current = new Float32Array(0);
                const reader = new FileReader();
                reader.readAsDataURL(new Blob([int16], { type: "audio/wav" }));
                reader.onloadend = () => {
                    const b64 = reader.result.split(",")[1];
                    if (socketRef.current?.readyState === WebSocket.OPEN) {
                        socketRef.current.send(JSON.stringify({ audio: { data: b64, encoding: "audio/wav", sample_rate: 16000 } }));
                    }
                };
            }
        };
        inputStreamRef.current.connect(scriptProcessorRef.current);
        scriptProcessorRef.current.connect(audioContextRef.current.destination);
        setIsRecording(true);
    };

    const stopStreaming = () => {
        setIsRecording(false);

        // --- STOP THE TIMER ---
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null; // Clean up the ref
        }

        // --- Existing cleanup logic ---
        if (scriptProcessorRef.current) scriptProcessorRef.current.disconnect();
        if (inputStreamRef.current) inputStreamRef.current.disconnect();
        if (audioContextRef.current) audioContextRef.current.close();
        if (socketRef.current) socketRef.current.close();

        audioChunksRef.current = new Float32Array(0);
        isAiStreamingRef.current = false;
        setStatus("Recording stopped");
    };

    const formatDuration = (sec) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    // --- FINAL COST SUM ---
    const totalCost =
        (metrics.totalInputTokens * INPUT_TOKEN_RATE) +
        (metrics.totalOutputTokens * OUTPUT_TOKEN_RATE) +
        (metrics.totalOutputChars * CHAR_RATE) +
        (metrics.duration * DURATION_RATE);

    return (
        <div style={styles.container}>
            <div style={styles.headerRow}>
                <h2 style={styles.header}>Claricall Voice Agent</h2>
                <div style={styles.totalBillBox}>
                    <span style={styles.billLabel}>SESSION TOTAL:</span>
                    <span style={styles.billValue}>₹{totalCost.toFixed(2)}</span>
                </div>
            </div>

            <div style={styles.controls}>
                <button onClick={startStreaming} disabled={isRecording} style={{ ...styles.button, ...styles.startBtn, ...(isRecording ? styles.disabled : {}) }}>Start Streaming</button>
                <button onClick={stopStreaming} disabled={!isRecording} style={{ ...styles.button, ...styles.stopBtn, ...(!isRecording ? styles.disabled : {}) }}>Stop Streaming</button>
                <button onClick={() => { setMessages([]); setLatestTranscript(""); setMetrics({ totalInputTokens: 0, totalOutputTokens: 0, totalOutputChars: 0, duration: 0 }); }} style={{ ...styles.button, ...styles.clearBtn }}>Reset Session</button>
            </div>

            {/* --- CUMULATIVE DASHBOARD --- */}
            <div style={styles.dashboard}>
                <div style={styles.metricCard}>
                    <div style={styles.metricLabel}>Input Cost</div>
                    <div style={styles.metricValue}>{metrics.totalInputTokens} <span style={styles.unit}>tkns</span></div>
                    <div style={styles.costSubtext}>₹{(metrics.totalInputTokens * INPUT_TOKEN_RATE).toFixed(4)}</div>
                </div>
                <div style={styles.metricCard}>
                    <div style={styles.metricLabel}>Output Cost</div>
                    <div style={styles.metricValue}>{metrics.totalOutputTokens} <span style={styles.unit}>tkns</span></div>
                    <div style={styles.costSubtext}>₹{(metrics.totalOutputTokens * OUTPUT_TOKEN_RATE).toFixed(4)}</div>
                </div>
                <div style={styles.metricCard}>
                    <div style={styles.metricLabel}>Characters</div>
                    <div style={styles.metricValue}>{metrics.totalOutputChars} <span style={styles.unit}>chars</span></div>
                    <div style={styles.costSubtext}>₹{(metrics.totalOutputChars * CHAR_RATE).toFixed(4)}</div>
                </div>
                <div style={styles.metricCard}>
                    <div style={styles.metricLabel}>Call Duration</div>
                    <div style={styles.metricValue}>{formatDuration(metrics.duration)}</div>
                    <div style={styles.costSubtext}>₹{(metrics.duration * DURATION_RATE).toFixed(4)}</div>
                </div>
            </div>

            <div style={styles.statusBox}><strong>Status:</strong> {status}</div>

            <h3 style={styles.subHeader}>Latest Transcript:</h3>
            <div style={styles.latestTranscript}>{latestTranscript || "Waiting for speech..."}</div>

            <h3 style={styles.subHeader}>Transcription Results:</h3>
            <div style={styles.output} ref={outputScrollRef}>
                <div style={styles.chatContainer}>
                    {messages.map((msg, idx) => (
                        <div key={idx} style={{ ...styles.bubble, ...(msg.type === 'user' ? styles.userBubble : styles.aiBubble) }}>
                            <div style={msg.type === 'ai' ? styles.aiText : {}}>{msg.text}</div>
                            <div style={styles.timestamp}>{msg.time}</div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

const styles = {
    container: { fontFamily: 'Arial, sans-serif', maxWidth: '900px', margin: '0 auto', padding: '20px' },
    headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' },
    header: { color: '#333', margin: 0 },
    totalBillBox: { backgroundColor: '#1a1a1a', color: '#00e676', padding: '10px 20px', borderRadius: '8px', textAlign: 'right', border: '1px solid #00e676' },
    billLabel: { fontSize: '10px', display: 'block', color: '#999', fontWeight: 'bold' },
    billValue: { fontSize: '24px', fontWeight: 'bold' },
    subHeader: { color: '#555', marginTop: '25px', marginBottom: '15px' },
    controls: { display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' },
    button: { color: 'white', border: 'none', padding: '10px 15px', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' },
    startBtn: { backgroundColor: '#2196F3' },
    stopBtn: { backgroundColor: '#f44336' },
    clearBtn: { backgroundColor: '#9e9e9e' },
    disabled: { backgroundColor: '#cccccc', cursor: 'not-allowed' },
    dashboard: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '15px', marginBottom: '20px' },
    metricCard: { background: '#fff', border: '1px solid #ddd', padding: '12px', borderRadius: '8px', textAlign: 'center' },
    metricLabel: { fontSize: '11px', color: '#777', marginBottom: '5px', textTransform: 'uppercase' },
    metricValue: { fontSize: '16px', fontWeight: 'bold', color: '#222' },
    unit: { fontSize: '10px', color: '#999', fontWeight: 'normal' },
    costSubtext: { fontSize: '14px', color: '#2e7d32', marginTop: '4px', fontWeight: 'bold' },
    statusBox: { padding: '10px', backgroundColor: '#e7f3fe', borderLeft: '6px solid #2196F3', borderRadius: '3px', marginBottom: '15px' },
    latestTranscript: { backgroundColor: '#f5f5f5', border: '1px solid #ddd', borderRadius: '4px', padding: '15px', minHeight: '40px' },
    output: { backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: '6px', height: '400px', overflowY: 'auto', padding: '15px' },
    chatContainer: { display: 'flex', flexDirection: 'column', gap: '12px' },
    bubble: { maxWidth: '75%', padding: '12px', borderRadius: '10px', fontSize: '14px' },
    userBubble: { alignSelf: 'flex-start', backgroundColor: '#eef3ff', border: '1px solid #cdd9ff' },
    aiBubble: { alignSelf: 'flex-end', backgroundColor: '#e8f5e9', border: '1px solid #b2dfdb' },
    aiText: { whiteSpace: 'pre-wrap' },
    timestamp: { fontSize: '10px', color: '#777', textAlign: 'right', marginTop: '4px' }
};

export default Sarvam;
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import WebSocket from "ws";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";
import { spawn } from "child_process";

dotenv.config();

const app = express();
app.use(cors());

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const uploadDir = join(__dirname, "Uploads");
if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Frontend connected");

  const filename = `${Date.now()}-streamed-audio.webm`;
  const filePath = join(uploadDir, filename);
  const fileStream = createWriteStream(filePath);
  let cartesiaWs = null;

  // ------------------------
  // Connect to Cartesia STT
  // ------------------------
  const connectToCartesia = () => {
    const params = new URLSearchParams({
      model: "ink-whisper",
      language: "en",
      encoding: "pcm_s16le",
      sample_rate: "16000",
      min_volume: "0.5",
      max_silence_duration_secs: "1.0",
    });

    const url = `wss://api.cartesia.ai/stt/websocket?${params.toString()}`;
    console.log("Connecting to Cartesia STT:", url);

    cartesiaWs = new WebSocket(url, [], {
      headers: {
        Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`,
        "Cartesia-Version": "2025-04-16",
      },
    });

    cartesiaWs.on("open", () => {
      console.log("Connected to Cartesia STT");
      ws.send(JSON.stringify({ message: "Connected to Cartesia STT" }));
    });

    cartesiaWs.on("message", (data) => {
      try {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
        const msg = JSON.parse(text);
        if (msg.type === "transcript" && msg.text)
          console.log("Cartesia transcript:", msg.text);
        ws.send(JSON.stringify({ type: "transcription", transcription: msg }));
      } catch (err) {
        console.error("Error parsing Cartesia response:", err.message);
        console.log("Raw data:", data.toString("utf8"));
      }
    });

    cartesiaWs.on("close", () => console.log("Cartesia WebSocket closed"));
    cartesiaWs.on("error", (err) => console.error("Cartesia error:", err.message));
  };

  // ----------------------------------------
  // Handle incoming WebM chunks from frontend
  // ----------------------------------------

let ffmpegProc = null;

ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    const msg = data.toString();
    if (msg === "stop-recording") {
      console.log("Stopping recording");

      if (ffmpegProc) {
        ffmpegProc.stdin.end(); // close FFmpeg stdin
        ffmpegProc = null;
      }

      if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
        cartesiaWs.send("done");
        cartesiaWs.close();
      }
      fileStream.end();
    }
    return;
  }

  // echo back for playback
  ws.send(data, { binary: true });
  fileStream.write(data);

  // start ffmpeg once (on first chunk)
  if (!ffmpegProc) {
    ffmpegProc = spawn("ffmpeg", [
      "-f", "webm",             // input format
      "-i", "pipe:0",           // read from stdin
      "-acodec", "pcm_s16le",   // decode to PCM16
      "-ac", "1",               // mono
      "-ar", "16000",           // 16 kHz
      "-f", "s16le",            // raw PCM output
      "pipe:1"                  // write to stdout
    ]);

    ffmpegProc.stderr.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Error")) console.error("FFmpeg:", s.trim());
    });

    ffmpegProc.stdout.on("data", (chunk) => {
      if (cartesiaWs?.readyState === WebSocket.OPEN) {
        cartesiaWs.send(chunk, { binary: true });
      }
    });

    ffmpegProc.on("close", (code) => {
      console.log("FFmpeg process closed", code);
    });
  }

  // continuously feed webm chunks into ffmpeg stdin
  try {
    ffmpegProc.stdin.write(data);
  } catch (err) {
    console.error("FFmpeg write error:", err.message);
  }
});


  ws.on("close", () => {
    console.log("Frontend disconnected");
    if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
      cartesiaWs.send("done");
      cartesiaWs.close();
    }
    fileStream.end();
  });

  ws.on("error", (err) => {
    console.error("Frontend WebSocket error:", err.message);
    if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
      cartesiaWs.close();
    }
    fileStream.end();
  });

  ws.send(JSON.stringify({ message: "Connected to WebSocket server" }));
  connectToCartesia();
});

app.get("/", (_, res) =>
  res.send("WebSocket audio + Cartesia STT (FFmpeg) server running")
);

const PORT = 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

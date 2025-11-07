import { WebSocketServer } from 'ws';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import WebSocket from 'ws';

// Load environment variables
dotenv.config();

// Emulate __dirname and __filename in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configure upload directory
const uploadDir = join(__dirname, 'Uploads');
if (!existsSync(uploadDir)) {
  mkdirSync(uploadDir, { recursive: true });
}

// Create WebSocket server for frontend
const wss = new WebSocketServer({ port: 3000 });

wss.on('connection', (ws) => {
  console.log('Frontend client connected');

  // Generate unique filename for WebM
  const filename = `${Date.now()}-streamed-audio.webm`;
  const filePath = join(uploadDir, filename);
  const fileStream = createWriteStream(filePath); // Save WebM for playback

  let fileSize = 0;
  let cartesiaWs = null; // Cartesia WebSocket connection

  // Connect to Cartesia STT WebSocket
  const connectToCartesia = () => {
    const queryParams = new URLSearchParams({
      model: 'ink-whisper',
      language: 'en',
      encoding: 'pcm_s16le',
      sample_rate: '16000',
      min_volume: '0.5',
      max_silence_duration_secs: '1.0',
    });
    const url = `wss://api.cartesia.ai/stt/websocket?${queryParams.toString()}`;

    console.log('Attempting Cartesia connection to:', url);
    console.log('API Key present:', !!process.env.CARTESIA_API_KEY);

    cartesiaWs = new WebSocket(url, [], {
      headers: {
        Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`,
        'Cartesia-Version': '2025-04-16',
      },
    });

    cartesiaWs.on('open', () => {
      console.log('Connected to Cartesia STT WebSocket');
      ws.send(JSON.stringify({ message: 'Connected to Cartesia for real-time transcription' }));
    });

    cartesiaWs.on('message', (data) => {
      try {
        if (Buffer.isBuffer(data)) {
          console.log('Received binary from Cartesia:', data.length);
        } else {
          const transcription = JSON.parse(data.toString());
          console.log('Received transcription:', transcription);
          ws.send(JSON.stringify({ type: 'transcription', transcription }));
        }
      } catch (err) {
        console.error('Error parsing Cartesia message:', err);
      }
    });

    cartesiaWs.on('close', () => {
      console.log('Cartesia STT WebSocket closed');
      ws.send(JSON.stringify({ message: 'Transcription session ended' }));
    });

    cartesiaWs.on('error', (err) => {
      console.error('Cartesia WebSocket error:', err);
      ws.send(JSON.stringify({ error: 'Cartesia connection failed', details: err.message }));
    });
  };

  // Handle incoming messages from frontend
  ws.on('message', (data) => {
    try {
      if (Buffer.isBuffer(data)) {
        // PCM data for Cartesia
        if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
          cartesiaWs.send(data, { binary: true });
          console.log('Sent PCM chunk to Cartesia, size:', data.length);
        }
      } else {
        const message = JSON.parse(data.toString());
        if (message.type === 'webm-chunk') {
          // WebM chunk for saving
          fileSize += message.data.length;
          console.log(`Received WebM chunk, size: ${message.data.length}, total: ${fileSize}`);
          fileStream.write(Buffer.from(message.data));
        } else if (message.type === 'stop-recording') {
          console.log('Stopping recording');
          if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
            cartesiaWs.send('done'); // Close Cartesia session
          }
          fileStream.end();
        } else {
          console.error('Received invalid message type');
          ws.send(JSON.stringify({ error: 'Invalid message type' }));
        }
      }
    } catch (err) {
      console.error('Error processing message:', err.message);
      ws.send(JSON.stringify({ error: 'Failed to process message', details: err.message }));
    }
  });

  // Handle connection close
  ws.on('close', () => {
    console.log('Frontend client disconnected');
    if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
      cartesiaWs.send('done');
      cartesiaWs.close();
    }
    fileStream.end();
  });

  // Handle errors
  ws.on('error', (err) => {
    console.error('Frontend WebSocket error:', err);
    if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
      cartesiaWs.close();
    }
    fileStream.end();
  });

  // Send initial confirmation
  ws.send(JSON.stringify({ message: 'Connected to WebSocket server' }));

  // Initiate Cartesia connection
  connectToCartesia();
});

console.log('WebSocket server running at ws://localhost:3000');
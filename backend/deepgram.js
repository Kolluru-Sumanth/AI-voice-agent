import express from 'express';
import { createClient } from '@deepgram/sdk';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Deepgram client
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Server is running',
    endpoints: {
      '/text-to-speech': 'POST - Convert text to speech'
    }
  });
});

// Text-to-Speech endpoint
app.post('/text-to-speech', async (req, res) => {
  try {
    const { text } = req.body;

    // Validate input
    if (!text || text.trim() === '') {
      return res.status(400).json({ 
        error: 'Text is required' 
      });
    }

    // Check if API key is configured
    if (!process.env.DEEPGRAM_API_KEY) {
      return res.status(500).json({ 
        error: 'Deepgram API key not configured' 
      });
    }

    // Get audio from Deepgram
    const response = await deepgram.speak.request(
      { text },
      {
        model: 'aura-asteria-en',
        encoding: 'linear16',
        container: 'wav'
      }
    );

    // Get the audio stream
    const stream = await response.getStream();
    
    if (!stream) {
      return res.status(500).json({ 
        error: 'Failed to generate audio stream' 
      });
    }

    // Collect audio chunks from async iterator
    const chunks = [];
    
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const audioBuffer = Buffer.concat(chunks);
    
    // Set appropriate headers
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Content-Disposition', 'inline; filename="speech.wav"');
    
    // Send audio buffer
    res.send(audioBuffer);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: 'Failed to convert text to speech',
      details: error.message 
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Test endpoint: POST http://localhost:${PORT}/text-to-speech`);
  console.log(`Send JSON body: { "text": "Your text here" }`);
});

export default app;
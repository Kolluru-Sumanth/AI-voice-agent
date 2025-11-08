import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

const app = express();
const upload = multer({ dest: 'uploads/' });

const CARTESIA_API = 'https://api.cartesia.ai/stt';
const CARTESIA_API_KEY = 'sk_car_LMbYxbCf8KDnatKZ4CtoWn';

app.post('/transcribe', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const filePath = path.resolve(req.file.path);
    const form = new FormData();
    form.append('model', 'ink-whisper');
    form.append('language', 'hi');
    form.append('timestamp_granularities[]', 'word');
    form.append('file', fs.createReadStream(filePath));

    const response = await fetch(CARTESIA_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CARTESIA_API_KEY}`,
        'Cartesia-Version': '2025-04-16'
      },
      body: form
    });

    const data = await response.json();

    fs.unlinkSync(filePath); // delete uploaded file after processing
    res.json(data);
  } catch (error) {
    console.error('Transcription Error:', error);
    res.status(500).json({ error: 'Failed to process transcription' });
  }
});

app.listen(8080, () => {
  console.log('Server running on http://localhost:8080');
});

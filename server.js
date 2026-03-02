const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cors = require('cors');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.use(cors());

app.get('/', (req, res) => res.json({ status: 'HookLens API running' }));

// Whisper transcription proxy
app.post('/transcribe', upload.single('file'), async (req, res) => {
  try {
    const openaiKey = req.headers['x-openai-key'];
    if (!openaiKey) return res.status(400).json({ error: 'No OpenAI key provided' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: req.file.originalname || 'audio.mp4',
      contentType: req.file.mimetype || 'video/mp4'
    });
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        ...form.getHeaders()
      },
      body: form
    });

    const data = await whisperRes.json();
    if (!whisperRes.ok) return res.status(whisperRes.status).json(data);
    res.json(data);

  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`HookLens API running on port ${PORT}`));

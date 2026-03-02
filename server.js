const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cors = require('cors');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;

app.get('/', (req, res) => res.json({ status: 'HookLens API running', whisper: !!OPENAI_KEY, claude: !!ANTHROPIC_KEY }));

// Whisper transcription
app.post('/transcribe', upload.single('file'), async (req, res) => {
  try {
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OpenAI key not configured on server' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: req.file.originalname || 'audio.wav',
      contentType: req.file.mimetype || 'audio/wav'
    });
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, ...form.getHeaders() },
      body: form
    });

    const data = await whisperRes.json();
    if (!whisperRes.ok) return res.status(whisperRes.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('Transcribe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Claude analysis proxy
app.post('/analyze', async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic key not configured on server' });

    const { messages, model, max_tokens } = req.body;
    if (!messages) return res.status(400).json({ error: 'No messages provided' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-opus-4-5',
        max_tokens: max_tokens || 6000,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`HookLens API running on port ${PORT}`));

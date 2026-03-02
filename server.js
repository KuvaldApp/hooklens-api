const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cors = require('cors');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const PRICE_IDS = {
  starter: 'price_1T6Yu4FPgAzNWKNH3SFbNKoT',
  pro: 'price_1T6YuZFPgAzNWKNHwNyTgsEd',
  agency: 'price_1T6YvDFPgAzNWKNHBPZ2eVGD',
  yearly: 'price_1T6YwdFPgAzNWKNHZJPuv0JH'
};

const SCAN_LIMITS = {
  free: 1, starter: 15, pro: 30, agency: 100, yearly: 30
};

// ── PERSISTENT STORAGE ──────────────────────────────────
// Uses a local JSON file but with atomic writes and auto-backup
// More resilient than /tmp - stored in app directory
const DATA_FILE = './hooklens_users.json';
const BACKUP_FILE = './hooklens_users_backup.json';

function loadData() {
  // Try main file first, then backup
  for (const file of [DATA_FILE, BACKUP_FILE]) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        if (raw.trim()) return JSON.parse(raw);
      }
    } catch(e) { console.error(`Load error ${file}:`, e.message); }
  }
  return {};
}

function saveData(data) {
  try {
    const json = JSON.stringify(data, null, 2);
    // Write to backup first, then main (atomic-ish)
    fs.writeFileSync(BACKUP_FILE, json);
    fs.writeFileSync(DATA_FILE, json);
  } catch(e) { console.error('Save error:', e.message); }
}

// ── RATE LIMITING ────────────────────────────────────────
const rateLimits = new Map(); // ip -> { count, resetAt }

function rateLimit(req, res, maxPerHour = 10) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour

  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { count: 0, resetAt: now + windowMs });
  }

  const limit = rateLimits.get(ip);

  // Reset if window expired
  if (now > limit.resetAt) {
    limit.count = 0;
    limit.resetAt = now + windowMs;
  }

  limit.count++;

  if (limit.count > maxPerHour) {
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
    return false;
  }
  return true;
}

// Clean up rate limit map every hour to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of rateLimits.entries()) {
    if (now > limit.resetAt) rateLimits.delete(ip);
  }
}, 60 * 60 * 1000);

// ── ROUTES ───────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'HookLens API running',
  whisper: !!OPENAI_KEY,
  claude: !!ANTHROPIC_KEY,
  stripe: !!STRIPE_SECRET_KEY
}));

// Email gate
app.post('/gate', (req, res) => {
  if (!rateLimit(req, res, 20)) return;

  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const data = loadData();

  // Check if this IP already has a paid user - if so, don't block
  const ipHasPaidUser = Object.values(data).some(u => u.ip === ip && u.plan !== 'free');

  // Check if this IP already used a free scan (and has no paid plan)
  const ipUsedFreeScan = !ipHasPaidUser && Object.values(data).some(u =>
    u.ip === ip && u.plan === 'free' && u.scansUsed >= u.scansLimit
  );

  if (!data[email]) {
    // New email - check IP limit for free tier
    if (ipUsedFreeScan) {
      return res.status(403).json({
        error: 'free_scan_used',
        message: 'A free scan has already been used from this device.',
        needsUpgrade: true
      });
    }
    data[email] = {
      email,
      ip,
      plan: 'free',
      scansUsed: 0,
      scansLimit: 1,
      createdAt: new Date().toISOString()
    };
    saveData(data);
  } else {
    // Existing email - update IP if they're paid (in case they move networks)
    if (data[email].plan !== 'free') {
      data[email].ip = ip;
      saveData(data);
    }
  }

  const user = data[email];
  res.json({
    email,
    plan: user.plan,
    scansUsed: user.scansUsed,
    scansLimit: user.scansLimit,
    canScan: user.scansUsed < user.scansLimit,
    scansRemaining: Math.max(0, user.scansLimit - user.scansUsed)
  });
});

// Use a scan
app.post('/use-scan', (req, res) => {
  if (!rateLimit(req, res, 50)) return;

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const data = loadData();
  if (!data[email]) return res.status(404).json({ error: 'User not found' });

  if (data[email].scansUsed >= data[email].scansLimit) {
    return res.status(403).json({ error: 'No scans remaining', needsUpgrade: true });
  }

  data[email].scansUsed += 1;
  data[email].lastScanAt = new Date().toISOString();
  saveData(data);

  res.json({
    success: true,
    scansRemaining: data[email].scansLimit - data[email].scansUsed,
    plan: data[email].plan
  });
});

// Create Stripe checkout
app.post('/create-checkout', async (req, res) => {
  if (!rateLimit(req, res, 10)) return;

  const { email, plan } = req.body;
  if (!email || !plan) return res.status(400).json({ error: 'Email and plan required' });
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe not configured' });

  const priceId = PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const params = new URLSearchParams({
      'payment_method_types[]': 'card',
      'mode': 'subscription',
      'customer_email': email,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'success_url': `https://hooklens.net/hooklens-scanner.html?payment=success&email=${encodeURIComponent(email)}`,
      'cancel_url': 'https://hooklens.net/?payment=cancelled',
      'metadata[email]': email,
      'metadata[plan]': plan
    });

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) return res.status(400).json(session);
    res.json({ url: session.url });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try { event = JSON.parse(req.body); }
  catch(err) { return res.status(400).json({ error: 'Invalid payload' }); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.metadata?.email || session.customer_email;
    const plan = session.metadata?.plan || 'pro';

    if (email) {
      const data = loadData();
      const existing = data[email] || {};
      data[email] = {
        ...existing,
        email,
        plan,
        scansUsed: 0,
        scansLimit: SCAN_LIMITS[plan] || 30,
        paidAt: new Date().toISOString(),
        stripeSessionId: session.id
      };
      saveData(data);
      console.log(`✅ Upgraded ${email} to ${plan} with ${SCAN_LIMITS[plan]} scans`);
    }
  }

  // Handle subscription renewal - reset scan count monthly
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const email = invoice.customer_email;
    if (email) {
      const data = loadData();
      if (data[email] && data[email].plan !== 'free') {
        data[email].scansUsed = 0;
        data[email].lastRenewalAt = new Date().toISOString();
        saveData(data);
        console.log(`🔄 Reset scans for ${email} on renewal`);
      }
    }
  }

  res.json({ received: true });
});

// Whisper - rate limited to 5/hour per IP
app.post('/transcribe', upload.single('file'), async (req, res) => {
  if (!rateLimit(req, res, 5)) return;

  try {
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OpenAI key not configured' });
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
    res.status(500).json({ error: err.message });
  }
});

// Claude proxy - rate limited to 5/hour per IP
app.post('/analyze', async (req, res) => {
  if (!rateLimit(req, res, 5)) return;

  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic key not configured' });

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
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`HookLens API running on port ${PORT}`));

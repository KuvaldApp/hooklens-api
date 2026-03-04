const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

// ── RATE LIMITING ────────────────────────────────────────
const rateLimits = new Map();

function rateLimit(req, res, maxPerHour = 10) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;

  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { count: 0, resetAt: now + windowMs });
  }

  const limit = rateLimits.get(ip);

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
app.post('/gate', async (req, res) => {
  if (!rateLimit(req, res, 20)) return;

  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  try {
    const { data: existingUsers, error: lookupError } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (!existingUsers) {
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { ip, plan: 'free' }
      });

      if (authError && authError.message !== 'User already registered') throw authError;

      const userId = authData?.user?.id;
      if (userId) {
        await supabase.from('profiles').upsert({
          id: userId,
          email,
          plan: 'free',
          scans_used: 0,
          scans_limit: 1
        }, { onConflict: 'id' });
      }

      return res.json({
        email,
        plan: 'free',
        scansUsed: 0,
        scansLimit: 1,
        canScan: true,
        scansRemaining: 1
      });

    } else {
      const user = existingUsers;
      return res.json({
        email,
        plan: user.plan,
        scansUsed: user.scans_used,
        scansLimit: user.scans_limit,
        canScan: user.scans_used < user.scans_limit,
        scansRemaining: Math.max(0, user.scans_limit - user.scans_used)
      });
    }

  } catch (err) {
    console.error('Gate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Use a scan
app.post('/use-scan', async (req, res) => {
  if (!rateLimit(req, res, 50)) return;

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { data: user, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.scans_used >= user.scans_limit) {
      return res.status(403).json({ error: 'No scans remaining', needsUpgrade: true });
    }

    const newScansUsed = user.scans_used + 1;

    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        scans_used: newScansUsed,
        last_scan_at: new Date().toISOString()
      })
      .eq('email', email);

    if (updateError) throw updateError;

    res.json({
      success: true,
      scansRemaining: user.scans_limit - newScansUsed,
      scansLimit: user.scans_limit,
      plan: user.plan
    });

  } catch (err) {
    console.error('Use-scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SAVE SCAN (service role — bypasses RLS) ──────────────
app.post('/save-scan', async (req, res) => {
  if (!rateLimit(req, res, 50)) return;

  const { user_id, email, video_name, hook_score, summary, scan_data } = req.body;
  if (!user_id || !email) return res.status(400).json({ error: 'user_id and email required' });

  try {
    const { data, error } = await supabase
      .from('scans')
      .insert({
        user_id,
        email,
        video_name: video_name || 'Untitled',
        hook_score: hook_score || null,
        summary: summary || '',
        scan_data: scan_data || null
      });

    if (error) throw error;

    console.log(`💾 Saved scan for ${email} (${user_id})`);
    res.json({ success: true });
  } catch (err) {
    console.error('Save-scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try { event = JSON.parse(req.body); }
  catch(err) { return res.status(400).json({ error: 'Invalid payload' }); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.metadata?.email || session.customer_email;
    const plan = session.metadata?.plan || 'pro';

    if (email) {
      try {
        const { error } = await supabase
          .from('profiles')
          .update({
            plan,
            scans_used: 0,
            scans_limit: SCAN_LIMITS[plan] || 30,
            paid_at: new Date().toISOString(),
            stripe_session_id: session.id
          })
          .eq('email', email);

        if (error) throw error;
        console.log(`✅ Upgraded ${email} to ${plan} with ${SCAN_LIMITS[plan]} scans`);
      } catch (err) {
        console.error('Webhook upgrade error:', err.message);
      }
    }
  }

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const email = invoice.customer_email;
    if (email) {
      try {
        const { data: user } = await supabase
          .from('profiles')
          .select('plan')
          .eq('email', email)
          .maybeSingle();

        if (user && user.plan !== 'free') {
          await supabase
            .from('profiles')
            .update({
              scans_used: 0,
              last_renewal_at: new Date().toISOString()
            })
            .eq('email', email);
          console.log(`🔄 Reset scans for ${email} on renewal`);
        }
      } catch (err) {
        console.error('Webhook renewal error:', err.message);
      }
    }
  }

  res.json({ received: true });
});

// Contact form
app.post('/contact', async (req, res) => {
  if (!rateLimit(req, res, 5)) return;

  const { email, message } = req.body;
  if (!email || !message) return res.status(400).json({ error: 'Email and message required' });

  console.log(`📩 CONTACT from ${email}: ${message}`);

  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_PASS = process.env.GMAIL_PASS;

  if (GMAIL_USER && GMAIL_PASS) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER, pass: GMAIL_PASS }
      });
      await transporter.sendMail({
        from: GMAIL_USER,
        to: 'hooklensquestions@gmail.com',
        subject: `HookLens Contact: ${email}`,
        text: `From: ${email}\n\n${message}`
      });
    } catch(e) {
      console.error('Email send error:', e.message);
    }
  }

  res.json({ success: true });
});

// Whisper
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

// Claude proxy
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

// Admin
app.get('/admin/users', async (req, res) => {
  const key = req.query.key;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'hooklens-admin-2024';
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data: users, error } = await supabase
      .from('profiles')
      .select('email, plan, scans_used, scans_limit, created_at, paid_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const summary = {
      total: users.length,
      free: users.filter(u => u.plan === 'free').length,
      paid: users.filter(u => u.plan !== 'free').length,
      usedFreeScan: users.filter(u => u.plan === 'free' && u.scans_used > 0).length
    };

    res.json({ summary, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

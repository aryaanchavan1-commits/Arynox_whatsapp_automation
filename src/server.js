const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const {
  getChats,
  bulkSend,
  normalizeJid,
  findMedia,
  sendMedia,
} = require('./bot');
const {
  loadBusiness,
  saveBusiness,
  loadKnowledge,
  saveKnowledge,
  extractTextFromBuffer,
} = require('./knowledge');
const { listMedia, setNote, deleteMedia } = require('./media');
const safety = require('./safety');
const {
  isConfigured,
  toDigits,
  sendTextMessage,
  sendMediaMessage,
  handleWebhookEvent,
  handleWebhookVerify,
  getMetaChats,
  upsertContact,
  metaBulkSend,
  saveMetaConfig,
} = require('./cloudapi');

const publicDir = path.join(__dirname, '..', 'public');
const mediaDir = path.join(__dirname, '..', 'media');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(mediaDir, { recursive: true });
    cb(null, mediaDir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

function startServer(state, getCtx) {
  const app = express();
  const PORT = process.env.PORT || 3000;
  const isMeta = () => state.backend === 'meta';
  const authPassword = process.env.DASHBOARD_PASSWORD || '';
  const authRequired = !!authPassword;
  const revokedTokens = new Set();

  function signAuthToken() {
    const exp = String(Date.now() + 7 * 24 * 3600 * 1000);
    const sig = crypto.createHmac('sha256', authPassword).update(exp).digest('hex');
    return exp + '.' + sig;
  }

  function isValidAuth(req) {
    if (!authRequired) return true;
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/arynox_auth=([^;]+)/);
    if (!m) return false;
    if (revokedTokens.has(m[1])) return false;
    const [exp, sig] = m[1].split('.');
    if (!exp || !sig || Date.now() > Number(exp)) return false;
    const expected = crypto.createHmac('sha256', authPassword).update(exp).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch (e) {
      return false;
    }
  }

  app.use('/api', (req, res, next) => {
    if (req.path === '/login' || req.path === '/health') return next();
    if (!isValidAuth(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized - login required' });
    }
    next();
  });

  const hitCounts = new Map();
  function rateLimit(windowMs, max) {
    return (req, res, next) => {
      const now = Date.now();
      const key = req.ip || 'unknown';
      const arr = (hitCounts.get(key) || []).filter(t => now - t < windowMs);
      if (arr.length >= max) {
        return res.status(429).json({ ok: false, error: 'Too many requests - slow down' });
      }
      arr.push(now);
      hitCounts.set(key, arr);
      next();
    };
  }

  function cleanNumber(n) {
    return String(n || '').replace(/[^\d]/g, '');
  }
  const isValidNumber = n => /^\d{8,15}$/.test(n);

  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(publicDir));
  app.use('/media', express.static(mediaDir));

  app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.get('/api/safety', (req, res) => {
    res.json({ ok: true, safety: safety.getStats() });
  });

  app.post('/api/safety/settings', (req, res) => {
    const b = req.body || {};
    const settings = safety.updateSettings(b);
    state.log('Safety settings updated (daily cap ' + settings.dailyCap + ', hourly cap ' + settings.hourlyCap + ', quiet ' + (settings.quietEnabled ? settings.quietStart + '-' + settings.quietEnd : 'off') + ')');
    res.json({ ok: true, safety: safety.getStats() });
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      uptime: Math.floor(process.uptime()),
      status: state.status,
      backend: state.backend,
      time: new Date().toISOString(),
    });
  });

  app.post('/api/login', (req, res) => {
    if (!authRequired) return res.json({ ok: true, auth: false });
    const { password } = req.body || {};
    if (typeof password !== 'string' || password.length > 200) {
      return res.status(400).json({ ok: false, error: 'Missing password' });
    }
    if (password === authPassword) {
      res.setHeader('Set-Cookie', 'arynox_auth=' + signAuthToken() + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800');
      return res.json({ ok: true, auth: true });
    }
    res.status(401).json({ ok: false, error: 'Wrong password' });
  });

  app.post('/api/logout', (req, res) => {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/arynox_auth=([^;]+)/);
    if (m) revokedTokens.add(m[1]);
    res.setHeader('Set-Cookie', 'arynox_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/status', (req, res) => {
    const metaToken = state.meta.config.token || '';
    res.json({
      status: state.status,
      backend: state.backend,
      phone: state.phone,
      messageCount: state.messageCount,
      sentCount: state.sentCount,
      uptime: Math.floor((Date.now() - state.startedAt) / 1000),
      hasQr: !!state.qr,
      lastError: state.lastError,
      log: state.logs.slice(-20),
      auth: authRequired,
      autoReply: state.autoReply,
      automation: state.automation,
      bulk: state.bulk,
      safety: safety.getStats(),
      business: state.business,
      knowledgeDocs: state.knowledge.docs.map(d => ({ name: d.name, size: d.size })),
      mediaCount: state.media.length,
      meta: {
        configured: isConfigured(state.meta.config),
        tokenSet: !!metaToken,
        tokenMasked: metaToken ? metaToken.slice(0, 6) + '...' : '',
        phoneNumberId: state.meta.config.phoneNumberId || '',
        verifyToken: state.meta.config.verifyToken || '',
        apiVersion: state.meta.config.apiVersion || 'v23.0',
        lastWebhookAt: state.meta.lastWebhookAt || null,
        contacts: state.meta.contacts.length,
        publicUrl: state.meta.config.publicUrl || '',
      },
      config: {
        minDelay: state.config.minDelayBetweenMessages,
        maxDelay: state.config.maxDelayBetweenMessages,
        maxPerMinute: state.config.maxMessagesPerMinute,
        sessionName: state.config.sessionName,
      },
      ai: {
        provider: state.config.aiProvider,
        model: state.config.aiModel.groq,
        fallbackModel: state.config.aiModel.opencode,
        groqKeyConfigured: !!(state.config.groqApiKey || ''),
        opencodeKeyConfigured: !!(state.config.opencodeApiKey || ''),
      },
    });
  });

  app.get('/api/qr', (req, res) => {
    if (!state.qr) return res.json({ qr: null });
    res.json({ qr: state.qr });
  });

  app.post('/api/qr/reset', async (req, res) => {
    if (isMeta()) return res.status(400).json({ ok: false, error: 'Not available in Meta mode' });
    const sessionDir = path.join(__dirname, '..', 'session_' + state.config.sessionName);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
    state.log('Session reset - a fresh QR code will appear');
    const ctx = getCtx();
    try {
      if (ctx && ctx.sock) await ctx.sock.end(new Error('Session reset by user'));
    } catch (e) { /* ignore */ }
    res.json({ ok: true });
  });

  app.get('/api/chats', async (req, res) => {
    if (isMeta()) {
      return res.json({ ok: true, chats: getMetaChats(state) });
    }
    const ctx = getCtx();
    if (!ctx || state.status !== 'ready') {
      return res.status(400).json({ ok: false, error: 'Bot is not connected yet' });
    }
    try {
      const chats = await getChats(ctx);
      res.json({ ok: true, chats });
    } catch (e) {
      console.error('getChats error:', e);
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/send', rateLimit(60000, 30), async (req, res) => {
    const { to, message, mediaId } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: 'Missing "to"' });
    const text = String(message || '').trim();
    if (text.length > 5000) return res.status(400).json({ ok: false, error: 'Message too long (max 5000 chars)' });
    const media = mediaId ? findMedia(mediaId) : null;
    if (!media && !text) return res.status(400).json({ ok: false, error: 'Nothing to send' });
    try {
      if (isMeta()) {
        if (!isConfigured(state.meta.config)) {
          return res.status(400).json({ ok: false, error: 'Meta Cloud API is not configured' });
        }
        const n = toDigits(to);
        if (media) {
          await sendMediaMessage(state.meta.config, n, media, message || '');
        } else {
          await sendTextMessage(state.meta.config, n, message || '');
        }
        state.sentCount++;
        return res.json({ ok: true });
      }
      const ctx = getCtx();
      if (!ctx || state.status !== 'ready') {
        return res.status(400).json({ ok: false, error: 'Bot is not connected yet' });
      }
      const chatId = normalizeJid(to);
      if (media) {
        await sendMedia(ctx.sock, chatId, media, message || '');
      } else {
        await ctx.sock.sendMessage(chatId, { text: message || '' });
      }
      state.sentCount++;
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/bulk-send', rateLimit(60000, 5), async (req, res) => {
    const { numbers, message, mediaId } = req.body || {};
    if (!Array.isArray(numbers) || numbers.length === 0 || !message) {
      return res.status(400).json({ ok: false, error: 'Missing "numbers" array or "message"' });
    }
    const text = String(message).trim();
    if (text.length > 5000) return res.status(400).json({ ok: false, error: 'Message too long (max 5000 chars)' });
    const unique = [...new Set(numbers.map(cleanNumber).filter(isValidNumber))];
    if (unique.length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid numbers (must be 8-15 digits with country code)' });
    }
    if (unique.length > 500) return res.status(400).json({ ok: false, error: 'Too many recipients (max 500)' });
    if (state.bulk && state.bulk.active) {
      return res.status(400).json({ ok: false, error: 'A bulk send is already in progress' });
    }
    const media = mediaId ? findMedia(mediaId) : null;
    try {
      if (isMeta()) {
        if (!isConfigured(state.meta.config)) {
          return res.status(400).json({ ok: false, error: 'Meta Cloud API is not configured' });
        }
        metaBulkSend(state, unique, text, media);
      } else {
        const ctx = getCtx();
        if (!ctx || state.status !== 'ready') {
          return res.status(400).json({ ok: false, error: 'Bot is not connected yet' });
        }
        bulkSend(ctx, unique, text, state, media);
      }
      res.json({ ok: true, started: true, total: unique.length, media: media ? media.fileName : null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/auto-reply', (req, res) => {
    const { enabled, message, mediaId } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: '"enabled" must be a boolean' });
    }
    state.autoReply.enabled = enabled;
    if (typeof message === 'string' && message.trim()) {
      state.autoReply.message = message.trim();
    }
    if (mediaId !== undefined) {
      if (mediaId === '') {
        state.autoReply.media = null;
      } else if (findMedia(mediaId)) {
        state.autoReply.media = mediaId;
      } else {
        return res.status(400).json({ ok: false, error: 'Media not found: ' + mediaId });
      }
    }
    state.log('Auto-reply ' + (enabled ? 'ENABLED' : 'DISABLED') + (state.autoReply.media ? ' (with media)' : ''));
    res.json({ ok: true, autoReply: state.autoReply });
  });

  app.post('/api/automation', (req, res) => {
    const { aiEnabled } = req.body || {};
    if (typeof aiEnabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: '"aiEnabled" must be a boolean' });
    }
    state.automation.aiEnabled = aiEnabled;
    state.log('AI automation ' + (aiEnabled ? 'ENABLED - bot answers every customer like your business' : 'DISABLED - bot stays silent'));
    res.json({ ok: true, automation: state.automation });
  });

  app.post('/api/ai/test', rateLimit(60000, 20), async (req, res) => {
    const { question } = req.body || {};
    const { getAIReply } = require('./ai');
    try {
      const reply = await getAIReply(question || 'Say hello in one short friendly sentence', [], state);
      res.json({ ok: !!reply, reply: reply || 'AI returned nothing (both providers failed - check keys in .env)' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/business', (req, res) => {
    const b = req.body || {};
    const cap = (v, max) => String(v || '').trim().slice(0, max);
    state.business = {
      businessName: cap(b.businessName, 200),
      businessDescription: cap(b.businessDescription, 2000),
      tone: cap(b.tone, 500),
      rules: cap(b.rules, 2000),
    };
    saveBusiness(state.business);
    state.log('Business profile updated');
    res.json({ ok: true, business: state.business });
  });

  app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    state.refreshMedia();
    state.log('Uploaded: ' + req.file.filename);
    res.json({ ok: true, fileName: req.file.filename, url: '/media/' + encodeURIComponent(req.file.filename) });
  });

  app.get('/api/media', (req, res) => {
    res.json({ ok: true, media: state.media });
  });

  app.post('/api/media/note', (req, res) => {
    const { fileName, note } = req.body || {};
    if (!fileName) return res.status(400).json({ ok: false, error: 'Missing fileName' });
    setNote(fileName, String(note || ''));
    state.refreshMedia();
    res.json({ ok: true });
  });

  app.post('/api/media/delete', (req, res) => {
    const { fileName } = req.body || {};
    if (!fileName) return res.status(400).json({ ok: false, error: 'Missing fileName' });
    deleteMedia(fileName);
    if (state.autoReply.media === fileName) state.autoReply.media = null;
    state.refreshMedia();
    state.log('Deleted media: ' + fileName);
    res.json({ ok: true });
  });

  app.post('/api/kb/add', async (req, res) => {
    const { fileName } = req.body || {};
    if (!fileName) return res.status(400).json({ ok: false, error: 'Missing fileName' });
    const media = findMedia(fileName);
    if (!media) return res.status(400).json({ ok: false, error: 'File not found: ' + fileName });
    try {
      const buf = fs.readFileSync(media.full);
      const text = await extractTextFromBuffer(buf, fileName);
      if (text === null || text.trim().length === 0) {
        return res.status(400).json({ ok: false, error: 'Could not extract text (only PDF/TXT/MD supported)' });
      }
      state.knowledge.docs = state.knowledge.docs.filter(d => d.name !== fileName);
      state.knowledge.docs.push({ name: fileName, size: media.size, text: text.slice(0, 50000) });
      saveKnowledge(state.knowledge);
      state.log('Added to AI knowledge: ' + fileName);
      res.json({ ok: true, docs: state.knowledge.docs.map(d => ({ name: d.name, size: d.size })) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/kb/delete', (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'Missing name' });
    state.knowledge.docs = state.knowledge.docs.filter(d => d.name !== name);
    saveKnowledge(state.knowledge);
    state.log('Removed from knowledge base: ' + name);
    res.json({ ok: true, docs: state.knowledge.docs.map(d => ({ name: d.name, size: d.size })) });
  });

  app.post('/api/meta/config', (req, res) => {
    const b = req.body || {};
    const prevToken = (state.meta.config && state.meta.config.token) || '';
    const cfg = {
      backend: b.backend === 'meta' ? 'meta' : 'baileys',
      token: String(b.token || '').trim() || prevToken,
      phoneNumberId: String(b.phoneNumberId || '').trim(),
      verifyToken: String(b.verifyToken || '').trim(),
      apiVersion: String(b.apiVersion || 'v23.0').trim(),
      publicUrl: String(b.publicUrl || '').trim().replace(/\/+$/, ''),
    };
    saveMetaConfig(cfg);
    state.meta.config = cfg;
    state.log('Meta config saved (backend: ' + cfg.backend + ')' + (isConfigured(cfg) ? ' - configured' : ' - NOT configured yet'));
    res.json({ ok: true, configured: isConfigured(cfg), backend: cfg.backend });
  });

  app.post('/api/meta/test', async (req, res) => {
    const { to, message } = req.body || {};
    if (!isConfigured(state.meta.config)) {
      return res.status(400).json({ ok: false, error: 'Meta Cloud API is not configured yet' });
    }
    if (!to) return res.status(400).json({ ok: false, error: 'Missing "to" (include country code, e.g. 919876543210)' });
    try {
      await sendTextMessage(state.meta.config, toDigits(to), message || 'Test message from Arynox Automation');
      state.log('Meta test message sent to ' + toDigits(to));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/contacts/add', (req, res) => {
    const { number, name } = req.body || {};
    const n = toDigits(number);
    if (!n) return res.status(400).json({ ok: false, error: 'Missing number' });
    upsertContact(state, n, String(name || '').trim() || n);
    state.log('Contact added: ' + (name || n) + ' (' + n + ')');
    res.json({ ok: true });
  });

  app.get('/webhook', (req, res) => {
    const challenge = handleWebhookVerify(state.meta.config, req.query);
    if (challenge === null) {
      return res.status(403).send('Verification failed');
    }
    state.log('Webhook verified by Meta');
    res.type('text/plain').send(String(challenge));
  });

  app.post('/webhook', (req, res) => {
    res.json({ status: 'ok' });
    setImmediate(() => {
      try {
        handleWebhookEvent(req.body, state);
      } catch (e) {
        console.error('Webhook processing error:', e);
      }
    });
  });

  app.post('/api/disconnect', async (req, res) => {
    if (isMeta()) {
      state.log('Meta Cloud API: disable the webhook in the Meta dashboard to stop receiving');
      return res.json({ ok: true });
    }
    const ctx = getCtx();
    if (!ctx || !ctx.sock) return res.status(400).json({ ok: false, error: 'No client' });
    try {
      await ctx.sock.end(new Error('Disconnected by user'));
      state.status = 'disconnected';
      state.log('Disconnected by user');
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message || String(e) });
    }
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, error: 'File too large (max 100 MB)' });
      }
      return res.status(400).json({ ok: false, error: 'Upload error: ' + err.code });
    }
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }
    console.error('API error:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  const server = app.listen(PORT, () => {
    console.log('Dashboard: http://localhost:' + PORT);
    state.log('Dashboard running on http://localhost:' + PORT + (authRequired ? ' (password protected)' : ''));
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + PORT + ' is already in use. Close the other process or set PORT=<free port> in .env');
      process.exit(1);
    }
    console.error('Server error:', err);
    process.exit(1);
  });

  return app;
}

module.exports = { startServer };
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
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

  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(publicDir));
  app.use('/media', express.static(mediaDir));

  app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.get('/api/status', (req, res) => {
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
      autoReply: state.autoReply,
      bulk: state.bulk,
      business: state.business,
      knowledgeDocs: state.knowledge.docs.map(d => ({ name: d.name, size: d.size })),
      mediaCount: state.media.length,
      meta: {
        configured: isConfigured(state.meta.config),
        token: state.meta.config.token || '',
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

  app.post('/api/send', async (req, res) => {
    const { to, message, mediaId } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: 'Missing "to"' });
    const media = mediaId ? findMedia(mediaId) : null;
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

  app.post('/api/bulk-send', async (req, res) => {
    const { numbers, message, mediaId } = req.body || {};
    if (!Array.isArray(numbers) || numbers.length === 0 || !message) {
      return res.status(400).json({ ok: false, error: 'Missing "numbers" array or "message"' });
    }
    if (state.bulk && state.bulk.active) {
      return res.status(400).json({ ok: false, error: 'A bulk send is already in progress' });
    }
    const media = mediaId ? findMedia(mediaId) : null;
    try {
      if (isMeta()) {
        if (!isConfigured(state.meta.config)) {
          return res.status(400).json({ ok: false, error: 'Meta Cloud API is not configured' });
        }
        metaBulkSend(state, numbers, message, media);
      } else {
        const ctx = getCtx();
        if (!ctx || state.status !== 'ready') {
          return res.status(400).json({ ok: false, error: 'Bot is not connected yet' });
        }
        bulkSend(ctx, numbers, message, state, media);
      }
      res.json({ ok: true, started: true, total: numbers.length, media: media ? media.fileName : null });
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

  app.post('/api/ai/test', async (req, res) => {
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
    state.business = {
      businessName: String(b.businessName || ''),
      businessDescription: String(b.businessDescription || ''),
      tone: String(b.tone || ''),
      rules: String(b.rules || ''),
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
    const cfg = {
      backend: b.backend === 'meta' ? 'meta' : 'baileys',
      token: String(b.token || '').trim(),
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

  app.listen(PORT, () => {
    console.log('Dashboard: http://localhost:' + PORT);
    state.log('Dashboard running on http://localhost:' + PORT);
  });

  return app;
}

module.exports = { startServer };
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { isRateLimited, parseMediaTag } = require('./bot');
const { findMedia } = require('./media');
const { getAIReply } = require('./ai');
const { interMessageDelay } = require('./utils/humanizer');
const { sleep } = require('./utils/delay');
const { getHistory, addToHistory, clearHistory, isProcessed, setLastMessage } = require('./memory');
const safety = require('./safety');

const DATA_DIR = path.join(__dirname, '..', 'data');
const META_CONFIG_FILE = path.join(DATA_DIR, 'meta-config.json');

const MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function loadMetaConfig() {
  try {
    if (fs.existsSync(META_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(META_CONFIG_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {
    backend: process.env.WHATSAPP_BACKEND || 'baileys',
    token: process.env.META_TOKEN || '',
    phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
    verifyToken: process.env.META_VERIFY_TOKEN || '',
    apiVersion: process.env.META_API_VERSION || 'v23.0',
    publicUrl: process.env.META_PUBLIC_URL || '',
  };
}

function saveMetaConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(META_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function isConfigured(cfg) {
  return !!(cfg && cfg.token && cfg.phoneNumberId && cfg.verifyToken);
}

function toDigits(n) {
  return String(n || '').replace(/\D/g, '');
}

function apiUrl(cfg, suffix) {
  return 'https://graph.facebook.com/' + (cfg.apiVersion || 'v23.0') + '/' + suffix;
}

async function graphApi(cfg, suffix, opts = {}) {
  const headers = { Authorization: 'Bearer ' + cfg.token };
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(apiUrl(cfg, suffix), {
    method: opts.method || 'GET',
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || JSON.stringify(data) || res.statusText;
    throw new Error('Meta API ' + res.status + ': ' + msg);
  }
  return data;
}

async function sendTextMessage(cfg, to, text) {
  return graphApi(cfg, cfg.phoneNumberId + '/messages', {
    method: 'POST',
    json: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: String(text) },
    },
  });
}

async function uploadMediaFile(cfg, file) {
  const ext = path.extname(file.fileName).toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  const buf = fs.readFileSync(file.full);
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', mime);
  fd.append('file', new Blob([buf], { type: mime }), path.basename(file.fileName));
  const res = await fetch(apiUrl(cfg, cfg.phoneNumberId + '/media'), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const msg = (data.error && data.error.message) || JSON.stringify(data) || res.statusText;
    throw new Error('Meta upload ' + res.status + ': ' + msg);
  }
  return data.id;
}

async function sendMediaMessage(cfg, to, file, caption) {
  const mediaId = await uploadMediaFile(cfg, file);
  const kind = file.type === 'image' || file.type === 'video' ? file.type : 'document';
  const payload = { id: mediaId, caption: caption || '' };
  if (kind === 'document') payload.fileName = file.fileName;
  return graphApi(cfg, cfg.phoneNumberId + '/messages', {
    method: 'POST',
    json: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: kind,
      [kind]: payload,
    },
  });
}

async function sendToOne(state, to, text, mediaFile) {
  const cfg = state.meta.config;
  if (!isConfigured(cfg)) throw new Error('Meta Cloud API is not configured');
  await sleep(800 + Math.random() * 1200);
  await interMessageDelay(config.minDelayBetweenMessages, config.maxDelayBetweenMessages);
  if (mediaFile) {
    await sendMediaMessage(cfg, to, mediaFile, text || '');
  } else {
    await sendTextMessage(cfg, to, text);
  }
  state.sentCount++;
}

async function sendReadReceipt(cfg, messageId) {
  try {
    await graphApi(cfg, cfg.phoneNumberId + '/messages', {
      method: 'POST',
      json: { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
    });
  } catch (e) { /* ignore */ }
}

function upsertContact(state, number, name) {
  const existing = state.meta.contacts.find(c => c.number === number);
  if (existing) {
    existing.name = name || existing.name;
    existing.lastAt = Date.now();
  } else {
    state.meta.contacts.push({ number, name: name || number, lastAt: Date.now() });
  }
}

async function processInbound(state, from, name, text, messageId) {
  try {
    if (!messageId) return;
    if (isProcessed('meta_' + messageId)) return;
    state.messageCount++;
    if (isRateLimited(from)) return;
    setLastMessage(from, text);
    await sendReadReceipt(state.meta.config, messageId);
    await sleep(500 + Math.random() * 1000);

    const reply = async (content, mediaFile) => {
      const gate = safety.canSend(1);
      if (!gate.allowed) {
        state.log('Safety gate (' + gate.reason + ') - reply held back for ' + from);
        return false;
      }
      await sendToOne(state, from, content, mediaFile);
      safety.recordSent(1);
      return true;
    };

    const lower = text.toLowerCase();
    let out;
    if (safety.isOptOutRequest(text)) {
      const added = safety.optOut(from);
      if (added) {
        state.log('Opt-out: ' + from + ' will not be messaged again');
        await sendToOne(state, from, 'Got it. You have been removed from our messages and will not hear from us again.');
        safety.recordSent(1);
      }
      return;
    }
    if (safety.isOptedOut(from)) {
      return;
    }
    if (lower === '!help') {
      out = 'Available commands:\n!help - Show this help\n!ping - Pong!\n!time - Current time\n!reset - Clear conversation memory';
    } else if (lower === '!ping') {
      out = 'Pong!';
    } else if (lower === '!time') {
      out = 'Current time: ' + new Date().toLocaleTimeString();
    } else if (lower === '!reset') {
      clearHistory(from);
      out = 'Conversation memory cleared. Starting fresh!';
    } else if (state.autoReply.enabled && text) {
      addToHistory(from, 'user', text);
      out = await getAIReply(text, getHistory(from).slice(0, -1), state);
      if (!out) {
        const media = state.autoReply.media ? findMedia(state.autoReply.media) : null;
        await reply(state.autoReply.message, media);
      } else {
        const parsed = parseMediaTag(out);
        await reply(parsed.clean, parsed.file);
        addToHistory(from, 'assistant', parsed.clean);
      }
      return;
    } else if (state.autoReply.enabled) {
      const media = state.autoReply.media ? findMedia(state.autoReply.media) : null;
      await reply(state.autoReply.message, media);
      return;
    }
    if (out) await reply(out);
  } catch (e) {
    console.error('Meta inbound handling error:', e.message);
    state.log('Inbound handling error: ' + e.message);
  }
}

function handleWebhookEvent(body, state) {
  state.meta.lastWebhookAt = Date.now();
  const entries = (body && body.entry) || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const ch of changes) {
      if (ch.field !== 'messages') continue;
      const v = ch.value || {};
      const msgs = v.messages || [];
      const contacts = v.contacts || [];
      for (const msg of msgs) {
        const from = toDigits(msg.from);
        const name = contacts[0] && contacts[0].profile ? contacts[0].profile.name : from;
        upsertContact(state, from, name);
        if (msg.type === 'text') {
          const bodyText = (msg.text && msg.text.body) || '';
          state.log('Meta inbound from ' + from + ': ' + bodyText.slice(0, 80));
          processInbound(state, from, name, bodyText, msg.id);
        } else {
          state.log('Meta inbound ' + msg.type + ' from ' + from);
          processInbound(state, from, name, '[User sent a ' + msg.type + ']', msg.id);
        }
      }
    }
  }
}

function handleWebhookVerify(cfg, query) {
  if (query['hub.mode'] !== 'subscribe') return null;
  if (query['hub.verify_token'] !== cfg.verifyToken) return null;
  return query['hub.challenge'] || null;
}

function getMetaChats(state) {
  return state.meta.contacts
    .slice()
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    .map(c => ({ id: c.number, number: c.number, name: c.name }));
}

async function metaBulkSend(state, numbers, message, mediaFile) {
  const cfg = state.meta.config;
  if (!isConfigured(cfg)) throw new Error('Meta Cloud API is not configured');
  state.bulk = { active: true, total: numbers.length, sent: 0, failed: 0, current: '', status: 'starting' };
  state.log('Bulk send started (Meta API): ' + numbers.length + ' recipients' + (mediaFile ? ' (with ' + mediaFile.fileName + ')' : ''));

  let sinceBreak = 0;
  for (let i = 0; i < numbers.length; i++) {
    const to = toDigits(numbers[i]);
    state.bulk.current = to;

    if (safety.isOptedOut(to)) {
      state.bulk.failed++;
      state.bulk.status = 'skipped (opted out) ' + (i + 1) + '/' + numbers.length;
      continue;
    }

    const gate = safety.canSend(1);
    if (!gate.allowed) {
      const waitMin = Math.ceil((gate.waitMs || 60000) / 60000);
      if (waitMin > 180) {
        state.bulk.status = 'paused (' + gate.reason + ')';
        state.log('Bulk paused: ' + gate.reason + ' - will resume automatically in ~' + waitMin + ' min');
        await sleep(Math.min(gate.waitMs || 3600000, 6 * 3600000));
        i--;
        continue;
      }
      state.log('Bulk waiting ' + Math.round((gate.waitMs || 60000) / 1000) + 's (' + gate.reason + ')...');
      await sleep(gate.waitMs || 60000);
      i--;
      continue;
    }

    const personalized = safety.spin(message);
    state.bulk.status = 'sending (' + (i + 1) + '/' + numbers.length + ')';
    try {
      if (mediaFile) {
        await sendMediaMessage(cfg, to, mediaFile, personalized);
      } else {
        await sendTextMessage(cfg, to, personalized);
      }
      safety.recordSent(1);
      state.bulk.sent++;
      state.sentCount++;
      sinceBreak++;
    } catch (e) {
      state.bulk.failed++;
      state.log('Bulk send failed to ' + to + ': ' + (e.message || e));
    }
    if (i < numbers.length - 1) {
      await interMessageDelay(config.bulkMinDelay, config.bulkMaxDelay);
      if (sinceBreak >= 25) {
        const pause = 90000 + Math.floor(Math.random() * 150000);
        state.bulk.status = 'cooling down (' + Math.round(pause / 1000) + 's)';
        state.log('Batch of 25 sent - cooling down ' + Math.round(pause / 1000) + 's');
        await sleep(pause);
        sinceBreak = 0;
      }
    }
  }

  state.bulk.active = false;
  state.bulk.status = 'done';
  state.bulk.current = '';
  state.log('Bulk send finished: ' + state.bulk.sent + ' sent, ' + state.bulk.failed + ' failed/skipped');
}

module.exports = {
  loadMetaConfig,
  saveMetaConfig,
  isConfigured,
  toDigits,
  sendTextMessage,
  sendMediaMessage,
  sendToOne,
  handleWebhookEvent,
  handleWebhookVerify,
  getMetaChats,
  upsertContact,
  metaBulkSend,
};
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { getAIReply } = require('./ai');
const { findMedia, getMediaType } = require('./media');
const { humanTypingDelay, interMessageDelay } = require('./utils/humanizer');
const { sleep } = require('./utils/delay');
const { getHistory, addToHistory, clearHistory, isProcessed, setLastMessage, getLastMessages } = require('./memory');

const messageTimestamps = {};
let activeCtx = null;

function getActiveCtx() {
  return activeCtx;
}

const CACHE_FILE = path.join(__dirname, '..', 'data', 'chats-cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return { chats: d.chats || [], contacts: d.contacts || [] };
    }
  } catch (e) { /* ignore */ }
  return { chats: [], contacts: [] };
}

let cacheTimer = null;
function scheduleCacheSave(chatStore) {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({
        chats: Array.from(chatStore.chats.values()),
        contacts: Array.from(chatStore.contacts.values()),
      }));
    } catch (e) { /* ignore */ }
  }, 3000);
}

function isRateLimited(from) {
  const now = Date.now();
  if (!messageTimestamps[from]) messageTimestamps[from] = [];
  messageTimestamps[from] = messageTimestamps[from].filter(t => now - t < 60000);
  if (messageTimestamps[from].length >= config.maxMessagesPerMinute) return true;
  messageTimestamps[from].push(now);
  return false;
}

function normalizeJid(to) {
  let n = String(to).trim().replace(/\s+/g, '');
  if (n.includes('@')) {
    n = n.replace('@c.us', '@s.whatsapp.net');
    return n;
  }
  return n + '@s.whatsapp.net';
}

function getMessageText(msg) {
  const m = msg.message || {};
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage && m.extendedTextMessage.text) return m.extendedTextMessage.text;
  if (m.imageMessage && m.imageMessage.caption) return m.imageMessage.caption;
  if (m.videoMessage && m.videoMessage.caption) return m.videoMessage.caption;
  if (m.documentMessage && m.documentMessage.caption) return m.documentMessage.caption;
  if (m.audioMessage || m.voiceMessage) return '';
  return '';
}

function messageHasMedia(msg) {
  const m = msg.message || {};
  return !!(m.imageMessage || m.videoMessage || m.documentMessage || m.audioMessage || m.voiceMessage || m.stickerMessage);
}

async function sendMedia(sock, jid, file, caption) {
  const buf = fs.readFileSync(file.full);
  const ext = path.extname(file.fileName).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
    await sock.sendMessage(jid, { image: buf, caption: caption || '' });
  } else if (['.mp4', '.mkv', '.webm', '.mov'].includes(ext)) {
    await sock.sendMessage(jid, { video: buf, caption: caption || '' });
  } else {
    await sock.sendMessage(jid, {
      document: buf,
      fileName: file.fileName,
      mimetype: 'application/pdf',
      caption: caption || '',
    });
  }
}

function parseMediaTag(text) {
  const m = String(text).match(/\[media:([^\]]+)\]\s*$/);
  if (!m) return { clean: text, file: null };
  const file = findMedia(m[1]);
  const clean = text.replace(/\[media:[^\]]+\]\s*$/, '').trim();
  return { clean, file };
}

function makeStateLogger(state) {
  return (msg) => state.log(msg);
}

async function startBot(state) {
  const sessionDir = path.join(__dirname, '..', 'session_' + config.sessionName);
  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
  const log = makeStateLogger(state);

  const sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false,
    browser: ['Arynox Automation', 'Chrome', '120.0.0.0'],
    syncFullHistory: true,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  const cached = loadCache();
  const chatStore = {
    chats: new Map(cached.chats.map(c => [c.id, c])),
    contacts: new Map(cached.contacts.map(c => [c.id, c])),
  };

  sock.ev.on('chats.upsert', chats => {
    for (const c of chats) chatStore.chats.set(c.id, { id: c.id, name: c.name, isGroup: c.id.endsWith('@g.us') });
    scheduleCacheSave(chatStore);
  });
  sock.ev.on('chats.update', updates => {
    for (const u of updates) {
      const existing = chatStore.chats.get(u.id);
      if (existing) chatStore.chats.set(u.id, Object.assign({}, existing, { name: u.name !== undefined ? u.name : existing.name }));
    }
    scheduleCacheSave(chatStore);
  });
  sock.ev.on('contacts.upsert', contacts => {
    for (const c of contacts) {
      if (!c.id) continue;
      chatStore.contacts.set(c.id, c);
    }
    scheduleCacheSave(chatStore);
  });

  sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
    let groups = 0;
    for (const c of chats || []) {
      if (c.id.endsWith('@g.us')) groups++;
      chatStore.chats.set(c.id, { id: c.id, name: c.name, isGroup: c.id.endsWith('@g.us') });
    }
    for (const c of contacts || []) {
      if (!c.id) continue;
      chatStore.contacts.set(c.id, c);
    }
    scheduleCacheSave(chatStore);
    state.log('History sync complete: ' + (chats ? chats.length : 0) + ' chats (' + groups + ' groups), ' + (contacts ? contacts.length : 0) + ' contacts');
  });

  sock.ev.on('creds.update', saveCreds);

  state.status = 'starting';
  state.log('Bot starting...');

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      state.status = 'qr';
      state.qrData = qr;
      try {
        state.qr = await qrcode.toDataURL(qr, { width: 300, margin: 2 });
        state.log('QR code generated - scan it from the dashboard');
      } catch (e) {
        state.qr = null;
      }
    }

    if (connection === 'open') {
      state.status = 'ready';
      state.qr = null;
      state.qrData = null;
      try {
        state.phone = sock.user ? sock.user.id.split(':')[0] : null;
      } catch (e) { /* ignore */ }
      state.log('Bot is ready and connected - syncing contacts...');
      try {
        if (typeof sock.fetchMessageHistory === 'function') {
          sock.fetchMessageHistory(10000).catch(() => {});
        }
      } catch (e) { /* ignore */ }
    }

    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error
        ? lastDisconnect.error.output && lastDisconnect.error.output.statusCode
        : null;
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession || code === 401) {
        state.status = 'qr';
        state.lastError = 'Session invalid - resetting for a fresh QR code...';
        state.log(state.lastError);
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) { /* ignore */ }
        setTimeout(() => startBot(state), 1500);
      } else {
        state.status = 'disconnected';
        state.lastError = 'Disconnected (code ' + code + ')';
        state.log(state.lastError + ' - restarting in 5s...');
        setTimeout(() => startBot(state), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg.key || !msg.key.id) continue;
        const dedupeKey = (msg.key.remoteJid || '') + '_' + msg.key.id;
        if (isProcessed(dedupeKey)) continue;
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        let text = getMessageText(msg);
        if (!text && messageHasMedia(msg)) {
          if (msg.message && msg.message.audioMessage) text = '[User sent a voice message]';
          else if (msg.message && msg.message.stickerMessage) text = '[User sent a sticker]';
          else text = '[User sent a photo/video/document]';
        }
        state.messageCount++;
        setLastMessage(jid, text);
        if (!isGroup && msg.pushName && !chatStore.contacts.has(jid)) {
          chatStore.contacts.set(jid, { id: jid, name: msg.pushName });
          scheduleCacheSave(chatStore);
        }

        if (isRateLimited(jid)) continue;

        await sleep(800 + Math.random() * 1200);
        await sock.readMessages([msg.key]);

        const reply = async (content, mediaFile) => {
          await sock.sendPresenceUpdate('composing', jid);
          await humanTypingDelay(content || ' ');
          await interMessageDelay(config.minDelayBetweenMessages, config.maxDelayBetweenMessages);
          if (mediaFile) {
            await sendMedia(sock, jid, mediaFile, content || '');
          } else {
            await sock.sendMessage(jid, { text: content });
          }
          await sock.sendPresenceUpdate('paused', jid);
          state.sentCount++;
        };

        if (isGroup) {
          if (text.startsWith('!')) {
            await reply(text);
          }
          continue;
        }

        let out;
        const lower = text.toLowerCase();
        if (lower === '!help') {
          out = 'Available commands:\n!help - Show this help\n!ping - Pong!\n!time - Current time\n!reset - Clear conversation memory';
        } else if (lower === '!ping') {
          out = 'Pong!';
        } else if (lower === '!time') {
          out = 'Current time: ' + new Date().toLocaleTimeString();
        } else if (lower === '!reset') {
          clearHistory(jid);
          out = 'Conversation memory cleared. Starting fresh!';
        } else if (state.autoReply.enabled) {
          out = state.autoReply.message;
          const media = state.autoReply.media ? findMedia(state.autoReply.media) : null;
          await reply(out, media);
          continue;
        } else if (state.automation.aiEnabled && text) {
          addToHistory(jid, 'user', text);
          out = await getAIReply(text, getHistory(jid).slice(0, -1), state);
          if (!out) {
            state.log('AI returned nothing - staying silent for: ' + text.slice(0, 40));
            continue;
          }
          const parsed = parseMediaTag(out);
          out = parsed.clean;
          await reply(out, parsed.file);
          addToHistory(jid, 'assistant', out);
          continue;
        } else {
          continue;
        }
        await reply(out);
      } catch (e) {
        console.error('Message handling error:', e.message);
      }
    }
  });

  const ctx = { sock, store: chatStore, log };
  activeCtx = ctx;
  return ctx;
}

async function getChats(ctx) {
  const { store } = ctx;
  const result = [];
  const seen = new Set();
  const last = getLastMessages();
  for (const chat of store.chats.values()) {
    try {
      if (chat.isGroup) continue;
      const contact = store.contacts.get(chat.id);
      const name = (contact && (contact.name || contact.notify)) || chat.name || chat.id.split('@')[0];
      seen.add(chat.id);
      const lm = last.get(chat.id);
      result.push({
        id: chat.id,
        number: chat.id.split('@')[0],
        name: String(name),
        lastMsg: lm ? lm.text : null,
        lastTs: lm ? lm.ts : null,
      });
    } catch (e) { /* skip */ }
  }
  for (const contact of store.contacts.values()) {
    try {
      const id = contact.id;
      if (!id || seen.has(id) || id.endsWith('@g.us') || id.endsWith('@newsletter')) continue;
      const name = contact.name || contact.notify || id.split('@')[0];
      const lm = last.get(id);
      result.push({
        id,
        number: id.split('@')[0],
        name: String(name),
        lastMsg: lm ? lm.text : null,
        lastTs: lm ? lm.ts : null,
      });
    } catch (e) { /* skip */ }
  }
  return result.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
}

async function bulkSend(ctx, numbers, message, state, mediaFile) {
  const { sock } = ctx;
  state.bulk = { active: true, total: numbers.length, sent: 0, failed: 0, current: '', status: 'starting' };
  state.log('Bulk send started: ' + numbers.length + ' recipients' + (mediaFile ? ' (with ' + mediaFile.fileName + ')' : ''));

  for (let i = 0; i < numbers.length; i++) {
    const to = normalizeJid(numbers[i]);
    state.bulk.current = to;
    state.bulk.status = 'sending (' + (i + 1) + '/' + numbers.length + ')';
    try {
      if (mediaFile) {
        await sendMedia(sock, to, mediaFile, message);
      } else {
        await sock.sendMessage(to, { text: message });
      }
      state.bulk.sent++;
      state.sentCount++;
    } catch (e) {
      state.bulk.failed++;
      state.log('Bulk send failed to ' + to + ': ' + (e.message || e));
    }
    if (i < numbers.length - 1) {
      await interMessageDelay(config.bulkMinDelay, config.bulkMaxDelay);
    }
  }

  state.bulk.active = false;
  state.bulk.status = 'done';
  state.bulk.current = '';
  state.log('Bulk send finished: ' + state.bulk.sent + ' sent, ' + state.bulk.failed + ' failed');
}

module.exports = { startBot, isRateLimited, getChats, bulkSend, normalizeJid, sendMedia, findMedia, parseMediaTag, getActiveCtx };
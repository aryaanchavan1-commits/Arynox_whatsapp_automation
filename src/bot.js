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

const messageTimestamps = {};

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
  return m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) || (m.videoMessage && m.videoMessage.caption) || '';
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
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  const chatStore = { chats: new Map(), contacts: new Map() };

  sock.ev.on('chats.upsert', chats => {
    for (const c of chats) chatStore.chats.set(c.id, { id: c.id, name: c.name, isGroup: c.id.endsWith('@g.us') });
  });
  sock.ev.on('chats.update', updates => {
    for (const u of updates) {
      const existing = chatStore.chats.get(u.id);
      if (existing) chatStore.chats.set(u.id, Object.assign({}, existing, { name: u.name !== undefined ? u.name : existing.name }));
    }
  });
  sock.ev.on('contacts.upsert', contacts => {
    for (const c of contacts) chatStore.contacts.set(c.id, c);
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
      state.log('Bot is ready and connected');
    }

    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error
        ? lastDisconnect.error.output && lastDisconnect.error.output.statusCode
        : null;
      if (code === DisconnectReason.loggedOut) {
        state.status = 'error';
        state.lastError = 'Session logged out. Please delete the session folder and re-scan.';
        state.log(state.lastError);
      } else if (code === DisconnectReason.badSession) {
        state.status = 'error';
        state.lastError = 'Bad session. Delete session_' + config.sessionName + ' and re-scan.';
        state.log(state.lastError);
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
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const text = getMessageText(msg);
        state.messageCount++;

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
          out = 'Available commands:\n!help - Show this help\n!ping - Pong!\n!time - Current time';
        } else if (lower === '!ping') {
          out = 'Pong!';
        } else if (lower === '!time') {
          out = 'Current time: ' + new Date().toLocaleTimeString();
        } else if (state.autoReply.enabled) {
          out = state.autoReply.message;
          const media = state.autoReply.media ? findMedia(state.autoReply.media) : null;
          await reply(out, media);
          continue;
        } else if (text) {
          out = await getAIReply(text, [], state);
          if (!out) {
            state.log('AI returned nothing - staying silent for: ' + text.slice(0, 40));
            continue;
          }
          const parsed = parseMediaTag(out);
          out = parsed.clean;
          await reply(out, parsed.file);
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

  return { sock, store: chatStore, log };
}

async function getChats(ctx) {
  const { store } = ctx;
  const result = [];
  for (const chat of store.chats.values()) {
    try {
      if (chat.isGroup) continue;
      const contact = store.contacts.get(chat.id);
      const name = (contact && (contact.name || contact.notify)) || chat.name || chat.id.split('@')[0];
      result.push({
        id: chat.id,
        number: chat.id.split('@')[0],
        name: String(name),
      });
    } catch (e) { /* skip */ }
  }
  return result.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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

module.exports = { startBot, isRateLimited, getChats, bulkSend, normalizeJid, sendMedia, findMedia, parseMediaTag };
const histories = new Map();
const processed = new Set();
const lastMessages = new Map();

const MAX_HISTORY = 10;
const MAX_CHATS = 400;
const MAX_PROCESSED = 3000;

function getHistory(jid) {
  return histories.get(jid) || [];
}

function addToHistory(jid, role, content) {
  let h = histories.get(jid);
  if (!h) {
    if (histories.size >= MAX_CHATS) {
      histories.delete(histories.keys().next().value);
    }
    h = [];
    histories.set(jid, h);
  }
  h.push({ role, content: String(content).slice(0, 500) });
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}

function clearHistory(jid) {
  histories.delete(jid);
}

function isProcessed(id) {
  if (processed.has(id)) return true;
  if (processed.size >= MAX_PROCESSED) processed.clear();
  processed.add(id);
  return false;
}

function setLastMessage(jid, text) {
  lastMessages.set(jid, { text: String(text || '').slice(0, 120), ts: Date.now() });
}

function getLastMessages() {
  return lastMessages;
}

module.exports = { getHistory, addToHistory, clearHistory, isProcessed, setLastMessage, getLastMessages };
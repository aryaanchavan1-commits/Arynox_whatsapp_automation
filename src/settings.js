const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = path.join(__dirname, '..', 'data', 'settings.json');

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      autoReply: {
        enabled: !!raw.autoReply.enabled,
        message: typeof raw.autoReply.message === 'string' && raw.autoReply.message.trim()
          ? raw.autoReply.message
          : config.autoReplyMessage,
        media: raw.autoReply.media || null,
      },
      automation: {
        aiEnabled: raw.automation.aiEnabled !== false,
      },
    };
  } catch (e) {
    return {
      autoReply: {
        enabled: config.autoReplyEnabled,
        message: config.autoReplyMessage,
        media: null,
      },
      automation: { aiEnabled: true },
    };
  }
}

let timer = null;

function save(state) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify({
        autoReply: state.autoReply,
        automation: state.automation,
      }, null, 2));
    } catch (e) { /* retry next change */ }
  }, 800);
}

module.exports = { load, save };

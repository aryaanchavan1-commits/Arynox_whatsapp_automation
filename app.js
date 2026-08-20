const config = require('./config');
const { startBot } = require('./src/bot');
const { startServer } = require('./src/server');
const { loadBusiness, loadKnowledge } = require('./src/knowledge');
const { listMedia } = require('./src/media');
const { loadMetaConfig, isConfigured } = require('./src/cloudapi');

const metaConfig = loadMetaConfig();

const state = {
  status: 'starting',
  backend: metaConfig.backend || config.backend || 'baileys',
  qr: null,
  qrData: null,
  phone: null,
  messageCount: 0,
  sentCount: 0,
  lastError: null,
  startedAt: Date.now(),
  config,
  business: loadBusiness(),
  knowledge: loadKnowledge(),
  autoReply: {
    enabled: config.autoReplyEnabled,
    message: config.autoReplyMessage,
    media: null,
  },
  bulk: { active: false, total: 0, sent: 0, failed: 0, current: '', status: '' },
  refreshMedia() {
    this.media = listMedia();
  },
  media: [],
  meta: {
    config: metaConfig,
    contacts: [],
    lastWebhookAt: null,
  },
  logs: [],
  log(msg) {
    const line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    console.log(line);
    this.logs.push(line);
    if (this.logs.length > 100) this.logs.shift();
  },
};

state.refreshMedia();

let ctxRef = null;

if (state.backend === 'meta') {
  ctxRef = { mode: 'meta' };
  if (isConfigured(metaConfig)) {
    state.status = 'ready';
    state.log('Meta Cloud API backend active (configured) - waiting for webhook messages');
  } else {
    state.status = 'config';
    state.log('Meta Cloud API backend selected but NOT configured - open the dashboard to set it up');
  }
} else {
  startBot(state).then(ctx => {
    ctxRef = ctx;
  }).catch(e => {
    state.status = 'error';
    state.lastError = e.message || String(e);
    state.log('Bot crashed: ' + state.lastError);
  });
}

startServer(state, () => ctxRef);
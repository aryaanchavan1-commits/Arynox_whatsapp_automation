const config = require('./config');
const { startBot, getActiveCtx } = require('./src/bot');
const { startServer } = require('./src/server');
const { loadBusiness, loadKnowledge } = require('./src/knowledge');
const { listMedia } = require('./src/media');
const { loadMetaConfig, isConfigured } = require('./src/cloudapi');
const db = require('./src/db');
const settingsStore = require('./src/settings');

async function main() {
  let dbReady = false;
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    dbReady = db.init();
    if (dbReady) {
      try {
        await db.ensureSchema();
        const restored = await db.restoreDataFiles();
        console.log('Cloud database connected' + (restored ? ' - restored ' + restored + ' data files' : ''));
      } catch (e) {
        console.error('Cloud database error:', e.message);
        dbReady = false;
      }
    } else {
      console.error('Cloud database init failed - running on local files only');
    }
  }

  const metaConfig = loadMetaConfig();
  const savedSettings = settingsStore.load();

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
    autoReply: savedSettings.autoReply,
    automation: savedSettings.automation,
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

  process.on('unhandledRejection', (e) => {
    try {
      state.log('Unhandled rejection: ' + ((e && e.message) || e));
    } catch (_) { /* ignore */ }
  });
  process.on('uncaughtException', (e) => {
    try {
      state.log('Uncaught exception: ' + ((e && e.stack) || e));
    } catch (_) { /* ignore */ }
  });

  if (dbReady) {
    db.watchDataDir(state.log);
    db.syncAllDataNow().catch(() => {});
  }

  const selfPingUrl = process.env.SELF_PING_URL;
  if (selfPingUrl) {
    setInterval(() => {
      try {
        const mod = selfPingUrl.startsWith('https') ? require('https') : require('http');
        mod.get(selfPingUrl, { timeout: 10000 }).on('error', () => {});
      } catch (e) { /* ignore */ }
    }, 4 * 60 * 1000);
    state.log('Keep-alive self-ping active: ' + selfPingUrl);
  }

  if (state.backend === 'meta') {
    if (isConfigured(metaConfig)) {
      state.status = 'ready';
      state.log('Meta Cloud API backend active (configured) - waiting for webhook messages');
    } else {
      state.status = 'config';
      state.log('Meta Cloud API backend selected but NOT configured - open the dashboard to set it up');
    }
  } else {
    startBot(state).catch(e => {
      state.status = 'error';
      state.lastError = e.message || String(e);
      state.log('Bot crashed: ' + state.lastError);
    });
  }

  startServer(state, () => getActiveCtx());
}

main().catch(e => {
  console.error('Fatal startup error:', e && e.stack || e);
  process.exit(1);
});

const fs = require('fs');
const path = require('path');
const config = require('../config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'safety.json');

const WARMUP_CAPS = [25, 50, 100, 200, 400];
const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'remove me', 'don\'t message', 'dont message', 'do not message', 'not interested'];

let data = null;
let saveTimer = null;

function defaults() {
  return {
    firstSeenAt: Date.now(),
    dateKey: new Date().toDateString(),
    sentToday: 0,
    hourKey: currentHourKey(),
    sentThisHour: 0,
    totalSent: 0,
    optedOut: [],
    settings: {
      dailyCap: config.safetyDailyCap || 500,
      hourlyCap: config.safetyHourlyCap || 30,
      quietEnabled: config.safetyQuietEnabled !== false,
      quietStart: config.safetyQuietStart != null ? config.safetyQuietStart : 22,
      quietEnd: config.safetyQuietEnd != null ? config.safetyQuietEnd : 8,
      warmupEnabled: true,
    },
  };
}

function load() {
  if (data) return data;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data = Object.assign(defaults(), raw);
    data.settings = Object.assign(defaults().settings, raw.settings || {});
  } catch (e) {
    data = defaults();
  }
  rollCounters();
  return data;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (e) { /* ignore */ }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 1500);
}

function currentHourKey() {
  const d = new Date();
  return d.toDateString() + '_' + d.getHours();
}

function rollCounters() {
  const today = new Date().toDateString();
  if (data.dateKey !== today) {
    data.dateKey = today;
    data.sentToday = 0;
  }
  const hk = currentHourKey();
  if (data.hourKey !== hk) {
    data.hourKey = hk;
    data.sentThisHour = 0;
  }
}

function warmupDay() {
  if (!data.settings.warmupEnabled) return null;
  const days = Math.floor((Date.now() - data.firstSeenAt) / 86400000);
  return Math.min(days + 1, 5);
}

function effectiveDailyCap() {
  const day = warmupDay();
  if (day === null) return data.settings.dailyCap;
  return Math.min(WARMUP_CAPS[day - 1], data.settings.dailyCap);
}

function inQuietHours(now) {
  if (!data.settings.quietEnabled) return false;
  const h = (now || new Date()).getHours();
  const s = data.settings.quietStart;
  const e = data.settings.quietEnd;
  if (s === e) return false;
  if (s < e) return h >= s && h < e;
  return h >= s || h < e;
}

function msUntilQuietEnd(now) {
  const d = now ? new Date(now) : new Date();
  const end = new Date(d);
  end.setHours(data.settings.quietEnd, 0, 0, 0);
  if (end <= d) end.setDate(end.getDate() + 1);
  return end - d;
}

function canSend(n) {
  n = n || 1;
  rollCounters();
  if (inQuietHours()) {
    return { allowed: false, reason: 'quiet-hours', waitMs: msUntilQuietEnd() };
  }
  if (data.sentThisHour + n > data.settings.hourlyCap) {
    const waitMs = 3600000 - (Date.now() - new Date(new Date().setMinutes(0, 0, 0)).getTime());
    return { allowed: false, reason: 'hourly-cap', waitMs };
  }
  if (data.sentToday + n > effectiveDailyCap()) {
    const end = new Date();
    end.setHours(24, 0, 0, 0);
    return { allowed: false, reason: 'daily-cap', waitMs: end - Date.now() };
  }
  return { allowed: true, reason: null, waitMs: 0 };
}

function recordSent(n) {
  n = n || 1;
  rollCounters();
  data.sentToday += n;
  data.sentThisHour += n;
  data.totalSent += n;
  scheduleSave();
}

function optOut(jid) {
  if (!jid) return false;
  if (!data.optedOut.includes(jid)) {
    data.optedOut.push(jid);
    save();
    return true;
  }
  return false;
}

function optIn(jid) {
  const i = data.optedOut.indexOf(jid);
  if (i >= 0) {
    data.optedOut.splice(i, 1);
    save();
    return true;
  }
  return false;
}

function isOptedOut(jid) {
  return data.optedOut.includes(jid);
}

function isOptOutRequest(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t || t.length > 40) return false;
  return OPT_OUT_WORDS.some(w => t === w || t.startsWith(w));
}

function spin(text) {
  return String(text || '').replace(/\{([^{}]+)\}/g, (_, opts) => {
    const parts = opts.split('|').map(s => s.trim()).filter(Boolean);
    return parts.length ? parts[Math.floor(Math.random() * parts.length)] : _;
  });
}

function updateSettings(patch) {
  const s = data.settings;
  if (patch.dailyCap != null) s.dailyCap = Math.max(10, Math.min(2000, Number(patch.dailyCap) || s.dailyCap));
  if (patch.hourlyCap != null) s.hourlyCap = Math.max(1, Math.min(200, Number(patch.hourlyCap) || s.hourlyCap));
  if (patch.quietEnabled != null) s.quietEnabled = !!patch.quietEnabled;
  if (patch.quietStart != null) s.quietStart = Math.max(0, Math.min(23, Number(patch.quietStart)));
  if (patch.quietEnd != null) s.quietEnd = Math.max(0, Math.min(23, Number(patch.quietEnd)));
  if (patch.warmupEnabled != null) s.warmupEnabled = !!patch.warmupEnabled;
  save();
  return s;
}

function getStats() {
  load();
  rollCounters();
  const cap = effectiveDailyCap();
  return {
    sentToday: data.sentToday,
    sentThisHour: data.sentThisHour,
    dailyCap: cap,
    hourlyCap: data.settings.hourlyCap,
    totalSent: data.totalSent,
    warmupDay: warmupDay(),
    warmupCaps: WARMUP_CAPS,
    optedOutCount: data.optedOut.length,
    quietActive: inQuietHours(),
    settings: data.settings,
  };
}

load();

module.exports = {
  canSend,
  recordSent,
  optOut,
  optIn,
  isOptedOut,
  isOptOutRequest,
  spin,
  updateSettings,
  getStats,
};

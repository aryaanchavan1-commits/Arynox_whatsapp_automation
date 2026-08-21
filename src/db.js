const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_URL = process.env.TURSO_DATABASE_URL || '';
const DB_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

let client = null;
let available = false;

function init() {
  if (!DB_URL || !DB_TOKEN) return false;
  try {
    client = createClient({ url: DB_URL, authToken: DB_TOKEN });
    available = true;
    return true;
  } catch (e) {
    console.error('Turso init failed:', e.message);
    available = false;
    return false;
  }
}

async function ensureSchema() {
  if (!available) return false;
  await client.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT DEFAULT 'owner',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  return true;
}

function isAvailable() {
  return available;
}

// ---------- Users ----------

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

async function getUserByEmail(email) {
  if (!available) return null;
  const r = await client.execute({
    sql: 'SELECT id, email, password_hash, salt, role FROM users WHERE email = ?',
    args: [String(email).toLowerCase().trim()],
  });
  return r.rows[0] || null;
}

async function countUsers() {
  if (!available) return 0;
  const r = await client.execute('SELECT COUNT(*) AS n FROM users');
  return Number(r.rows[0].n);
}

async function createUser(email, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const r = await client.execute({
    sql: 'INSERT INTO users (email, password_hash, salt) VALUES (?, ?, ?)',
    args: [String(email).toLowerCase().trim(), hash, salt],
  });
  return { id: Number(r.lastInsertRowid), email: String(email).toLowerCase().trim() };
}

function verifyPassword(user, password) {
  try {
    const expected = Buffer.from(user.password_hash, 'hex');
    const actual = Buffer.from(hashPassword(password, user.salt), 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (e) {
    return false;
  }
}

// ---------- KV store ----------

async function kvGet(key) {
  if (!available) return null;
  const r = await client.execute({ sql: 'SELECT value FROM kv WHERE key = ?', args: [key] });
  return r.rows[0] ? r.rows[0].value : null;
}

async function kvSet(key, value) {
  if (!available) return false;
  await client.execute({
    sql: `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    args: [key, String(value)],
  });
  return true;
}

// ---------- Data file sync (business/knowledge/safety/meta-config/chats-cache/media notes) ----------

const DATA_FILES = ['business.json', 'knowledge.json', 'media.json', 'meta-config.json', 'safety.json', 'chats-cache.json'];
const syncTimers = new Map();

async function restoreDataFiles() {
  if (!available) return 0;
  let restored = 0;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const name of DATA_FILES) {
    const localPath = path.join(DATA_DIR, name);
    if (fs.existsSync(localPath)) continue;
    try {
      const remote = await kvGet('data:' + name);
      if (remote) {
        JSON.parse(remote);
        fs.writeFileSync(localPath, remote);
        restored++;
      }
    } catch (e) { /* skip corrupt */ }
  }
  return restored;
}

function scheduleDataSync(name) {
  if (!available) return;
  if (syncTimers.has(name)) return;
  syncTimers.set(name, setTimeout(async () => {
    syncTimers.delete(name);
    try {
      const localPath = path.join(DATA_DIR, name);
      if (!fs.existsSync(localPath)) return;
      await kvSet('data:' + name, fs.readFileSync(localPath, 'utf8'));
    } catch (e) { /* retry next change */ }
  }, 2000));
}

function watchDataDir(log) {
  if (!available) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.watch(DATA_DIR, (event, filename) => {
      if (filename && DATA_FILES.includes(filename)) scheduleDataSync(filename);
    });
  } catch (e) {
    if (log) log('Data dir watch unavailable: ' + e.message);
  }
}

async function syncAllDataNow() {
  if (!available) return 0;
  let n = 0;
  for (const name of DATA_FILES) {
    const localPath = path.join(DATA_DIR, name);
    if (!fs.existsSync(localPath)) continue;
    try {
      await kvSet('data:' + name, fs.readFileSync(localPath, 'utf8'));
      n++;
    } catch (e) { /* skip */ }
  }
  return n;
}

module.exports = {
  init,
  ensureSchema,
  isAvailable,
  getUserByEmail,
  countUsers,
  createUser,
  verifyPassword,
  kvGet,
  kvSet,
  restoreDataFiles,
  watchDataDir,
  syncAllDataNow,
};

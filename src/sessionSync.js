const fs = require('fs');
const path = require('path');
const db = require('./db');

function sessionDir(sessionName) {
  return path.join(__dirname, '..', 'session_' + (sessionName || 'arynox_session'));
}

let snapTimer = null;

async function restoreSession(sessionName, log) {
  if (!db.isAvailable()) return false;
  const dir = sessionDir(sessionName);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) return false;
  try {
    const namesRaw = await db.kvGet('session:files');
    if (!namesRaw) return false;
    const names = JSON.parse(namesRaw);
    let restored = 0;
    for (const name of names) {
      const val = await db.kvGet('session:file:' + name);
      if (val == null) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), Buffer.from(val, 'base64'));
      restored++;
    }
    if (restored > 0 && log) log('Session restored from cloud database (' + restored + ' files) - no QR scan needed');
    return restored > 0;
  } catch (e) {
    if (log) log('Session restore failed: ' + e.message);
    return false;
  }
}

async function snapshotSession(sessionName, log) {
  if (!db.isAvailable()) return;
  const dir = sessionDir(sessionName);
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => {
      try { return fs.statSync(path.join(dir, f)).isFile(); } catch (e) { return false; }
    });
    if (files.length === 0) return;
    for (const name of files) {
      const buf = fs.readFileSync(path.join(dir, name));
      await db.kvSet('session:file:' + name, buf.toString('base64'));
    }
    await db.kvSet('session:files', JSON.stringify(files));
    if (log) log('Session backed up to cloud database (' + files.length + ' files)');
  } catch (e) {
    if (log) log('Session backup failed: ' + e.message);
  }
}

function scheduleSnapshot(sessionName, log) {
  if (!db.isAvailable() || snapTimer) return;
  snapTimer = setTimeout(() => {
    snapTimer = null;
    snapshotSession(sessionName, log);
  }, 3000);
}

module.exports = { restoreSession, snapshotSession, scheduleSnapshot };

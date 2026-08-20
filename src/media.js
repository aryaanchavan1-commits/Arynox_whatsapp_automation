const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.join(__dirname, '..', 'media');
const MEDIA_META = path.join(__dirname, '..', 'data', 'media.json');

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.mov'];
const DOC_EXTS = ['.pdf', '.txt', '.doc', '.docx'];

function ensureDir() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(MEDIA_META, 'utf8'));
  } catch (e) {
    return { notes: {} };
  }
}

function saveMeta(meta) {
  fs.mkdirSync(path.dirname(MEDIA_META), { recursive: true });
  fs.writeFileSync(MEDIA_META, JSON.stringify(meta, null, 2));
}

function getMediaType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (DOC_EXTS.includes(ext)) return 'document';
  return 'other';
}

function listMedia() {
  ensureDir();
  const meta = loadMeta();
  return fs.readdirSync(MEDIA_DIR)
    .filter(f => !f.startsWith('.'))
    .map(fileName => {
      const full = path.join(MEDIA_DIR, fileName);
      const stat = fs.statSync(full);
      return {
        fileName,
        url: '/media/' + encodeURIComponent(fileName),
        type: getMediaType(fileName),
        size: stat.size,
        note: meta.notes[fileName] || '',
      };
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

function findMedia(name) {
  const safe = path.basename(name);
  const full = path.join(MEDIA_DIR, safe);
  if (fs.existsSync(full)) {
    return { fileName: safe, full, type: getMediaType(safe) };
  }
  const dir = fs.readdirSync(MEDIA_DIR).filter(f => !f.startsWith('.'));
  const match = dir.find(f => f.toLowerCase() === safe.toLowerCase());
  if (match) {
    const full2 = path.join(MEDIA_DIR, match);
    return { fileName: match, full: full2, type: getMediaType(match) };
  }
  return null;
}

function setNote(fileName, note) {
  const meta = loadMeta();
  meta.notes[fileName] = note;
  saveMeta(meta);
}

function deleteMedia(fileName) {
  const file = findMedia(fileName);
  if (file) {
    fs.unlinkSync(file.full);
    const meta = loadMeta();
    delete meta.notes[fileName];
    saveMeta(meta);
  }
}

module.exports = { listMedia, findMedia, setNote, deleteMedia, getMediaType };
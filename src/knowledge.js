const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function saveJson(file, data) {
  ensureDirs();
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

function loadBusiness() {
  return Object.assign(
    { businessName: '', businessDescription: '', tone: '', rules: '' },
    loadJson('business.json', {})
  );
}

function saveBusiness(profile) {
  saveJson('business.json', profile);
}

function loadKnowledge() {
  return loadJson('knowledge.json', { docs: [] });
}

function saveKnowledge(kb) {
  saveJson('knowledge.json', kb);
}

async function extractTextFromBuffer(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') {
    const data = await pdfParse(buffer);
    return data.text || '';
  }
  if (ext === '.txt' || ext === '.md') {
    return buffer.toString('utf8');
  }
  return null;
}

function selectKnowledge(kbDocs, question, maxChars = 8000) {
  if (!kbDocs || kbDocs.length === 0) return '';
  const words = (question || '').toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const scored = kbDocs.map(doc => {
    const text = doc.text || '';
    const lower = text.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (lower.includes(w)) score++;
    }
    return { name: doc.name, text, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(d => d.score > 0);
  const chosen = (top.length > 0 ? top : scored.slice(0, 2)).slice(0, 3);

  let out = '';
  for (const doc of chosen) {
    const snippet = doc.text.slice(0, 6000);
    if (out.length + snippet.length > maxChars) break;
    out += '--- Document: ' + doc.name + ' ---\n' + snippet + '\n';
  }
  return out;
}

function buildSystemPrompt(state, question) {
  const b = state.business;
  const parts = [];

  parts.push('You are the WhatsApp assistant of ' + (b.businessName || 'this business owner') + '.');

  if (b.businessDescription) parts.push('About the business:\n' + b.businessDescription);
  if (b.tone) parts.push('Tone and style:\n' + b.tone);
  if (b.rules) parts.push('Important rules to follow:\n' + b.rules);

  const kb = selectKnowledge(state.knowledge.docs, question);
  if (kb) parts.push('Business knowledge base (use this information when answering):\n' + kb);

  const mediaList = state.media.filter(m => m.type === 'image' || m.type === 'video');
  if (mediaList.length > 0) {
    const listing = mediaList.map(m => m.fileName + (m.note ? ' - ' + m.note : '')).join('\n');
    parts.push('Available media files you may send to the customer when helpful (product photos, videos, etc.).\nIf sending one is appropriate, end your reply with [media:' + mediaList[0].fileName + '] style tag using the exact filename.\nAvailable media:\n' + listing);
  }

  parts.push('Always reply in the same language the customer writes in. Be concise, natural, friendly and helpful. Never mention that you are an AI or a bot. Never include the [media:...] tag in the visible text - it is a command, not part of the reply.');

  return parts.join('\n\n');
}

module.exports = {
  loadBusiness,
  saveBusiness,
  loadKnowledge,
  saveKnowledge,
  extractTextFromBuffer,
  buildSystemPrompt,
  selectKnowledge,
};
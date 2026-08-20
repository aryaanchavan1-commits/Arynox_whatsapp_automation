const config = require('../config');
const { buildSystemPrompt } = require('./knowledge');

const PROVIDERS = {
  groq: {
    base: 'https://api.groq.com/openai/v1/chat/completions',
    getKey: () => config.groqApiKey,
    getModel: () => config.aiModel.groq,
  },
  opencode: {
    base: 'https://opencode.ai/zen/v1/chat/completions',
    getKey: () => config.opencodeApiKey,
    getModel: () => config.aiModel.opencode,
  },
};

async function callProvider(name, messages) {
  const p = PROVIDERS[name];
  const key = p.getKey();
  if (!key) throw new Error('No API key for ' + name);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(p.base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify({
        model: p.getModel(),
        messages,
        max_tokens: 500,
        temperature: 0.8,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(name + ' HTTP ' + res.status + ' ' + body.slice(0, 150));
    }
    const data = await res.json();
    const reply = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content.trim()
      : '';
    if (!reply) throw new Error(name + ' empty reply');
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

async function getAIReply(text, history = [], state) {
  const systemPrompt = state ? buildSystemPrompt(state, text) : config.aiSystemPrompt;
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user', content: text },
  ];

  const primary = config.aiProvider === 'opencode' ? 'opencode' : 'groq';
  const fallback = primary === 'groq' ? 'opencode' : 'groq';
  const order = [primary, fallback];

  for (let attempt = 0; attempt < 2; attempt++) {
    for (const name of order) {
      try {
        return await callProvider(name, messages);
      } catch (e) {
        console.error('AI provider ' + name + ' failed: ' + e.message);
      }
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}

module.exports = { getAIReply };
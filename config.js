require('dotenv').config();

module.exports = {
  groqApiKey: process.env.GROQ_API_KEY || '',
  opencodeApiKey: process.env.OPENCODE_API_KEY || '',
  aiProvider: process.env.AI_PROVIDER || 'groq',
  aiModel: {
    groq: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    opencode: process.env.OPENCODE_MODEL || 'deepseek-v4-flash-free',
  },
  aiSystemPrompt: "You are Arynox, the WhatsApp assistant of this account owner. Reply as if you are the owner: concise, natural, friendly, and helpful. Always answer in the same language the user writes in. Never mention that you are an AI or a bot.",
  sessionName: process.env.SESSION_NAME || 'arynox_session',
  backend: process.env.WHATSAPP_BACKEND || 'baileys',
  metaApiVersion: process.env.META_API_VERSION || 'v23.0',
  minDelayBetweenMessages: 2000,
  maxDelayBetweenMessages: 8000,
  typingDelayFactor: 0.1,
  maxMessagesPerMinute: 10,
  autoReplyEnabled: false,
  autoReplyMessage: "I'm currently away and can't reply right now. I will get back to you as soon as possible.",
  bulkMinDelay: 4000,
  bulkMaxDelay: 12000,
  enabled: true,
};
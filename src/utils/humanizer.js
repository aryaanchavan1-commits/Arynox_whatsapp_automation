const { humanDelay } = require('./delay');

async function humanTypingDelay(message) {
  const baseDelayPerChar = 200;
  const baseTypingDelay = message.length * baseDelayPerChar;
  const jitter = Math.random() * 1000 - 500;
  let totalDelay = baseTypingDelay + jitter;
  totalDelay = Math.max(500, Math.min(totalDelay, 10000));
  await humanDelay(totalDelay, 200);
}

async function interMessageDelay(min = 2000, max = 8000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await humanDelay(delay, 400);
}

module.exports = { humanTypingDelay, interMessageDelay };

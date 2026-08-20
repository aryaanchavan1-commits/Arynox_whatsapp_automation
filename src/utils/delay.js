function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function humanDelay(baseMs, jitterMs = 500) {
  const jitter = Math.random() * jitterMs * 2 - jitterMs;
  const delay = Math.max(100, baseMs + jitter);
  return sleep(delay);
}

module.exports = { sleep, getRandomInt, humanDelay };

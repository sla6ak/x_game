/**
 * async.js — мелкие асинхронные хелперы.
 */

function randomizeMs(baseMs, driftPercent = 0.1) {
  const drift = baseMs * driftPercent;
  const min = baseMs - drift;
  const max = baseMs + drift;
  return Math.round(min + Math.random() * (max - min));
}

/**
 * Пауза в миллисекундах.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { delay, randomizeMs };

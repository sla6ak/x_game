/**
 * async.js — мелкие асинхронные хелперы.
 */

/**
 * Пауза в миллисекундах.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { delay };

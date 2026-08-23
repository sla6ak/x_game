/**
 * coords.js — хелперы для игровых координат.
 *
 * Формат: "g:s:p" (планета) или "g:s:p*", "g:s:p*N" (луна).
 */

/**
 * Нормализация координат для сравнения: убираем суффикс луны (*, *N).
 * "1:363:6*" → "1:363:6"
 * @param {string|null} c
 * @returns {string|null}
 */
function normalizeCoords(c) {
  if (!c) return null;
  return c.replace(/\*\d*$/, "");
}

/**
 * Разобрать координаты в части.
 * @param {string} c — "1:363:6" или "1:363:6*"
 * @returns {{ galaxy: number, system: number, planet: number }}
 */
function splitCoords(c) {
  const [g, s, p] = String(c).replace(/\*\d*$/, "").split(":").map(Number);
  return { galaxy: g, system: s, planet: p };
}

module.exports = { normalizeCoords, splitCoords };

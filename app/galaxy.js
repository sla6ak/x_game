/**
 * galaxy.js — работа с галактикой: обзор системы, смена системы, поиск неактивных.
 *
 * Страницы:
 *   galaxy.php?mode=0&galaxy=G&system=S — обзор системы (таблица планет)
 *   galaxy.php?mode=1&galaxyGO=1&systemGO=S — смена системы (формы переключения)
 *
 * Цели для шпионажа/фарма: неактивные планеты (status = inactive / lolonginactive),
 * исключая наши тела (из bodies) и уже занятые миссиями координаты.
 */

const { fetchHtml } = require("./http");
const { parseGalaxy, filterInactive } = require("./parse-galaxy");

/**
 * Получить обзор системы.
 * @param {import('playwright').BrowserContext} context
 * @param {number} galaxy
 * @param {number} system
 * @returns {Promise<Object>} { galaxy, system, planets } (parseGalaxy)
 */
async function getSystem(context, galaxy, system) {
  const html = await fetchHtml(
    context,
    `/galaxy.php?mode=0&galaxy=${galaxy}&system=${system}`
  );
  return parseGalaxy(html);
}

/**
 * Переключить систему (как в меню: galaxy.php?mode=1&galaxyGO=1&systemGO=N).
 * Возвращает обзор новой системы.
 * @param {import('playwright').BrowserContext} context
 * @param {number} galaxy
 * @param {number} system
 * @returns {Promise<Object>} { galaxy, system, planets }
 */
async function switchSystem(context, galaxy, system) {
  const html = await fetchHtml(
    context,
    `/galaxy.php?mode=1&galaxyGO=1&systemGO=${system}&galaxy=${galaxy}`
  );
  return parseGalaxy(html);
}

/**
 * Найти неактивные цели в системе.
 * @param {Object} galaxyData — результат getSystem/switchSystem
 * @param {Object} opts — { ourCoords: Set<string>, busyCoords: Set<string>, includeVacation: bool }
 * @returns {Array} цели { coords, pos, player, status, hasMoon, galaxy, system }
 */
function findInactiveTargets(galaxyData, opts = {}) {
  const ourSet = new Set((opts.ourCoords || []).map(String));
  const busySet = new Set((opts.busyCoords || []).map(String));

  const inactive = filterInactive(galaxyData.planets, {
    includeVacation: !!opts.includeVacation,
  });

  return inactive
    .filter((p) => !ourSet.has(p.coords))
    .filter((p) => !busySet.has(p.coords))
    .map((p) => ({
      coords: p.coords,
      pos: p.pos,
      player: p.player,
      status: p.status,
      hasMoon: p.hasMoon,
      galaxy: galaxyData.galaxy,
      system: galaxyData.system,
    }));
}

module.exports = { getSystem, switchSystem, findInactiveTargets };

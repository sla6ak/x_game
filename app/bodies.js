/**
 * bodies.js — реестр наших тел (планеты + луны) с cp-идентификаторами.
 *
 * Извлекается из raw-HTML overview.php. Каждое тело:
 *   { coords, planet_cp, moon_cp, name, isHome }
 *
 * cp нужен для:
 *  - fleet.php?mode=3&...&planettype=<2|1> (флот тела)
 *  - эвакуации флота (fleet-safety)
 *  - экспедиций (expedition)
 *
 * Home-планета: planet_cp из findHome, moon_cp из config (в raw-HTML home-луна
 * не связана). Остальные планеты/луны — из блоков ov-pl-wrapper.
 */

const { findHome } = require("./parsers/overview");
const { normalizeCoords } = require("./helpers/coords");

/**
 * Извлечь все тела (планеты+луны) из raw-HTML overview.
 * @param {string} html — raw-HTML overview.php
 * @param {Object} opts — { homeCoords, homeMoonCp }
 * @returns {Array<{coords,planet_cp,moon_cp,name,isHome}>}
 */
function parseBodies(html, opts = {}) {
  const homeCoords = opts.homeCoords;
  const bodies = [];
  const seen = new Set();

  // --- Home-планета ---
  const home = findHome(html, homeCoords);
  if (home.planet_cp || home.moon_cp) {
    bodies.push({
      coords: homeCoords,
      planet_cp: home.planet_cp,
      moon_cp: home.moon_cp || opts.homeMoonCp || null,
      name: "БАЗА",
      isHome: true,
    });
    if (home.planet_cp) seen.add(home.planet_cp);
    if (home.moon_cp) seen.add(home.moon_cp);
  }

  // --- Остальные планеты (блоки ov-pl-wrapper) ---
  const blocks = html.split(/ov-pl-wrapper/);
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const coordM = b.match(/ov-location[^>]*><a[^>]*>(\d+:\d+:\d+)</);
    if (!coordM) continue;
    const coords = coordM[1];
    if (coords === homeCoords) continue; // home уже добавлен

    const planetCp =
      (b.match(/class="pl[^"]*"[^>]*onclick="switch_planet\((\d+)\)"/) || [])[1] ||
      null;
    const moonCp =
      (b.match(/mini_moon[^>]*onclick="switch_planet\((\d+)\)"/) || [])[1] ||
      null;

    // Название (из alt или из блока)
    const nameM = b.match(/alt="Название планеты:\s*([^"]*)"/);
    const name = nameM ? nameM[1].trim() : null;

    bodies.push({
      coords,
      planet_cp: planetCp,
      moon_cp: moonCp,
      name,
      isHome: false,
    });
    if (planetCp) seen.add(planetCp);
    if (moonCp) seen.add(moonCp);
  }

  return bodies;
}

/**
 * Найти тело по координатам.
 * @returns {Object|null}
 */
function findBody(bodies, coords) {
  return bodies.find((b) => b.coords === coords) || null;
}

/**
 * Список всех НЕ-атакуемых лун (для эвакуации).
 * @param {Array} bodies
 * @param {Array<string>} attackedCoords — координаты под атакой
 * @param {Object} [opts] — { excludeHome: "g:s:p" } — не использовать главную луну
 * @returns {Array<{coords,moon_cp}>}
 */
function safeMoons(bodies, attackedCoords = [], opts = {}) {
  const attacked = new Set(attackedCoords.map((c) => normalizeCoords(c)).filter(Boolean));
  const excludeHome = opts.excludeHome ? normalizeCoords(opts.excludeHome) : null;
  return bodies
    .filter((b) => b.moon_cp && !attacked.has(normalizeCoords(b.coords)))
    .filter((b) => !excludeHome || normalizeCoords(b.coords) !== excludeHome)
    .map((b) => ({ coords: b.coords, moon_cp: b.moon_cp }));
}

/**
 * Случайная безопасная луна (кроме главной и атакуемых).
 * @returns {{coords,moon_cp}|null}
 */
function pickRandomSafeMoon(bodies, attackedCoords = [], opts = {}) {
  const safe = safeMoons(bodies, attackedCoords, opts);
  if (!safe.length) return null;
  return safe[Math.floor(Math.random() * safe.length)];
}

module.exports = { parseBodies, findBody, safeMoons, pickRandomSafeMoon };

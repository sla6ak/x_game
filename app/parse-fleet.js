/**
 * parse-fleet.js — парсинг raw-HTML страницы fleet.php?cp=<cp>.
 *
 * Извлекает:
 *  - координаты тела (galaxy/system/planet/planet_type) из hidden-полей
 *  - слоты экспедиций (maxepedition / curepedition / free)
 *  - доступные корабли (ship<ID> + maxship<ID>)
 *  - активные флоты (fleetback_<id>)
 *
 * Корабль: <input name="ship203" alt="Большой танкер5424821143">
 *   alt = "<имя><макс_кол-во>" (без разделителя). Точное кол-во — в maxship<ID>.
 */

function getHidden(html, name) {
  const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  return m ? m[1] : null;
}

/**
 * Парсинг доступных кораблей.
 * @returns {Array<{id,name,available}>}
 */
function parseShips(html) {
  const ships = [];
  const seen = new Set();
  const shipRegex = /<input\b[^>]*name="(ship\d+)"[^>]*>/g;
  let m;
  while ((m = shipRegex.exec(html)) !== null) {
    const tag = m[0];
    const id = tag.match(/name="ship(\d+)"/)[1];
    if (seen.has(id)) continue;
    seen.add(id);

    // alt = "Название<кол-во>"
    const altMatch = tag.match(/alt="([^"]*)"/);
    const alt = altMatch ? altMatch[1] : "";

    // точное макс. кол-во из maxship<ID>
    const maxMatch = html.match(new RegExp(`name="maxship${id}" value="([^"]*)"`));
    const available = maxMatch ? maxMatch[1] : null;

    // имя = alt без хвоста-числа (available)
    let name = alt;
    if (available && alt.endsWith(available)) {
      name = alt.slice(0, -available.length);
    } else {
      const tail = alt.match(/(\d+)$/);
      if (tail) name = alt.slice(0, -tail[1].length);
    }

    ships.push({ id, name: name.trim(), available });
  }
  return ships;
}

/**
 * Парсинг кораблей дока из overlib-тултипа «Добавить флоты с дока».
 * В raw-HTML ship-инпуты (ship<ID>) рендерятся JS и часто отсутствуют,
 * но тултип дока содержит имена и количества кораблей.
 * Формат: <tr><td class='h'...>ИМЯ</td><td class='h'...><span>КОЛ-ВО</span></td></tr>
 * (одинарные кавычки могут быть экранированы как \')
 * @returns {Array<{id,name,available}>} id=null (id не в тултипе)
 */
function parseDockShips(html) {
  const ships = [];
  const seen = new Set();
  const anchorIdx = html.indexOf("Добавить флоты с дока");
  if (anchorIdx < 0) return ships;
  const region = html.substring(anchorIdx, anchorIdx + 6000);
  const rowRegex = /<td class=\\?['"]h\\?['"][^>]*>([^<]+)<\/td>\s*<td class=\\?['"]h\\?['"][^>]*><span[^>]*>([\d\s]+)<\/span>/g;
  let m;
  while ((m = rowRegex.exec(region)) !== null) {
    const name = m[1].trim();
    const count = parseInt(m[2].replace(/\D/g, ""), 10);
    if (!name || isNaN(count)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    ships.push({ id: null, name, available: count });
  }
  return ships;
}

/**
 * Парсинг активных флотов (fleetback_<id>).
 * @returns {Array<string>} id флотов
 */
function parseActiveFleets(html) {
  const ids = [...html.matchAll(/name="fleetback_(\d+)"/g)].map((m) => m[1]);
  return [...new Set(ids)];
}

/**
 * Полный парсинг fleet-страницы.
 * @param {string} html
 */
function parseFleet(html) {
  const maxexp = getHidden(html, "maxepedition");
  const curexp = getHidden(html, "curepedition");
  const max = maxexp != null ? parseInt(maxexp, 10) : null;
  const current = curexp != null ? parseInt(curexp, 10) : null;

  return {
    galaxy: getHidden(html, "galaxy"),
    system: getHidden(html, "system"),
    planet: getHidden(html, "planet"),
    planet_type: getHidden(html, "planet_type"),
    coords:
      getHidden(html, "galaxy") != null
        ? `${getHidden(html, "galaxy")}:${getHidden(html, "system")}:${getHidden(html, "planet")}`
        : null,
    maxepedition: max,
    curepedition: current,
    freeSlots: max != null && current != null ? max - current : null,
    // ship-инпуты (с id) — если есть в raw-HTML; иначе корабли дока из тултипа (без id)
    ships: parseShips(html),
    dockShips: parseDockShips(html),
    activeFleetIds: parseActiveFleets(html),
  };
}

module.exports = { parseFleet, parseShips, parseDockShips, parseActiveFleets, getHidden };

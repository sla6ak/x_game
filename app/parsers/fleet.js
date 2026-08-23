/**
 * fleet.js — парсинг raw-HTML страницы fleet.php?cp=<cp>.
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

const { normalizeCoords } = require("../helpers/coords");

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
 * Парсинг активных миссий со страницы fleet.php (строки с формой [Отозвать]).
 * Каждая строка миссии содержит форму <form name="fleetback_<fleet_id>" action="fleetback.php">.
 * Из строки извлекаем: fleet_id, тип миссии, координаты [от] [куда].
 * @param {string} html — raw-HTML fleet.php?cp=<cp>
 * @returns {Array<{fleetId, type, from, to}>}
 */
function parseActiveMissions(html) {
  const missions = [];
  const chunks = html.split(/<tr[\s>]/);
  for (const chunk of chunks) {
    const fm = chunk.match(/name="fleetback_(\d+)"/);
    if (!fm) continue;
    const fleetId = fm[1];
    const text = chunk.replace(/<[^>]+>/g, " ");
    // координаты вида [1:363:6] или [1:363:6]* (луна)
    const coords = [...text.matchAll(/\[(\d+):(\d+):(\d+)(\*\d*)?\]/g)].map(
      (x) => `${x[1]}:${x[2]}:${x[3]}`,
    );
    const typeM = text.match(
      /Экспедиция|Атаковать|Атака|Транспорт|Оставить|Шпионаж|Добыча ТМ|Ишкофарм/,
    );
    missions.push({
      fleetId,
      type: typeM ? typeM[0] : "unknown",
      from: coords[0] || null,
      to: coords[1] || null,
    });
  }
  return missions;
}

/**
 * Парсинг текстовых счётчиков «Флоты X из Y» и «Экспедиции X из Y».
 * Формат в raw-HTML: «Флоты <span style="color: #E6EBFB">7</span> из 42».
 * «Флоты» — ОБЩЕЕ количество миссий (то, что нужно для фарма),
 * «Экспедиции» — только слоты с целью «экспедиция».
 */
function parseCounter(html, label) {
  const re = new RegExp(label + "\\s*<span[^>]*>(\\d+)</span>\\s*из\\s*(\\d+)");
  const m = html.match(re);
  if (!m) return { used: null, max: null };
  return { used: parseInt(m[1], 10), max: parseInt(m[2], 10) };
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

  // Текстовые счётчики (основной источник)
  const fleet = parseCounter(html, "Флоты");
  const exp = parseCounter(html, "Экспедиции");

  // Слоты экспедиций: из текста, fallback — hidden-поля
  const expMax = exp.max != null ? exp.max : max;
  const expUsed = exp.used != null ? exp.used : current;

  // ОБЩИЕ свободные миссии: из текста «Флоты X из Y».
  // Fallback (если текст не распарсился) — hidden-поля экспедиций,
  // но это НЕВЕРНАЯ семантика (только экспедиционные слоты) — помечаем source.
  let freeSlots = null;
  let freeSlotsSource = null;
  if (fleet.max != null && fleet.used != null) {
    freeSlots = fleet.max - fleet.used;
    freeSlotsSource = "text";
  } else if (max != null && current != null) {
    freeSlots = max - current;
    freeSlotsSource = "expedition-hidden-fallback";
  }

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
    // ОБЩИЕ миссии (для фарма): «Флоты X из Y»
    fleetUsed: fleet.used,
    fleetMax: fleet.max,
    freeSlots, // = fleetMax - fleetUsed
    freeSlotsSource,
    // Слоты экспедиций: «Экспедиции X из Y» (fallback hidden-поля)
    expUsed: expUsed,
    expMax: expMax,
    freeExpeditionSlots: expMax != null && expUsed != null ? expMax - expUsed : null,
    // ship-инпуты (с id) — если есть в raw-HTML; иначе корабли дока из тултипа (без id)
    ships: parseShips(html),
    dockShips: parseDockShips(html),
    activeFleetIds: parseActiveFleets(html),
  };
}

module.exports = { parseFleet, parseShips, parseDockShips, parseActiveFleets, parseActiveMissions, normalizeCoords, getHidden };

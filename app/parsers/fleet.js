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
  // ВАЖНО: нельзя резать html по <tr> — в тултипах overlib внутри атрибутов
  // есть литеральные <tr> (например '<table width=100><tr><td class=h>08.09
  // 06:08:45</td></tr></table>'), и split разрезает строку миссии посередине.
  // Структура строки (данные ПЕРЕД формой fleetback_):
  //   <th>№</th><th флот (тултип с кораблями)></th><th тип>Оставить</th>
  //   <th численность</th><th [g:s:p]* источник (тултип: время прибытия)</th>
  //   <th>— или время возврата</th><th [g:s:p]* цель или "-" (докован)</th>
  //   <th><form name="fleetback_ID"><input fleetid>…
  // Для каждой формы берём сегмент от предыдущей формы до этой — он содержит
  // только текущую строку (форма предыдущей строки — в конце предыдущей).
  const forms = [...html.matchAll(/name="fleetback_(\d+)"/g)];
  for (let i = 0; i < forms.length; i++) {
    const segStart = i > 0 ? forms[i - 1].index : 0;
    const segEnd = Math.min(html.length, forms[i].index + 500);
    const seg = html.substring(segStart, segEnd);
    const text = seg
      .replace(/\son(?:mouseover|mouseout|mousemove|click|focus|blur)="[^"]*"/g, " ")
      .replace(/\stitle="[^"]*"/g, " ")
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();

    // Координаты: последние две в сегменте = [источник, цель] этой строки.
    // У докованного флота цели нет (ячейка "-") → to = null.
    const coords = [...text.matchAll(/\[(\d+):(\d+):(\d+)(\*\d*)?\]/g)].map(
      (c) => c[0].slice(1, -1),
    );
    let from = null;
    let to = null;
    if (coords.length >= 2) {
      from = coords[coords.length - 2];
      to = coords[coords.length - 1];
    } else if (coords.length === 1) {
      from = coords[0];
    }

    // Тип: ищем в хвостовом окне (ячейка типа — сразу перед координатами).
    const typeWindow = text.substring(Math.max(0, text.length - 1500));
    const TYPE_KEYWORDS = [
      [/экспедиц/i, "expedition"],
      [/атак|штурм/i, "attack"],
      [/шпионаж|разведк/i, "spy"],
      [/трансп|доставк/i, "transport"],
      [/перераб/i, "recycle"],
      [/добыч|ресурс|металл|уран|алмаз/i, "harvest"],
      [/остав/i, "leave"],
      [/возврат|возвраща/i, "return"],
    ];
    let type = null;
    for (const [re, t] of TYPE_KEYWORDS) {
      if (re.test(typeWindow)) {
        type = t;
        break;
      }
    }

    missions.push({
      fleetId: forms[i][1],
      type: type || "unknown",
      from,
      to,
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

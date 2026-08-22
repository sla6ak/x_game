/**
 * parse-galaxy.js — парсинг raw-HTML страницы galaxy.php?mode=0 (обзор системы).
 *
 * Извлекает по каждой планете системы:
 *  - pos       — позиция (номер планеты)
 *  - name      — название планеты
 *  - player    — ник игрока (null если пусто)
 *  - status    — статус: 'active' | 'inactive' | 'lolonginactive' | 'vacation'
 *  - hasMoon   — есть ли луна
 *  - coords    — "g:s:p"
 *  - actions   — ссылки быстрых действий (шпионаж/атака/транспорт) для планеты и луны
 *
 * ВАЖНО: ссылки действий (Шпионаж/Атаковать/Транспорт) находятся ВНУТРИ
 * тултипа overlib, т.е. в атрибуте onmouseover="return overlib('...')".
 * Поэтому парсим raw-HTML и НЕ вырезаем onmouseover — ищем href внутри него.
 *
 * Структура строки:
 *   <th width=15><a alt="Позиция: N" href=#fleet.php?...&planettype=0&target_mission=7>N</a></th>
 *   <th><a class="pl-big-px pl-big-XX" onmouseover="return overlib('...<a href=\'#fleet.php?...&target_mission=6&210=500001\'>Шпионаж</a>...')"></a></th>
 *   <th alt="Название планеты: NAME">...</th>
 *   <th><a class="mn-big-px" ...></a></th>
 *   <th><a alt="Игрок: PLAYER" href="#user.php?id=ID"><span class="STATUS">PLAYER</span></a></th>
 *
 * planettype: 1=планета, 3=луна (чужая). target_mission: 1=атака, 3=транспорт, 6=шпионаж.
 */

/**
 * Найти ссылку действия по названию (Шпионаж/Атаковать/Транспорт) внутри региона raw-HTML.
 * href может быть с экранированными кавычками: href=\'#fleet.php?...\'
 * @returns {Object|null} { url, galaxy, system, planet, planettype, target_mission }
 */
function findAction(region, label) {
  // href=(опц. кавычка)URL(опц. кавычка) ... >label</a>
  const re = new RegExp(
    "href=(?:\\\\?['\\\"])([^'\\\"\\\\]+?)(?:\\\\?['\\\"])[^>]*>(?:<font[^>]*>)?" +
      label +
      "(?:</font>)?</a>",
    "i"
  );
  const m = region.match(re);
  if (!m) return null;
  let url = m[1].replace(/^#/, "").replace(/\\'/g, "'");
  const get = (name) => {
    const mm = url.match(new RegExp(name + "=(\\d+)"));
    return mm ? mm[1] : null;
  };
  return {
    url,
    galaxy: get("galaxy"),
    system: get("system"),
    planet: get("planet"),
    planettype: get("planettype"),
    target_mission: get("target_mission"),
  };
}

/**
 * Парсинг страницы галактики (одной системы).
 * @param {string} html — raw-HTML galaxy.php?mode=0
 * @returns {{galaxy:string, system:string, planets:Array}}
 */
function parseGalaxy(html) {
  // Определяем галаксию и систему из первой ссылки
  const sysMatch = html.match(/galaxy=(\d+)&system=(\d+)&planet=\d+/);
  const galaxy = sysMatch ? sysMatch[1] : null;
  const system = sysMatch ? sysMatch[2] : null;

  const planets = [];
  // Разбиваем по якорям позиций: <a alt="Позиция: N"
  const parts = html.split(/<a\s+alt="Позиция:\s*(\d+)"[^>]*>/);
  for (let i = 1; i < parts.length; i += 2) {
    const pos = parts[i];
    const content = parts[i + 1] || "";

    const nameM = content.match(/alt="Название планеты:\s*([^"]*)"/);
    const playerM = content.match(/alt="Игрок:\s*([^"]+)"/);
    const hasMoon = /class="mn-big-px/.test(content);

    // Статус: span с классом сразу после якоря игрока
    let status = "active";
    if (playerM) {
      const after = content.slice(playerM.index, playerM.index + 900);
      const sm = after.match(/<span class="([^"]+)">/);
      if (sm) status = sm[1];
    }

    // Действия: первая группа — планета (planettype=1), вторая — луна (planettype=3)
    const actions = {
      planet: {},
      moon: {},
    };
    for (const label of ["Шпионаж", "Атаковать", "Транспорт"]) {
      // Собираем ВСЕ вхождения, чтобы разделить планету и луну
      const re = new RegExp(
        "href=(?:\\\\?['\\\"])([^'\\\"\\\\]+?)(?:\\\\?['\\\"])[^>]*>(?:<font[^>]*>)?" +
          label +
          "(?:</font>)?</a>",
        "gi"
      );
      let m;
      const found = [];
      while ((m = re.exec(content)) !== null) {
        let url = m[1].replace(/^#/, "").replace(/\\'/g, "'");
        const pt = (url.match(/planettype=(\d+)/) || [])[1] || null;
        const tm = (url.match(/target_mission=(\d+)/) || [])[1] || null;
        found.push({
          url,
          galaxy: (url.match(/galaxy=(\d+)/) || [])[1],
          system: (url.match(/system=(\d+)/) || [])[1],
          planet: (url.match(/planet=(\d+)/) || [])[1],
          planettype: pt,
          target_mission: tm,
        });
      }
      // планета = planettype 1 (или 0), луна = planettype 3
      const key =
        label === "Шпионаж" ? "spy" : label === "Атаковать" ? "attack" : "transport";
      for (const f of found) {
        if (f.planettype === "3") actions.moon[key] = f;
        else actions.planet[key] = f;
      }
    }

    planets.push({
      pos: parseInt(pos, 10),
      name: nameM ? nameM[1].trim() : null,
      player: playerM ? playerM[1].trim() : null,
      status,
      hasMoon,
      coords: `${galaxy}:${system}:${pos}`,
      actions,
    });
  }

  return { galaxy, system, planets };
}

/**
 * Фильтр неактивных планет (цели для шпионажа/фарма).
 * @param {Array} planets
 * @param {Object} opts — { includeVacation: bool }
 */
function filterInactive(planets, opts = {}) {
  const { includeVacation = false } = opts;
  return planets.filter((p) => {
    if (!p.player) return false;
    if (p.status === "inactive" || p.status === "lolonginactive") return true;
    if (includeVacation && p.status === "vacation") return true;
    return false;
  });
}

module.exports = { parseGalaxy, filterInactive, findAction };

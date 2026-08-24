/**
 * galaxy.js — парсинг raw-HTML страницы galaxy.php?mode=0 (обзор системы).
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
    "i",
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
function detectCurrentSystem(html) {
  const currentFormSystem = html.match(/name="system"[^>]*value="(\d+)"/i);
  if (currentFormSystem && currentFormSystem[1]) return currentFormSystem[1];

  const directHeader = html.match(
    /<span[^>]*>\s*Система\s*<\/span>[\s\S]*?<a[^>]*href="[^"]*galaxyGO=1[^\"]*systemGO=(\d+)"[^>]*>/i,
  );
  if (directHeader && directHeader[1]) return directHeader[1];

  const directModeOne = html.match(/galaxyGO=1[^\"]*systemGO=(\d+)/i);
  if (directModeOne && directModeOne[1]) return directModeOne[1];

  const currentCoords = html.match(
    /title="Текущие координаты"[^>]*href="[^"]*galaxy=(\d+)[^"]*system=(\d+)[^"]*planet=\d+"/i,
  );
  if (currentCoords && currentCoords[2]) return currentCoords[2];

  const firstSystemLink = html.match(
    /galaxy=(\d+)[^\n]*system=(\d+)[^\n]*planet=\d+/i,
  );
  if (firstSystemLink && firstSystemLink[2]) return firstSystemLink[2];

  return null;
}

function detectCurrentGalaxy(html) {
  const currentFormGalaxy = html.match(/name="galaxy"[^>]*value="(\d+)"/i);
  if (currentFormGalaxy && currentFormGalaxy[1]) return currentFormGalaxy[1];

  const currentCoords = html.match(
    /title="Текущие координаты"[^>]*href="[^"]*galaxy=(\d+)[^"]*system=(\d+)[^"]*planet=\d+"/i,
  );
  if (currentCoords && currentCoords[1]) return currentCoords[1];

  const firstGalaxyLink = html.match(/galaxy=(\d+)[^\n]*system=(\d+)/i);
  if (firstGalaxyLink && firstGalaxyLink[1]) return firstGalaxyLink[1];

  return null;
}

function parseGalaxy(html) {
  // В HTML есть несколько ссылок на разные системы: текущая луны, навигация
  // влево/вправо, а также общие ссылки в шапке. Источником истины должен быть
  // input формы просмотра текущей системы, а не первый попавшийся текст.
  const galaxy = detectCurrentGalaxy(html);
  const system = detectCurrentSystem(html);

  const planets = [];
  // Разбиваем по якорям позиций: <a alt="Позиция: N"
  const parts = html.split(/<a\s+alt="Позиция:\s*(\d+)"[^>]*>/);
  for (let i = 1; i < parts.length; i += 2) {
    const pos = parts[i];
    const content = parts[i + 1] || "";

    const nameM = content.match(/alt="Название планеты:\s*([^"]*)"/);
    const playerM = content.match(/alt="Игрок:\s*([^"]+)"/);
    const hasMoon = /class="mn-big-px/.test(content);

    // Статус: сначала ищем реальные статусы неактивности, потому что в HTML
    // игроки в отпуске часто содержат вложенный span class="inactive" внутри
    // внешнего <span class="vacation">. Если взять первый span, получаем ложный
    // "vacation" для цели, которую надо фармить.
    let status = "active";
    if (playerM) {
      const after = content.slice(playerM.index, playerM.index + 1500);
      const classes = [...after.matchAll(/class="([^"]+)"/g)].map((m) => m[1]);
      const inactiveOrder = [
        "lolonginactive",
        "longinactive",
        "i_inactive",
        "inactive",
      ];
      const hasVacation = classes.includes("vacation");
      const hasBanned = classes.includes("banned");
      const foundInactive = inactiveOrder.find((cls) => classes.includes(cls));
      if (hasVacation) {
        status = "vacation";
      } else if (hasBanned) {
        status = "banned";
      } else if (foundInactive) {
        status = foundInactive;
      } else if (classes.includes("strong") || classes.includes("noob")) {
        status = "active";
      }
    }

    // Важное правило: игроки в отпуске/бане не участвуют в фарме и не должны
    // попадать в общий список целей на шпионаж ни через парсер, ни через
    // дальнейшие фильтры.
    if (status === "vacation" || status === "banned") continue;

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
        "gi",
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
        label === "Шпионаж"
          ? "spy"
          : label === "Атаковать"
            ? "attack"
            : "transport";
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
  const inactiveStatuses = new Set([
    "inactive",
    "i_inactive",
    "longinactive",
    "lolonginactive",
  ]);

  return planets.filter((p) => {
    if (!p.player) return false;
    if (p.status === "vacation" || p.status === "banned") return false;
    if (inactiveStatuses.has(p.status)) return true;
    if (includeVacation && p.status === "vacation") return true;
    return false;
  });
}

// Alias for compatibility with earlier logic names; some modules expect a
// helper that can be called without passing specific options.
function isFarmTargetPlanet(p, opts = {}) {
  const { includeVacation = false } = opts;
  return !!p?.player && filterInactive([p], { includeVacation }).length > 0;
}

module.exports = { parseGalaxy, filterInactive, findAction };

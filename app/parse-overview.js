/**
 * parse-overview.js — парсинг raw-HTML страницы overview.php.
 *
 * Извлекает:
 *  - home: координаты, planet_cp, moon_cp (работает и для desktop, и для mobile)
 *  - missions: все миссии (holding = исходящие, return = возвращающиеся)
 *  - attacks: исходящие атаки (Задание: Атаковать) + эвристические входящие
 *
 * Desktop-формат overview:  a.mini_moon onclick="switch_planet(31694)"
 * Mobile-формат overview:   <option value="?cp=31694&mode=0&info=">Луна [1:363:6]*</option>
 */

/**
 * Найти home-планету и её луну.
 * @param {string} html — raw-HTML overview
 * @param {string} homeCoords — координаты вида "1:363:6"
 */
function findHome(html, homeCoords) {
  const result = {
    coords: homeCoords,
    planet_cp: null,
    moon_cp: null,
    source: null,
  };
  const coordLabel = `[${homeCoords}]`;

  // --- Mobile-формат: dropdown <option value="?cp=..."> ---
  const options = [
    ...html.matchAll(
      /<option[^>]*value="\?cp=(\d+)&[^"]*"[^>]*>([\s\S]*?)<\/option>/g,
    ),
  ].map((m) => ({
    cp: m[1],
    label: m[2]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .replace(/&nbsp;/g, " ")
      .trim(),
  }));

  const planetOpt = options.find(
    (o) => o.label.includes(coordLabel) && !/луна/i.test(o.label),
  );
  const moonOpt = options.find(
    (o) => o.label.includes(coordLabel) && /луна/i.test(o.label),
  );

  if (planetOpt || moonOpt) {
    result.planet_cp = planetOpt ? planetOpt.cp : null;
    result.moon_cp = moonOpt ? moonOpt.cp : null;
    result.source = "mobile-dropdown";
    return result;
  }

  // --- Desktop-формат: switch_planet(...) ---
  // Home-блок: <div class="ov-pl-block mooned"> ... <a ...>1:363:6</a> ... switch_planet(<cp>)
  // Координаты в raw-HTML БЕЗ скобок: <a href=#galaxy.php?...>1:363:6</a>
  const coordPlain = homeCoords; // "1:363:6"
  const anchorIdx = html.indexOf(`>${coordPlain}</a>`);
  if (anchorIdx >= 0) {
    // Ищем начало home-блока (ov-pl-block) перед координатами
    const blockStart = html.lastIndexOf("ov-pl-block", anchorIdx);
    const regionStart =
      blockStart >= 0 ? blockStart : Math.max(0, anchorIdx - 2000);
    const region = html.substring(regionStart, anchorIdx + 4000);

    // planet cp: ПЕРВЫЙ switch_planet в home-блоке (это сама home-планета).
    // НО: у home-планеты иконка имеет класс mini_moon, поэтому НЕ используем
    // mini_moon-матч для moon_cp (он ложно совпадёт с самой home-планетой).
    const planetMatch = region.match(/switch_planet\((\d+)\)/);
    if (planetMatch) {
      result.planet_cp = planetMatch[1];
      result.source = "desktop-switch_planet";
    }
    // moon_cp: в raw-HTML home-луна НЕ связана (рендерится JS). Оставляем null —
    // вызывающий код подставит moon_cp из config (moonCp).
    result.moon_cp = null;
  }

  return result;
}

/**
 * Парсинг всех миссий.
 * Миссии в raw-HTML отделены маркерами: <!-- class="holding " --> / <!-- class="return " -->
 * Внутри div: текст "Ваш флот ... Задание: <тип>", координаты [g:s:p].
 */
function parseMissions(html) {
  const missions = [];
  const seen = new Set();

  const extract = (direction, divHtml) => {
    // Убираем onmouseover/onmouseout/title-атрибуты (в них overlib с вложенным HTML,
    // который ломает простую очистку тегов), затем теги и сущности.
    let t = divHtml
      .replace(
        /\son(?:mouseover|mouseout|mousemove|click|focus|blur)="[^"]*"/g,
        " ",
      )
      .replace(/\stitle="[^"]*"/g, " ");
    t = t.replace(/<script[\s\S]*?<\/script>/g, " ");
    const text = t
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    if (!text.includes("Задание:")) return;
    const typeMatch = text.match(/Задание:\s*(.+)$/);
    const type = typeMatch ? typeMatch[1].trim() : "unknown";
    const coords = [...text.matchAll(/\[(\d+):(\d+):(\d+(?::\d+)?)\]/g)].map(
      (c) => c[0].slice(1, -1),
    );
    if (seen.has(text)) return;
    seen.add(text);
    missions.push({
      direction, // holding=исходящая, return=возвращающаяся
      type,
      text,
      coords,
      is_returning: direction === "return" || text.includes("возвращается"),
    });
  };

  // --- Мобильный формат: миссии внутри <tr class="holding|return"> ---
  // <tr class="holding"> ... <div>...Задание: Экспедиция [10]</div> <!-- class="holding " --> ... </tr>
  const parts = html.split(/<tr class="(holding|return)">/);
  for (let i = 1; i < parts.length; i += 2) {
    const direction = parts[i]; // holding | return
    const content = parts[i + 1] || "";
    const z = content.indexOf("Задание:");
    if (z < 0) continue;
    const divStart = content.lastIndexOf("<div", z);
    const divEnd = content.indexOf("</div>", z);
    const divHtml =
      divStart >= 0 && divEnd > 0
        ? content.substring(divStart, divEnd + 6)
        : content.substring(Math.max(0, z - 400), z + 120);
    extract(direction, divHtml);
  }

  // --- Десктопный формат: маркер <!-- class="..." --> ПЕРЕД div (fallback) ---
  if (missions.length === 0) {
    const markerRegex =
      /<!--\s*class="(holding|return|flight)\s*"\s*-->\s*(<div[\s\S]*?<\/div>)/g;
    let m;
    while ((m = markerRegex.exec(html)) !== null) {
      extract(m[1], m[2]);
    }
  }

  return missions;
}

/**
 * Парсинг атак.
 * - outgoing: миссии с типом "Атаковать" (флоты игрока, летящие атаковать)
 * - incoming: эвристический поиск по ключевым словам (нет реального образца)
 */
function parseAttacks(html, missions) {
  const outgoing = missions.filter((m) => /атак/i.test(m.type));

  // Входящие атаки — эвристика по ключевым словам.
  // ВНИМАНИЕ: нет реального образца входящей атаки, список слов настраивается.
  const incomingKeywords = [
    "Чужой флот игрока",
    "Чужой флот",
    "чужой флот игрока",
    "чужой флот",
    "вражеский флот",
  ];
  const incoming = [];
  for (const kw of incomingKeywords) {
    const idx = html.toLowerCase().indexOf(kw.toLowerCase());
    if (idx >= 0) {
      incoming.push({
        keyword: kw,
        snippet: html
          .substring(Math.max(0, idx - 200), idx + 300)
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      });
    }
  }

  return { outgoing, incoming };
}

/**
 * Полный парсинг overview.
 * @param {string} html
 * @param {string} homeCoords
 */
function parseOverview(html, homeCoords) {
  const home = findHome(html, homeCoords);
  const missions = parseMissions(html);
  const attacks = parseAttacks(html, missions);
  return { home, missions, attacks };
}

module.exports = { parseOverview, findHome, parseMissions, parseAttacks, parseBodies };

/**
 * Извлечь все наши тела (планеты и луны) с cp.
 * Mobile-формат: <option value="?cp=<cp>&mode=0&info=">Название [G:S:P]</option>
 * Desktop-fallback: switch_planet(<cp>) + ближайшие координаты.
 * @param {string} html — raw-HTML overview
 * @returns {Array} [{ cp, coords, type: 'planet'|'moon', name }]
 */
function parseBodies(html) {
  const bodies = [];
  const seen = new Set();

  // --- Mobile: dropdown-опции ---
  for (const m of html.matchAll(/<option[^>]*value="\?cp=(\d+)&[^"]*"[^>]*>([\s\S]*?)<\/option>/g)) {
    const cp = m[1];
    if (seen.has(cp)) continue;
    const label = m[2].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    const cM = label.match(/\[(\d+):(\d+):(\d+)\]/);
    if (!cM) continue;
    seen.add(cp);
    const isMoon = /луна/i.test(label);
    const name = label.replace(/\[\d+:\d+:\d+\]\*?/, "").trim();
    bodies.push({ cp, coords: `${cM[1]}:${cM[2]}:${cM[3]}`, type: isMoon ? "moon" : "planet", name });
  }

  // --- Desktop-fallback: switch_planet ---
  if (!bodies.length) {
    for (const m of html.matchAll(/switch_planet\((\d+)\)/g)) {
      const cp = m[1];
      if (seen.has(cp)) continue;
      const before = html.substring(Math.max(0, m.index - 3000), m.index);
      const cMs = [...before.matchAll(/(\d+):(\d+):(\d+)/g)];
      if (!cMs.length) continue;
      seen.add(cp);
      const c = cMs[cMs.length - 1];
      const between = html.substring(Math.max(0, m.index - 600), m.index);
      bodies.push({
        cp,
        coords: `${c[1]}:${c[2]}:${c[3]}`,
        type: /Луна/.test(between) ? "moon" : "planet",
        name: null,
      });
    }
  }

  return bodies;
}

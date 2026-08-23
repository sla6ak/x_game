/**
 * overview.js — парсинг raw-HTML страницы overview.php.
 *
 * Извлекает:
 *  - home: координаты, planet_cp, moon_cp (работает и для desktop, и для mobile)
 *  - missions: все миссии (holding = исходящие, return = возвращающиеся)
 *  - attacks: исходящие атаки (Задание: Атаковать) + эвристические входящие
 *
 * Тела (планеты/луны) — в ../bodies.js (parseBodies с home-обработкой).
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
 * ETA миссии из JS-счётчика overview (ppXXX = секунды до прибытия).
 * @param {string} html
 * @param {string} text — текст миссии (фрагмент для поиска блока)
 * @returns {number|null} ms
 */
function parseMissionEtaMs(html, text) {
  if (!text) return null;
  const needle = text.substring(0, Math.min(80, text.length));
  const idx = html.indexOf(needle);
  if (idx < 0) return null;
  const region = html.substring(Math.max(0, idx - 800), idx + 400);
  const ppM = region.match(/pp\w+\s*=\s*(\d+)/);
  if (!ppM) return null;
  return parseInt(ppM[1], 10) * 1000;
}

/**
 * Координаты цели входящей атаки и признак «атака на луну».
 * @param {string} text — текст миссии overview
 * @returns {{ coords: string|null, isMoon: boolean }}
 */
function parseIncomingTarget(text) {
  const moonM = text.match(
    /(?:на\s+(?:нашей\s+)?лун[а-я]*[^[]*)?\[(\d+:\d+:\d+)\*\]/i,
  );
  if (moonM) return { coords: moonM[1], isMoon: true };

  const planetM = text.match(
    /на\s+(?:нашей\s+)?планет[а-я]*[^[]*\[(\d+:\d+:\d+)\]/i,
  );
  if (planetM) return { coords: planetM[1], isMoon: false };

  const all = [...text.matchAll(/\[(\d+:\d+:\d+)(\*\d*)?\]/g)];
  if (all.length) {
    const last = all[all.length - 1];
    return { coords: last[1], isMoon: !!last[2] };
  }
  return { coords: null, isMoon: /лун/i.test(text) };
}

/**
 * Парсинг атак.
 * - outgoing: наши миссии «Атаковать»
 * - incoming: строки overview с «Чужой флот» (+ fallback по ключевым словам)
 */
function parseAttacks(html, missions, extraKeywords = []) {
  const outgoing = missions.filter(
    (m) => /атак/i.test(m.type) && !/чужой/i.test(m.text),
  );

  const incoming = [];
  const seen = new Set();

  const pushIncoming = (item) => {
    const key = `${item.coords || "?"}|${(item.snippet || "").substring(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    incoming.push(item);
  };

  // Основной источник: миссии overview с «Чужой флот»
  for (const m of missions) {
    if (!/чужой\s+флот/i.test(m.text)) continue;
    const { coords, isMoon } = parseIncomingTarget(m.text);
    pushIncoming({
      coords,
      isMoon,
      etaMs: parseMissionEtaMs(html, m.text),
      snippet: m.text.substring(0, 300),
      source: "mission-row",
    });
  }

  // Fallback: ключевые слова в HTML (если формат строки изменился)
  const incomingKeywords = [
    "Чужой флот игрока",
    "Чужой флот",
    "чужой флот",
    "вражеский флот",
    ...extraKeywords,
  ];
  for (const kw of incomingKeywords) {
    const idx = html.toLowerCase().indexOf(kw.toLowerCase());
    if (idx < 0) continue;
    const snippet = html
      .substring(Math.max(0, idx - 200), idx + 400)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const plain = snippet;
    const { coords, isMoon } = parseIncomingTarget(plain);
    pushIncoming({
      keyword: kw,
      coords,
      isMoon,
      etaMs: parseMissionEtaMs(html, plain.substring(0, 80)),
      snippet: plain.substring(0, 300),
      source: "keyword",
    });
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

module.exports = {
  parseOverview,
  findHome,
  parseMissions,
  parseAttacks,
  parseIncomingTarget,
  parseMissionEtaMs,
};

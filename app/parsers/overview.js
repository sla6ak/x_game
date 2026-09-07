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
/**
 * Класс <tr class="..."> → направление миссии.
 * holding=исходящая, return=возвращающаяся, flight=в пути, incoming=входящая (чужая).
 * Неизвестный класс → "incoming" (безопасно: чужой флот лучше распознать, чем пропустить).
 * @param {string} cls
 */
function classToDirection(cls) {
  const c = String(cls || "");
  if (/holding/.test(c)) return "holding";
  if (/return/.test(c)) return "return";
  if (/flight/.test(c)) return "flight";
  return "incoming";
}

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

  // --- Мобильный формат: миссии внутри <tr class="..."> ---
  // <tr class="holding"> ... <div>...Задание: Экспедиция [10]</div> ... </tr>
  //
  // ВАЖНО: парсим ВСЕ <tr class="..."> строки, содержащие "Задание:", а не только
  // holding/return. Входящий ЧУЖОЙ флот («Чужой флот ... Задание: Атаковать») может
  // иметь ДРУГОЙ tr class (например "incoming"/"flight"). Если парсить только
  // holding/return, бот вообще не увидит входящую атаку и safety-чек отработает
  // с входящие=0 — именно так и произошло: чужой флот летел на луну, а бот не увидел.
  const parts = html.split(/<tr class="([^"]+)">/);
  for (let i = 1; i < parts.length; i += 2) {
    const cls = parts[i];
    const content = parts[i + 1] || "";
    const z = content.indexOf("Задание:");
    if (z < 0) continue;
    const direction = classToDirection(cls);
    const divStart = content.lastIndexOf("<div", z);
    const divEnd = content.indexOf("</div>", z);
    const divHtml =
      divStart >= 0 && divEnd > 0
        ? content.substring(divStart, divEnd + 6)
        : content.substring(Math.max(0, z - 400), z + 120);
    extract(direction, divHtml);
  }

  // --- Десктопный формат: маркер <!-- class="..." --> ПЕРЕД div (fallback) ---
  // Парсим маркер с ЛЮБЫМ class (не только holding/return/flight) — см. classToDirection.
  if (missions.length === 0) {
    const markerRegex =
      /<!--\s*class="([^"]+)"\s*-->\s*(<div[\s\S]*?<\/div>)/g;
    let m;
    while ((m = markerRegex.exec(html)) !== null) {
      extract(classToDirection(m[1]), m[2]);
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
 *
 * Для live-строк OGame форма обычно такая:
 *   "... с луны Moon [[2:795:15]*] ... на луну Луна [[1:363:6]*] ... Задание: Атаковать"
 * Важно: ищем ссылку на нашу цель по слову "Луна" / "Moon" и только потом берём
 * соответствующую координату. Не используем первый попавшийся координатный блок.
 *
 * @param {string} text — текст миссии overview
 * @returns {{ coords: string|null, isMoon: boolean }}
 */
function parseIncomingTarget(text) {
  const raw = String(text || "");
  const normalized = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const targetWords = [...normalized.matchAll(/Луна|Moon|Планета|Planet/gi)];
  if (targetWords.length) {
    const lastWord = targetWords[targetWords.length - 1];
    const afterWord = normalized.slice(lastWord.index + lastWord[0].length);
    const coordMatch = afterWord.match(/(\d+:\d+:\d+)/);
    if (coordMatch) {
      return {
        coords: coordMatch[1],
        isMoon: /Луна|Moon/i.test(lastWord[0]),
      };
    }
  }

  const all = [...normalized.matchAll(/(\d+:\d+:\d+)/g)];
  if (all.length) {
    const last = all[all.length - 1][1];
    return {
      coords: last,
      isMoon: /\*/.test(normalized) || /Луна|Moon/i.test(normalized),
    };
  }

  return { coords: null, isMoon: /лун/i.test(normalized) };
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

  // Fallback: ключевые слова (если формат строки изменился).
  //
  // ВАЖНО: ищем по ТЕКСТУ БЕЗ ТЕГОВ, потому что в raw-HTML фраза «Чужой флот»
  // разбита тегами: «Чужой <a ...>флот</a> игрока ...». Простой indexOf по raw-HTML
  // её НЕ найдёт — и именно поэтому бот не видел входящую атаку (входящие=0),
  // даже когда чужой флот уже летел на луну. Ищем ВСЕ вхождения, дубликаты
  // отсеивает pushIncoming (по coords + началу snippet).
  const plainHtml = html
    // СНАЧАЛА убираем onmouseover/onmouseout/title-атрибуты: в них overlib-тултипы
    // с вложенным HTML, который ломает простую очистку тегов (см. extract()).
    .replace(
      /\son(?:mouseover|mouseout|mousemove|click|focus|blur)="[^"]*"/g,
      " ",
    )
    .replace(
      /\son(?:mouseover|mouseout|mousemove|click|focus|blur)='[^']*'/g,
      " ",
    )
    .replace(/\stitle="[^"]*"/g, " ")
    .replace(/\stitle='[^']*'/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  const lowerPlain = plainHtml.toLowerCase();
  const incomingKeywords = [
    "Чужой флот игрока",
    "Чужой флот",
    "чужой флот",
    "вражеский флот",
    ...extraKeywords,
  ];
  for (const kw of incomingKeywords) {
    const kwLower = kw.toLowerCase();
    let from = 0;
    while (from < lowerPlain.length) {
      const idx = lowerPlain.indexOf(kwLower, from);
      if (idx < 0) break;
      const snippet = plainHtml.substring(idx, idx + 400).trim();
      const { coords, isMoon } = parseIncomingTarget(snippet);
      pushIncoming({
        keyword: kw,
        coords,
        isMoon,
        etaMs: null,
        snippet: snippet.substring(0, 300),
        source: "keyword",
      });
      from = idx + kw.length;
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

module.exports = {
  parseOverview,
  findHome,
  parseMissions,
  parseAttacks,
  parseIncomingTarget,
  parseMissionEtaMs,
};

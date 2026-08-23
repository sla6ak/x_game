/**
 * fleet-safety.js — безопасность флота (эвакуация).
 *
 * Логика (по PLAN.md):
 *  1. Определяем вражеские атаки на наши тела (overview: parseAttacks.incoming +
 *     координаты атакующих флотов).
 *  2. Считаем время до прибытия атаки.
 *  3. Если < warnBeforeMs (по умолчанию 5 минут) — эвакуируем флот с атакуемого тела
 *     на безопасную луну (safeMoons: луна, по которой нет атаки).
 *  4. Забираем ресурсы: ВСЕ алмазы, уран — сколько влезет, но оставляем keepUranium
 *     (по умолчанию 100_000_000_000_000), металл — весь, если есть место.
 *  5. Когда атаки закончились — возвращаем флот на home-планету.
 *
 * Состояние (data/bot-state.json):
 *   safety: { evacuated: { "g:s:p": { at, moonCp, moonCoords, ships, resources } } }
 */

const { fetchHtml } = require("./http");
const { parseAttacks } = require("./parsers/overview");
const { parseFleet, parseActiveMissions } = require("./parsers/fleet");
const { safeMoons, findBody } = require("./bodies");
const { sendMission, recallMission } = require("./mission-sender");
const { normalizeCoords, splitCoords } = require("./helpers/coords");
const { stripHtml } = require("./helpers/html");
const dataStore = require("./data-store");
const fleetState = require("./fleet-state");

/**
 * Время "HH:MM:SS" → ms до прибытия (сегодня или завтра).
 */
function parseArrivalTimeMs(hhmmss) {
  const parts = hhmmss.split(":").map(Number);
  const target = new Date();
  target.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
  let diff = target.getTime() - Date.now();
  if (diff < 0) diff += 24 * 3600 * 1000;
  return diff;
}

/**
 * Расширить входящие атаки (эвристика parseAttacks) координатами и ETA.
 * @param {string} html — raw-HTML overview
 * @param {Array} incoming — parseAttacks(...).incoming
 * @param {Array} bodies — parseBodies(...)
 * @returns {Array} [{ coords, cp, etaMs, arrivalText, snippet }]
 */
function expandIncoming(html, incoming, bodies) {
  const results = [];
  const text = stripHtml(html);
  for (const inc of incoming) {
    const snippet = stripHtml(inc.snippet || "");
    // координата атакуемого тела: ближайшая к ключевому слову
    const coordsM = snippet.match(/(\d+:\d+:\d+)/);
    const coords = coordsM ? coordsM[1] : null;
    const body = coords ? findBody(bodies, coords) : null;

    let etaMs = null;
    const relM = snippet.match(/через\s+(\d+)\s*(мин|ч)/i);
    if (relM) {
      const n = parseInt(relM[1], 10);
      etaMs = /ч/.test(relM[1]) ? n * 3600 * 1000 : n * 60 * 1000;
    } else {
      const timeM = snippet.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
      if (timeM) etaMs = parseArrivalTimeMs(timeM[1]);
    }

    results.push({
      coords,
      cp: body ? body.planet_cp : null,
      etaMs,
      arrivalText: relM ? `через ${relM[1]} ${relM[2]}` : (timeM && timeM[1]) || null,
      snippet: snippet.substring(0, 200),
    });
  }
  return results;
}

/**
 * Основной цикл сейва.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 * @param {Object} missionsData — результат collectMissions() (bodies, attacks)
 * @returns {Promise<Object>} отчёт
 */
async function runSafetyCheck(context, config, missionsData) {
  const sc = config.safety || {};
  if (!sc.enabled) return { skipped: "safety disabled" };
  const dryRun = sc.dryRun !== false;
  const warnMs = sc.warnBeforeMs != null ? sc.warnBeforeMs : 5 * 60 * 1000;
  const keepUranium = sc.keepUranium != null ? sc.keepUranium : 100_000_000_000_000;

  const state = dataStore.load();
  state.safety = state.safety || { evacuated: {} };

  const bodies = missionsData.bodies || [];
  if (!bodies.length) {
    console.log("🛡️ [safety] Нет данных о наших телах (bodies пуст) — пропускаю");
    return { skipped: "нет данных о наших телах" };
  }

  // входящие атаки (эвристика parseAttacks + координаты/ETA)
  const html = missionsData._html || (await fetchHtml(context, "/overview.php"));
  const attacks = parseAttacks(html, missionsData.missions || []);
  const incoming = expandIncoming(html, attacks.incoming, bodies);
  const report = { incoming: incoming.length, evacuated: [], returned: [] };

  // Детальный лог проверки: сколько тел, какие атаки и когда прибывают
  console.log(
    `🛡️ [safety] Проверка: тел=${bodies.length}, входящие атаки=${incoming.length}` +
      (incoming.length
        ? ` [${incoming.map((a) => `${a.coords || "?"} ${a.arrivalText || "ETA ?"}`).join(", ")}]`
        : ""),
  );

  if (!incoming.length) {
    // атак нет — возвращаем ранее эвакуированный флот домой.
    // Два случая:
    //  A) миссия «Оставить» ещё летит (флот в пути на безопасную луну) —
    //     ОТЫЗЫВАЕМ её: флот вернётся на тело-источник (домой);
    //  B) флот уже на безопасной луне — отправляем НОВУЮ миссию «Оставить»
    //     домой со ВСЕМИ ресурсами, кроме несгораемого урана.
    let returnedHome = 0;
    for (const [coords, ev] of Object.entries(state.safety.evacuated)) {
      // --- A) миссия в пути? ищем её на fleet.php тела-источника ---
      let active = null;
      if (ev.fromCp) {
        try {
          const html = await fetchHtml(context, `/fleet.php?cp=${ev.fromCp}`);
          const missions = parseActiveMissions(html);
          const fromN = normalizeCoords(ev.fromCoords || coords);
          const toN = normalizeCoords(ev.moonCoords);
          active = missions.find(
            (m) =>
              normalizeCoords(m.from) === fromN &&
              normalizeCoords(m.to) === toN,
          );
        } catch (e) {
          console.warn(`🛡️ [safety] Не удалось прочитать флот ${coords} для поиска миссии: ${e.message}`);
        }
      }

      if (active) {
        // флот в пути — отзываем миссию, он вернётся домой сам
        const res = await recallMission(context, active.fleetId, { dryRun });
        if (res.ok) {
          delete state.safety.evacuated[coords];
          returnedHome++;
          console.log(`🛡️ [safety] Отзыв миссии «Оставить» (флот ${active.fleetId}, ${coords} → ${ev.moonCoords}) — флот вернётся домой [${dryRun ? "dry-run" : "sent"}]`);
        } else {
          console.warn(`❌ [safety] Отзыв миссии ${coords} не удался: ${res.error}`);
        }
        continue;
      }

      // --- B) флот на безопасной луне — новая миссия «Оставить» домой ---
      const homeCoords = `${config.home.galaxy}:${config.home.system}:${config.home.planet}`;
      const res = await sendMission(context, {
        fromCp: ev.moonCp,
        target: {
          galaxy: config.home.galaxy,
          system: config.home.system,
          planet: config.home.planet,
          planettype: "3", // главная ЛУНА — по умолчанию основной флот там
        },
        mission: 4, // «Оставить» — флот останется дома
        ships: ev.ships || {},
        resources: { maxAll: true, keepUranium }, // все ресурсы кроме несгораемого урана
        dryRun,
      });
      if (res.ok) {
        delete state.safety.evacuated[coords];
        returnedHome++;
        console.log(`🛡️ [safety] Флот возвращается: ${ev.moonCoords} → ${homeCoords} (миссия «Оставить», ресурсы: все кроме ${keepUranium} урана) [${dryRun ? "dry-run" : "sent"}]`);
      } else {
        console.warn(`❌ [safety] Возврат с ${ev.moonCoords} не удался (стадия ${res.stage}): ${res.error}`);
      }
    }
    // все флоты возвращаемы — сбрасываем положение основного флота на главную луну
    if (!Object.keys(state.safety.evacuated).length) {
      const mf = fleetState.getMainFleet();
      if (mf.at !== "home-moon") {
        fleetState.setMainFleet(config.moonCp, `${config.home.galaxy}:${config.home.system}:${config.home.planet}`);
        console.log("📍 [safety] Основной флот возвращается на главную луну — положение сброшено");
      }
    }
    if (!returnedHome) {
      console.log("🛡️ [safety] Атак нет, эвакуированных флотов нет — ничего не делаем");
    }
    dataStore.save(state);
    return report;
  }

  // есть атаки — эвакуируем
  const safe = safeMoons(bodies, incoming.map((a) => a.coords).filter(Boolean));
  for (const atk of incoming) {
    if (!atk.coords) {
      console.warn(`🛡️ [safety] Входящая атака без координат: ${atk.snippet}`);
      continue;
    }
    const urgent = atk.etaMs == null || atk.etaMs <= warnMs;
    if (!urgent) {
      console.log(`🛡️ [safety] Атака на ${atk.coords}, прибытие ${atk.arrivalText} — пока не срочно`);
      continue;
    }
    if (state.safety.evacuated[atk.coords]) {
      console.log(`🛡️ [safety] ${atk.coords}: уже эвакуирован`);
      continue;
    }

    const moon = safe[0];
    if (!moon) {
      console.warn(`🛡️ [safety] ${atk.coords}: безопасной луны НЕТ`);
      continue;
    }

    // флот и ресурсы атакуемого тела
    const fleetHtml = await fetchHtml(context, `/fleet.php?cp=${atk.cp}`);
    const fleet = parseFleet(fleetHtml);
    // ⚠️ В raw-HTML fleet.php НЕТ полей ресурсов — ресурсы забираем через
    // кнопки «Взять все» в окне выбора ресурсов (стадия 3), заранее
    // знать их не нужно. Уран: все − keepUranium (если меньше — 0).

    // корабли: все доступные на теле (ship-инпуты)
    const ships = {};
    for (const s of fleet.ships || []) {
      const n = parseInt(s.available || "0", 10);
      if (n > 0 && s.id) ships[s.id] = n;
    }

    const { galaxy: mg, system: ms, planet: mp } = splitCoords(moon.coords);
    const res = await sendMission(context, {
      fromCp: atk.cp,
      target: { galaxy: mg, system: ms, planet: mp, planettype: "3" },
      mission: 4, // «Оставить» — флот останется на безопасной луне
      ships,
      resources: { maxAll: true, keepUranium }, // все ресурсы кроме несгораемого урана
      dryRun,
    });

    if (res.ok) {
      state.safety.evacuated[atk.coords] = {
        at: Date.now(),
        fromCp: atk.cp,
        fromCoords: atk.coords,
        moonCp: moon.moon_cp,
        moonCoords: moon.coords,
        ships,
      };
      report.evacuated.push({ coords: atk.coords, moon: moon.coords, dryRun });
      // запоминаем, где сейчас основной флот
      fleetState.setMainFleet(moon.moon_cp, moon.coords, { cp: atk.cp, coords: atk.coords });
      console.log(
        `🛡️ [safety] ЭВАКУАЦИЯ ${atk.coords} → ${moon.coords}: корабли ${JSON.stringify(ships)}, ресурсы: все кроме ${keepUranium} урана, миссия «Оставить» [${dryRun ? "dry-run" : "sent"}]`
      );
    } else {
      console.warn(`❌ [safety] Эвакуация ${atk.coords} не удалась (стадия ${res.stage}): ${res.error}`);
    }
  }

  dataStore.save(state);
  return report;
}

module.exports = {
  runSafetyCheck,
  expandIncoming,
  parseArrivalTimeMs,
};

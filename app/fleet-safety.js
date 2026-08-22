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
const { parseAttacks } = require("./parse-overview");
const { parseFleet } = require("./parse-fleet");
const { safeMoons, findBody } = require("./bodies");
const { sendMission } = require("./mission-sender");
const { stripHtml } = require("./parse-form");
const dataStore = require("./data-store");

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
  if (!bodies.length) return { skipped: "нет данных о наших телах" };

  // входящие атаки (эвристика parseAttacks + координаты/ETA)
  const html = missionsData._html || (await fetchHtml(context, "/overview.php"));
  const attacks = parseAttacks(html, missionsData.missions || []);
  const incoming = expandIncoming(html, attacks.incoming, bodies);
  const report = { incoming: incoming.length, evacuated: [], returned: [] };

  if (!incoming.length) {
    // атак нет — возвращаем ранее эвакуированный флот домой
    for (const [coords, ev] of Object.entries(state.safety.evacuated)) {
      const res = await sendMission(context, {
        fromCp: ev.moonCp,
        target: {
          galaxy: config.home.galaxy,
          system: config.home.system,
          planet: config.home.planet,
          planettype: "1",
        },
        mission: 3,
        ships: ev.ships || {},
        dryRun,
      });
      if (res.ok) {
        report.returned.push({ coords, dryRun });
        delete state.safety.evacuated[coords];
        console.log(`🛡️ [safety] Флот с ${coords} возвращён домой [${dryRun ? "dry-run" : "sent"}]`);
      } else {
        console.warn(`❌ [safety] Возврат с ${coords} не удался: ${res.error}`);
      }
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
    const res1 = fleet.thisresource1 != null ? parseInt(fleet.thisresource1, 10) : 0;
    const res2 = fleet.thisresource2 != null ? parseInt(fleet.thisresource2, 10) : 0;
    const res3 = fleet.thisresource3 != null ? parseInt(fleet.thisresource3, 10) : 0;

    // ресурсы: ВСЕ алмазы (r2), уран — всё кроме keepUranium (r3), металл — весь (r1)
    const resources = {
      r1: res1,
      r2: res2,
      r3: Math.max(0, res3 - keepUranium),
    };

    // корабли: все доступные на теле (ship-инпуты)
    const ships = {};
    for (const s of fleet.ships || []) {
      const n = parseInt(s.available || "0", 10);
      if (n > 0 && s.id) ships[s.id] = n;
    }

    const [mg, ms, mp] = moon.coords.split(":").map(Number);
    const res = await sendMission(context, {
      fromCp: atk.cp,
      target: { galaxy: mg, system: ms, planet: mp, planettype: "3" },
      mission: 3, // транспорт
      ships,
      resources,
      dryRun,
    });

    if (res.ok) {
      state.safety.evacuated[atk.coords] = {
        at: Date.now(),
        moonCp: moon.moon_cp,
        moonCoords: moon.coords,
        ships,
        resources,
      };
      report.evacuated.push({ coords: atk.coords, moon: moon.coords, dryRun });
      console.log(
        `🛡️ [safety] ЭВАКУАЦИЯ ${atk.coords} → ${moon.coords}: корабли ${JSON.stringify(ships)}, ресурсы ${JSON.stringify(resources)} [${dryRun ? "dry-run" : "sent"}]`
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

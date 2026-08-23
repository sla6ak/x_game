/**
 * fleet-safety.js — безопасность флота (эвакуация).
 *
 * Логика (по PLAN.md):
 *  1. На overview ищем «Чужой флот» только на ГЛАВНОЙ ЛУНЕ (config.home + moonCp).
 *     Атаки на другие луны/планеты — только лог, без действий.
 *  2. Если ближайшая атака < warnBeforeMs (15 мин) — эвакуация на случайную другую луну.
 *  3. Скорость 10%, миссия «Оставить», ресурсы: алмазы → уран (−keep / половина) → металл.
 *  4. Когда атаки на главную луну закончились — отзыв/возврат флота домой.
 */

const { fetchHtml } = require("./http");
const { parseAttacks, parseMissionEtaMs } = require("./parsers/overview");
const { parseFleet, parseActiveMissions } = require("./parsers/fleet");
const { pickRandomSafeMoon } = require("./bodies");
const { sendMission, recallMission } = require("./mission-sender");
const { normalizeCoords, splitCoords } = require("./helpers/coords");
const { stripHtml } = require("./helpers/html");
const { filterMainMoonIncoming, getHomeCoords } = require("./missions");
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
 * Дополнить ETA атаки (если parseAttacks не нашёл счётчик).
 */
function enrichEta(html, atk) {
  if (atk.etaMs != null) return atk.etaMs;
  const snippet = stripHtml(atk.snippet || "");
  const relM = snippet.match(/через\s+(\d+)\s*(мин|ч|минут|час)/i);
  if (relM) {
    const n = parseInt(relM[1], 10);
    return /ч/i.test(relM[2]) ? n * 3600 * 1000 : n * 60 * 1000;
  }
  const timeM = snippet.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  if (timeM) return parseArrivalTimeMs(timeM[1]);
  if (html && atk.snippet) return parseMissionEtaMs(html, atk.snippet);
  return null;
}

/**
 * Расширить входящие атаки ETA и текстом прибытия.
 */
function expandIncoming(html, incoming) {
  return incoming.map((inc) => {
    const etaMs = enrichEta(html, inc);
    const snippet = stripHtml(inc.snippet || "");
    const relM = snippet.match(/через\s+(\d+)\s*(мин|ч|минут|час)/i);
    const timeM = snippet.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
    return {
      ...inc,
      etaMs,
      arrivalText: relM
        ? `через ${relM[1]} ${relM[2]}`
        : timeM
          ? timeM[1]
          : etaMs != null
            ? `${Math.round(etaMs / 60000)} мин`
            : null,
    };
  });
}

/**
 * Основной цикл сейва.
 */
async function runSafetyCheck(context, config, missionsData) {
  const sc = config.safety || {};
  if (!sc.enabled) return { skipped: "safety disabled" };

  const dryRun = sc.dryRun !== false;
  const warnMs = sc.warnBeforeMs != null ? sc.warnBeforeMs : 15 * 60 * 1000;
  const keepUranium = sc.keepUranium != null ? sc.keepUranium : 100_000_000_000_000;
  const evacSpeed = sc.evacuationSpeedPercent != null ? sc.evacuationSpeedPercent : 10;
  const homeCoords = getHomeCoords(config);
  const homeMoonCp = config.moonCp;

  const state = dataStore.load();
  state.safety = state.safety || { evacuated: {} };

  const bodies = missionsData.bodies || [];
  if (!bodies.length) {
    console.log("🛡️ [safety] Нет данных о наших телах (bodies пуст) — пропускаю");
    return { skipped: "нет данных о наших телах" };
  }

  const html = missionsData._html || (await fetchHtml(context, "/overview.php"));
  const allIncoming = expandIncoming(
    html,
    missionsData.mainMoonIncoming ||
      filterMainMoonIncoming(
        parseAttacks(html, missionsData.missions || [], config.attackKeywords || []).incoming,
        config,
      ),
  );

  const otherAttacks = (missionsData.attacks?.incoming || []).filter((a) => {
    if (!a.coords || normalizeCoords(a.coords) !== normalizeCoords(homeCoords)) return true;
    return a.isMoon === false;
  });
  for (const a of otherAttacks) {
    console.log(`🛡️ [safety] Атака на ${a.coords || "?"} (${a.isMoon ? "луна" : "планета"}) — не главная луна, игнорируем`);
  }

  const report = { incoming: allIncoming.length, otherAttacks: otherAttacks.length, evacuated: [], returned: [] };

  console.log(
    `🛡️ [safety] Главная луна ${homeCoords}: входящие=${allIncoming.length}` +
      (allIncoming.length
        ? ` [${allIncoming.map((a) => `${a.arrivalText || "ETA ?"}`).join(", ")}]`
        : ""),
  );

  if (!allIncoming.length) {
    let returnedHome = 0;
    for (const [coords, ev] of Object.entries(state.safety.evacuated)) {
      let active = null;
      const searchCp = ev.fromCp || homeMoonCp;
      if (searchCp) {
        try {
          const fleetHtml = await fetchHtml(context, `/fleet.php?cp=${searchCp}`);
          const missions = parseActiveMissions(fleetHtml);
          const fromN = normalizeCoords(ev.fromCoords || coords);
          const toN = normalizeCoords(ev.moonCoords);
          active = missions.find(
            (m) =>
              m.type && /остав/i.test(m.type) &&
              normalizeCoords(m.from) === fromN &&
              normalizeCoords(m.to) === toN,
          );
        } catch (e) {
          console.warn(`🛡️ [safety] Не удалось прочитать флот cp=${searchCp}: ${e.message}`);
        }
      }

      if (active) {
        const res = await recallMission(context, active.fleetId, { dryRun });
        if (res.ok) {
          delete state.safety.evacuated[coords];
          returnedHome++;
          console.log(
            `🛡️ [safety] Отзыв «Оставить» (флот ${active.fleetId}, ${coords} → ${ev.moonCoords}) — возврат домой [${dryRun ? "dry-run" : "sent"}]`,
          );
        } else {
          console.warn(`❌ [safety] Отзыв миссии ${coords} не удался: ${res.error}`);
        }
        continue;
      }

      const res = await sendMission(context, {
        fromCp: ev.moonCp,
        target: {
          galaxy: config.home.galaxy,
          system: config.home.system,
          planet: config.home.planet,
          planettype: "3",
        },
        mission: 4,
        ships: ev.ships || {},
        resources: { maxAll: true, keepUranium },
        dryRun,
      });
      if (res.ok) {
        delete state.safety.evacuated[coords];
        returnedHome++;
        console.log(
          `🛡️ [safety] Флот возвращается: ${ev.moonCoords} → ${homeCoords}* [${dryRun ? "dry-run" : "sent"}]`,
        );
      } else {
        console.warn(`❌ [safety] Возврат с ${ev.moonCoords} не удался (стадия ${res.stage}): ${res.error}`);
      }
    }

    if (!Object.keys(state.safety.evacuated).length) {
      const mf = fleetState.getMainFleet();
      if (mf.at !== "home-moon") {
        fleetState.setMainFleet(homeMoonCp, homeCoords);
        console.log("📍 [safety] Основной флот на главной луне — положение сброшено");
      }
    }
    if (!returnedHome) {
      console.log("🛡️ [safety] Атак на главную луну нет, эвакуированных флотов нет");
    }
    dataStore.save(state);
    return report;
  }

  const attackedCoords = allIncoming.map((a) => a.coords).filter(Boolean);
  const urgentAttacks = allIncoming.filter((a) => a.etaMs == null || a.etaMs <= warnMs);

  for (const atk of allIncoming) {
    const urgent = atk.etaMs == null || atk.etaMs <= warnMs;
    if (!urgent) {
      console.log(`🛡️ [safety] Атака на главную луну, прибытие ${atk.arrivalText} — пока не срочно (< ${Math.round(warnMs / 60000)} мин)`);
    }
  }

  if (!urgentAttacks.length) {
    dataStore.save(state);
    return report;
  }

  if (state.safety.evacuated[homeCoords]) {
    console.log(`🛡️ [safety] ${homeCoords}*: уже эвакуирован`);
    dataStore.save(state);
    return report;
  }

  const moon = pickRandomSafeMoon(bodies, attackedCoords, { excludeHome: homeCoords });
  if (!moon) {
    console.warn(`🛡️ [safety] ${homeCoords}*: безопасной луны для эвакуации НЕТ`);
    dataStore.save(state);
    return report;
  }

  const fleetHtml = await fetchHtml(context, `/fleet.php?cp=${homeMoonCp}`);
  const fleet = parseFleet(fleetHtml);
  const ships = {};
  for (const s of fleet.ships || []) {
    const n = parseInt(s.available || "0", 10);
    if (n > 0 && s.id) ships[s.id] = n;
  }
  if (!Object.keys(ships).length) {
    console.warn(`🛡️ [safety] ${homeCoords}*: на главной луне нет кораблей для эвакуации`);
    dataStore.save(state);
    return report;
  }

  const { galaxy: mg, system: ms, planet: mp } = splitCoords(moon.coords);
  const res = await sendMission(context, {
    fromCp: homeMoonCp,
    target: { galaxy: mg, system: ms, planet: mp, planettype: "3" },
    mission: 4,
    ships,
    speedPercent: evacSpeed,
    resources: { maxAll: true, keepUranium },
    dryRun,
  });

  if (res.ok) {
    state.safety.evacuated[homeCoords] = {
      at: Date.now(),
      fromCp: homeMoonCp,
      fromCoords: homeCoords,
      moonCp: moon.moon_cp,
      moonCoords: moon.coords,
      ships,
    };
    report.evacuated.push({ coords: homeCoords, moon: moon.coords, dryRun });
    fleetState.setMainFleet(moon.moon_cp, moon.coords, { cp: homeMoonCp, coords: homeCoords });
    console.log(
      `🛡️ [safety] ЭВАКУАЦИЯ ${homeCoords}* → ${moon.coords}*, скорость ${evacSpeed}%, «Оставить» [${dryRun ? "dry-run" : "sent"}]`,
    );
  } else {
    console.warn(`❌ [safety] Эвакуация не удалась (стадия ${res.stage}): ${res.error}`);
  }

  dataStore.save(state);
  return report;
}

module.exports = {
  runSafetyCheck,
  expandIncoming,
  parseArrivalTimeMs,
  enrichEta,
};

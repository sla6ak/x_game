/**
 * fleet-safety.js — безопасность флота (эвакуация).
 *
 * Логика (по PLAN.md):
 *  1. На overview ищем «Чужой флот» только на ГЛАВНОЙ ЛУНЕ (config.home + moonCp).
 *     Атаки на другие луны/планеты — только лог, без действий.
 *  2. Если ближайшая атака < warnBeforeMs (15 мин) — эвакуация на случайную другую луну.
 *  3. Скорость 10%, миссия «Оставить», ресурсы — поведение кнопки «max»:
 *     заполнить флот ВСЕМ доступным (алмазы, уран − несгораемый keep, металл),
 *     уместив во вместимость. Если сервер говорит «Недостаточно места: N» —
 *     mission-sender повторяет с точной вместимостью (отправлено − N − 1).
 *     Флот ВСЕГДА улетает: ресурсы второстепенны, главное — спасти флот.
 *  4. Когда атаки на главную луну закончились — отзыв/возврат флота домой.
 *
 * ВАЖНО: проверки «уже эвакуирован» НЕТ — спасение флота первостепенно.
 * Бот ВСЕГДА пытается эвакуировать флот при срочной атаке. Дублирование запуска
 * предотвращается естественной проверкой «есть ли корабли на луне»:
 *  - после успешной эвакуации на луне кораблей нет → пропускаем;
 *  - если предыдущий запуск не удался — корабли на месте → повторяем.
 * Запись state.safety.evacuated пишется ТОЛЬКО при реальной отправке (не dry-run).
 * Устаревшие записи (флота нет ни в полёте, ни на целевом теле) удаляются.
 */

const { fetchHtml } = require("./http");
const { parseAttacks, parseMissionEtaMs, parseOverview } = require("./parsers/overview");
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
 * offsetMs — сдвиг игрового часового пояса (display time − machine time):
 * время прибытия в overview/fleet-страницах — в ЧАСОВОМ ПОЯСЕ ИГРЫ (напр. UTC+3),
 * а часы машины — UTC. Без offset "20:31" интерпретируется как машинное время
 * и ETA получается на 3 часа неверной. Работаем в пространстве "игровых часов":
 * nowGame = Date.now() + offsetMs.
 */
function parseArrivalTimeMs(hhmmss, offsetMs = 0) {
  const parts = hhmmss.split(":").map(Number);
  const nowGame = Date.now() + offsetMs;
  const target = new Date(nowGame);
  target.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
  let diff = target.getTime() - nowGame;
  if (diff < 0) diff += 24 * 3600 * 1000;
  return diff;
}

/**
 * Дополнить ETA атаки (если parseAttacks не нашёл счётчик).
 * @returns {{ms: number|null, source: 'counter'|'time'|null}}
 *   source="time" — ETA из абсолютного времени (зависит от offsetMs);
 *   source="counter" — из реального pp-счётчика (offset не нужен).
 */
function enrichEta(html, atk, offsetMs = 0) {
  if (atk.etaMs != null) return { ms: atk.etaMs, source: "counter" };
  const snippet = stripHtml(atk.snippet || "");
  const relM = snippet.match(/через\s+(\d+)\s*(мин|ч|минут|час)/i);
  if (relM) {
    const n = parseInt(relM[1], 10);
    return { ms: /ч/i.test(relM[2]) ? n * 3600 * 1000 : n * 60 * 1000, source: "counter" };
  }
  const timeM = snippet.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  if (timeM) return { ms: parseArrivalTimeMs(timeM[1], offsetMs), source: "time" };
  if (html && atk.snippet) {
    const ms = parseMissionEtaMs(html, atk.snippet);
    if (ms != null) return { ms, source: "counter" };
  }
  return { ms: null, source: null };
}

/**
 * Сдвиг игрового часового пояса (display time − machine time), ms.
 * Для миссий, у которых в тексте есть абсолютное время прибытия И рядом есть
 * pp-счётчик (реальные секунды до прибытия): candidate = parseAsMachine(T) − (now + S).
 */
function deriveServerOffsetMs(html, missions) {
  const now = Date.now();
  const candidates = [];
  for (const m of missions || []) {
    const text = m.text || m.snippet || "";
    const timeM = text.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
    if (!timeM) continue;
    const etaMs = parseMissionEtaMs(html, text);
    if (etaMs == null) continue;
    const parsed = parseArrivalTimeMs(timeM[1], 0); // как машинное время
    if (parsed == null) continue;
    const candidate = parsed - etaMs; // display − real = offset
    if (Math.abs(candidate) < 14 * 3600 * 1000) candidates.push(candidate);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a - b);
  return Math.round(candidates[Math.floor(candidates.length / 2)] / 60000) * 60000;
}

/**
 * Получить сдвиг игрового часового пояса (кэш в state на 6 часов).
 * @returns {{ms: number, known: boolean}} known=false — сдвиг не выведен
 * (ETA из абсолютного времени считается ненадёжной → срочная).
 */
async function getServerOffsetMs(context, state, homeCoords, html) {
  const cached = Number.isFinite(state.safety.serverOffsetMs)
    ? state.safety.serverOffsetMs
    : null;
  const fresh =
    cached != null &&
    Date.now() - (state.safety.serverOffsetAt || 0) < 6 * 3600 * 1000;
  if (fresh) return { ms: cached, known: true };
  try {
    const ovHtml = html || (await fetchHtml(context, "/overview.php"));
    const ovData = parseOverview(ovHtml);
    const items = [
      ...ovData.missions,
      ...ovData.attacks.incoming.map((a) => ({ text: a.snippet })),
    ];
    const derived = deriveServerOffsetMs(ovHtml, items);
    if (derived != null) {
      state.safety.serverOffsetMs = derived;
      state.safety.serverOffsetAt = Date.now();
      console.log(
        `🕒 [safety] Сдвиг игрового часового пояса: ${derived / 3600000} ч (кэш на 6 ч)`,
      );
      return { ms: derived, known: true };
    }
  } catch (e) {
    console.warn(`⚠️ [safety] Не удалось вывести сдвиг часового пояса: ${e.message}`);
  }
  return { ms: cached != null ? cached : 0, known: false };
}

/**
 * Расширить входящие атаки ETA и текстом прибытия.
 */
function expandIncoming(html, incoming, offsetMs = 0) {
  return incoming.map((inc) => {
    const r = enrichEta(html, inc, offsetMs);
    const etaMs = r.ms;
    const snippet = stripHtml(inc.snippet || "");
    const relM = snippet.match(/через\s+(\d+)\s*(мин|ч|минут|час)/i);
    const timeM = snippet.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
    return {
      ...inc,
      etaMs,
      etaSource: r.source,
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
 * Есть ли на теле (cp) эвакуированный флот?
 * Сравниваем доступные корабли с ev.ships: если по какому-либо типу доступно
 * >= 50% от эвакуированного количества — считаем, что флот на месте.
 * При ошибке чтения возвращаем true (безопаснее оставить запись и повторить).
 */
async function fleetAtDestination(context, ev) {
  try {
    const html = await fetchHtml(context, `/fleet.php?cp=${ev.moonCp}`);
    const fleet = parseFleet(html);
    const available = {};
    for (const s of fleet.ships || []) {
      const n = parseInt(s.available || "0", 10);
      if (n > 0 && s.id) available[s.id] = n;
    }
    for (const [id, count] of Object.entries(ev.ships || {})) {
      const need = Math.ceil((parseInt(count, 10) || 0) / 2);
      if (need > 0 && (available[id] || 0) >= need) return true;
    }
    return false;
  } catch (e) {
    console.warn(`🛡️ [safety] Не удалось прочитать флот cp=${ev.moonCp}: ${e.message}`);
    return true;
  }
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
  // Сдвиг игрового часового пояса (display time − machine time): времена прибытия
  // в overview — в часовом поясе игры. На этой машине локальный TZ = EEST (UTC+3)
  // = игровой, поэтому сдвиг выводится как 0; механизм нужен для переносимости.
  const offset = await getServerOffsetMs(context, state, homeCoords, html);
  const offsetMs = offset.ms;
  const allIncoming = expandIncoming(
    html,
    missionsData.mainMoonIncoming ||
      filterMainMoonIncoming(
        parseAttacks(html, missionsData.missions || [], config.attackKeywords || []).incoming,
        config,
      ),
    offsetMs,
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
    const base3 = (c) => normalizeCoords(c).split(":").slice(0, 3).join(":");
    for (const [coords, ev] of Object.entries(state.safety.evacuated)) {
      const fromN = normalizeCoords(ev.fromCoords || coords);
      const toN = normalizeCoords(ev.moonCoords);
      // 1) Флот в пути? — по overview (текст миссии с координатами и типом).
      // Надёжный источник: запись «эвакуирован» НЕ удаляем, пока флот летит
      // (раньше запись удалялась, пока флот ещё был в пути — бот терял его).
      const inFlight = (missionsData.missions || []).find(
        (m) =>
          /остав/i.test(m.type || "") &&
          (m.coords || []).some((c) => base3(c) === base3(fromN)) &&
          (m.coords || []).some((c) => base3(c) === base3(toN)),
      );
      let active = null;
      let fleetReadOk = true;
      const searchCp = ev.fromCp || homeMoonCp;
      if (searchCp) {
        try {
          const fleetHtml = await fetchHtml(context, `/fleet.php?cp=${searchCp}`);
          const missions = parseActiveMissions(fleetHtml);
          active = missions.find(
            (m) =>
              m.type && /остав/i.test(m.type) &&
              normalizeCoords(m.from) === fromN &&
              normalizeCoords(m.to) === toN,
          );
        } catch (e) {
          fleetReadOk = false;
          console.warn(`🛡️ [safety] Не удалось прочитать флот cp=${searchCp}: ${e.message}`);
        }
      }

      if (active) {
        const res = await recallMission(context, active.fleetId, { dryRun });
        if (res.ok && !res.dryRun) {
          delete state.safety.evacuated[coords];
          returnedHome++;
          console.log(
            `🛡️ [safety] Отзыв «Оставить» (флот ${active.fleetId}, ${coords} → ${ev.moonCoords}) — возврат домой [sent]`,
          );
        } else if (res.ok) {
          console.log(`🛡️ [safety] dry-run: отзыв миссии ${active.fleetId} (${coords} → ${ev.moonCoords}) — состояние не меняем`);
        } else {
          console.warn(`❌ [safety] Отзыв миссии ${coords} не удался: ${res.error}`);
        }
        continue;
      }

      if (inFlight) {
        // Флот в пути (по overview), но на fleet-странице его не видно —
        // ждём прибытия. Запись НЕ удаляем: флот ещё не на месте.
        console.log(`🛡️ [safety] ${coords}*: флот в пути (по overview) — ждём прибытия`);
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
      if (res.ok && !res.dryRun) {
        delete state.safety.evacuated[coords];
        returnedHome++;
        console.log(`🛡️ [safety] Флот возвращается: ${ev.moonCoords} → ${homeCoords}* [sent]`);
      } else if (res.ok) {
        console.log(`🛡️ [safety] dry-run: возврат ${ev.moonCoords} → ${homeCoords}* — состояние не меняем`);
      } else if (fleetReadOk && ev.moonCp && !(await fleetAtDestination(context, ev))) {
        // Возврат не удался И на целевом теле эвакуированного флота НЕТ —
        // запись устарела (например, осталась от dry-run, который флот не отправил).
        // Удаляем: иначе она будет засорять следующие циклы.
        console.warn(
          `🛡️ [safety] ${coords}*: запись «эвакуирован» устарела (на ${ev.moonCoords} флота нет) — удаляю`,
        );
        delete state.safety.evacuated[coords];
      } else {
        console.warn(
          `❌ [safety] Возврат с ${ev.moonCoords} не удался (стадия ${res.stage}): ${res.error}` +
            (ev.moonCp ? " — флот на месте, повторим позже" : ""),
        );
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
  // ETA из абсолютного времени БЕЗ выведенного сдвига часового пояса ненадёжна
  // — считаем срочной (безопасное направление).
  const isUrgent = (a) =>
    a.etaMs == null || a.etaMs <= warnMs || (a.etaSource === "time" && !offset.known);
  const urgentAttacks = allIncoming.filter(isUrgent);

  for (const atk of allIncoming) {
    const urgent = isUrgent(atk);
    if (!urgent) {
      console.log(`🛡️ [safety] Атака на главную луну, прибытие ${atk.arrivalText} — пока не срочно (< ${Math.round(warnMs / 60000)} мин)`);
    } else if (atk.etaSource === "time" && !offset.known) {
      console.log(`🛡️ [safety] Атака на главную луну, прибытие ${atk.arrivalText} — сдвиг часового пояса не выведен, считаем срочной`);
    }
  }

  if (!urgentAttacks.length) {
    dataStore.save(state);
    return report;
  }

  // ВАЖНО: проверки «уже эвакуирован» НЕТ — спасение флота первостепенно.
  // Дублирование запуска предотвращается естественной проверкой «есть ли корабли
  // на луне»: после успешной эвакуации на луне кораблей нет → пропускаем;
  // если предыдущий запуск не удался — корабли на месте → повторяем.
  if (state.safety.evacuated[homeCoords]) {
    console.log(`🛡️ [safety] ${homeCoords}*: есть старая запись об эвакуации — проверяем флот на луне`);
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
    console.log(
      `🛡️ [safety] ${homeCoords}*: на главной луне нет кораблей — флот, вероятно, уже в полёте/на другой луне`,
    );
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
    // Состояние «эвакуирован» и положение основного флота меняем ТОЛЬКО при
    // реальной отправке. Dry-run флот НЕ отправляет — именно dry-run-запись
    // из прошлого цикла блокировала реальную эвакуацию («уже эвакуирован»).
    if (!res.dryRun) {
      state.safety.evacuated[homeCoords] = {
        at: Date.now(),
        fromCp: homeMoonCp,
        fromCoords: homeCoords,
        moonCp: moon.moon_cp,
        moonCoords: moon.coords,
        ships,
      };
      fleetState.setMainFleet(moon.moon_cp, moon.coords, { cp: homeMoonCp, coords: homeCoords });
    }
    report.evacuated.push({ coords: homeCoords, moon: moon.coords, dryRun: !!res.dryRun });
    console.log(
      `🛡️ [safety] ЭВАКУАЦИЯ ${homeCoords}* → ${moon.coords}*, скорость ${evacSpeed}%, «Оставить» [${res.dryRun ? "dry-run" : "sent"}]`,
    );
  } else {
    console.warn(
      `❌ [safety] Эвакуация не удалась (стадия ${res.stage}): ${res.error} — повторим на следующем тике`,
    );
  }

  dataStore.save(state);
  return report;
}

module.exports = {
  runSafetyCheck,
  expandIncoming,
  parseArrivalTimeMs,
  enrichEta,
  deriveServerOffsetMs,
  getServerOffsetMs,
  fleetAtDestination,
};

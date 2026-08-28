/**
 * farm.js — АВТОФАРМ ресурсов (полный цикл).
 *
 * Цикл (состояние в dataStore.state.farm, переживает рестарты):
 *   1. Условие: в резерве (farmReserveSlots) есть свободные миссии.
 *   2. Парсим систему (домашняя + systemRange вперёд), собираем неактивных
 *      планет в очередь (state.farm.queue), логим систему и список.
 *   3. current_goal = первая цель из очереди → шпионим (spyTargets,
 *      только неактивные планеты), координаты → state.farm.current_goal.
 *   4. Ждём отчёт (reportGraceMs ~2 мин, не блокируя луп: pendingReport).
 *      Сообщения → шпионский доклад по координатам current_goal →
 *      логим, считаем линкоры = ceil((Металл+Алмаз+Уран) / 1500).
 *   5. Атака: sendMission(mission=1, ships={207: N}, fromCp=fromMoonCp) —
 *      СТРОГО с главной луны, только линкоры. Лог: флот, координаты, кол-во.
 *   6. Следующая цель; если система закончилась — следующая система.
 */

const { getSystem, switchSystem, findInactiveTargets } = require("./galaxy");
const { spyTargets } = require("./spy");
const { sendMission } = require("./mission-sender");
const { fetchHtml } = require("./http");
const { parseMessages } = require("./parsers/messages");
const dataStore = require("./data-store");
const { delay } = require("./helpers/async");
const { splitCoords } = require("./helpers/coords");

// Вместимость линкора для расчёта (формула пользователя: (M+A+U)/1500)
const LINER_CAPACITY = 1500;

/**
 * Цикл автофарма (вызывается из bot-loop каждый тик).
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 * @param {Object} missionsData — результат collectMissions()
 * @returns {Promise<Object>} отчёт цикла
 */
async function runFarmCycle(context, config, missionsData) {
  const fc = config.farm || {};
  if (!fc.enabled) return { skipped: "farm disabled" };

  // --- 1. Свободные миссии в резерве ---
  const { loadBotControls } = require("./helpers/config");
  const reserve = loadBotControls().farmReserveSlots;
  const activeSlots = missionsData?.analysis?.activeSlots;
  console.log(
    `🌾 [farm] ВХОД: analysis=${JSON.stringify(missionsData?.analysis || null).slice(0, 200)}`,
  );
  if (activeSlots == null) {
    console.log("🌾 [farm] Нет данных о миссиях (analysis.activeSlots=undefined) — пропуск");
    return { skipped: "no missions data" };
  }
  if (activeSlots >= reserve) {
    console.log(
      `🌾 [farm] Не хватает миссий: занято ${activeSlots}/${reserve} — пропуск`,
    );
    return { skipped: "not enough free slots", activeSlots, reserve };
  }
  console.log(
    `🌾 [farm] Свободных миссий: ${reserve - activeSlots} (занято ${activeSlots}/${reserve})`,
  );

  const state = dataStore.load();
  // МЕРЖИМ с существующим state.farm (могут быть старые поля: farmed, sent, cursor)
  state.farm = Object.assign(
    {
      queue: [], // [{coords, pos, player, g, s, p, spiedAt}]
      current_goal: null, // {coords, player, spiedAt}
      pendingReport: null, // {coords, player, spiedAt}
      scanSystem: null, // текущая сканируемая система
      attacked: {}, // coords -> ts (кулдаун farmCooldownMs)
      failed: {}, // coords -> {ts, reason}
    },
    state.farm
  );
  const F = state.farm;
  const home = config.home;
  const now = Date.now();
  const cooldownMs = fc.farmCooldownMs || 3600000;

  console.log(
    `🌾 [farm] Состояние: queue=${F.queue.length}, pendingReport=${JSON.stringify(F.pendingReport)}, scanSystem=${F.scanSystem}, attacked=${Object.keys(F.attacked).length}, failed=${Object.keys(F.failed).length}`,
  );

  try {
    // --- 4a. Если ждём отчёт: время пришло? ---
    if (F.pendingReport) {
      const pr = F.pendingReport;
      const waitMs = fc.reportGraceMs || 120000;
      const elapsed = now - (pr.spiedAt || 0);
      console.log(
        `🌾 [farm] Ждём отчёт по ${pr.coords}: прошло ${Math.round(elapsed / 1000)}с из ${Math.round(waitMs / 1000)}с`,
      );
      if (elapsed >= waitMs) {
        console.log(`🌾 [farm] Время вышло — ищем отчёт по ${pr.coords}`);
        const rep = await findSpyReport(context, pr.coords);
        if (rep) {
          const total = rep.metal + rep.diamond + rep.uran;
          const liners = Math.ceil(total / LINER_CAPACITY);
          console.log(
            `🌾 [farm] Доклад «${rep.player}» [${pr.coords}] (msg#${rep.msgId}, src=${rep.source}): Металл ${rep.metal}, Алмаз ${rep.diamond}, Уран ${rep.uran} → Итого ${total} → линкоров: ${liners}`,
          );
          F.pendingReport = null;
          if (total === 0) {
            console.log(`🌾 [farm] ${pr.coords} пуста — пропускаю`);
            return finishTarget(context, config, F, pr, state, { empty: true });
          }
          if (fc.minDiamond && rep.diamond < fc.minDiamond) {
            console.log(`🌾 [farm] ${pr.coords}: алмазов ${rep.diamond} < минимума ${fc.minDiamond} — пропускаю, ищу дальше`);
            return finishTarget(context, config, F, pr, state, { ok: false, lowDiamond: true, error: `diamonds ${rep.diamond} < minDiamond ${fc.minDiamond}` });
          }
          if (fc.maxLiners && liners > fc.maxLiners) {
            console.log(`🌾 [farm] ${pr.coords}: нужно ${liners} > лимита ${fc.maxLiners} — пропускаю цель`);
            return finishTarget(context, config, F, pr, state, { ok: false, error: `liners ${liners} > maxLiners ${fc.maxLiners}` });
          }
          // --- 5. Атака линкорами с главной луны ---
          console.log(
            `🌾 [farm] Атака: target=${pr.coords}, mission=1, ships={${fc.typeFL || 207}: ${liners}}, fromCp=${fc.fromMoonCp}, dryRun=${fc.dryRun !== false}`,
          );
          const atk = await sendMission(context, {
            fromCp: fc.fromMoonCp, // главная луна из config
            target: { ...splitCoords(pr.coords), planettype: "1" },
            mission: 1, // Атака
            ships: { [fc.typeFL || 207]: liners },
            dryRun: fc.dryRun !== false,
          });
          console.log(
            `🌾 [farm] Результат sendMission: ok=${atk.ok}, stage=${atk.stage || "?"}, confirmed=${atk.confirmed}, error=${atk.error || "-"}`,
          );
          if (atk.ok) {
            console.log(
              `🌾 [farm] ✅ ФЛОТ ОТПРАВЛЕН: [${pr.coords}] (${pr.player}), линкоров: ${liners}, источник: главная луна cp=${fc.fromMoonCp}`,
            );
            return finishTarget(context, config, F, pr, state, { ok: true, liners, atk });
          }
          console.warn(`🌾 [farm] Атака не удалась (стадия ${atk.stage}): ${atk.error}`);
          return finishTarget(context, config, F, pr, state, { ok: false, error: atk.error, stage: atk.stage });
        }
        // Отчёта нет: ждём ещё, если не превышен maxSystemWaitMs
        if (now - pr.spiedAt < (fc.maxSystemWaitMs || 1200000)) {
          console.log(`🌾 [farm] Отчёта по ${pr.coords} пока нет — ждём до следующего тика`);
          return { waiting: pr.coords };
        }
        console.warn(`🌾 [farm] Отчёт по ${pr.coords} не пришёл за ${fc.maxSystemWaitMs}мс — пропускаю`);
        F.pendingReport = null;
        return finishTarget(context, config, F, pr, state, { noReport: true });
      }
      return { waiting: pr.coords };
    }

    // --- 2. Очередь пуста → парсим систему, логим список неактивных ---
    if (!F.queue.length) {
      const sys = await scanNextSystem(context, config, F, home);
      if (!sys) return { skipped: "no system to scan" };
      console.log(
        `🌾 [farm] Система ${sys.galaxy}:${sys.system} получена: планет в таблице=${(sys.planets || []).length}`,
      );
      const ourCoords = (missionsData?.bodies || []).map((b) => b.coords);
      // координаты, куда уже летят исходящие миссии (m.coords — массив из текста)
      const busyCoords = [];
      for (const m of missionsData?.missions || []) {
        if (m.is_returning) continue;
        for (const c of m.coords || []) busyCoords.push(c);
      }
      console.log(
        `🌾 [farm] Фильтры: ourCoords=${ourCoords.join(",") || "-"}, busyCoords=${busyCoords.length}`,
      );
      const targets = findInactiveTargets(sys, {
        ourCoords,
        busyCoords,
        includeVacation: !!fc.includeVacation,
      });
      console.log(`🌾 [farm] Неактивных после базовых фильтров: ${targets.length}` + (targets.length ? " — " + targets.map((t) => `${t.player}[${t.pos}](${t.status})`).join(", ") : ""));
      // фильтруем: не в кулдауне атак, не шпионены недавно
      const fresh = targets.filter((t) => {
        const atkTs = F.attacked[t.coords];
        return !atkTs || now - atkTs > cooldownMs;
      });
      const skippedCooldown = targets.length - fresh.length;
      if (skippedCooldown) console.log(`🌾 [farm] Пропущено по кулдауну атаки (${Math.round(cooldownMs / 3600000)}ч): ${skippedCooldown}`);
      F.queue = fresh.map((t) => ({ ...t, spiedAt: 0 }));
      console.log(
        `🌾 [farm] Система ${sys.galaxy}:${sys.system}: в очередь ${fresh.length}` +
          (fresh.length ? " — " + fresh.map((t) => `${t.player}[${t.pos}]`).join(", ") : " — ПУСТО"),
      );
      if (!fresh.length) {
        F.scanSystem = null; // система исчерпана → следующий тик сканируем следующую
        return { skipped: "no inactive targets", system: `${sys.galaxy}:${sys.system}` };
      }
    }

    // --- 3. current_goal = первая цель → шпионим ---
    const t = F.queue[0];
    F.current_goal = { coords: t.coords, player: t.player, spiedAt: Date.now() };
    console.log(`🌾 [farm] current_goal = [${t.coords}] ${t.player} — отправляем шпионов (зондов: ${fc.probeCount || 5000})`);
    const spyRes = await spyTargets(context, config, [t], {
      probes: fc.probeCount || 5000,
    });
    console.log(
      `🌾 [farm] spyTargets: sent=${JSON.stringify(spyRes.sent)}, skipped=${JSON.stringify(spyRes.skipped)}, failed=${JSON.stringify(spyRes.failed)}`,
    );
    if (spyRes.sent.length) {
      t.spiedAt = Date.now();
      F.pendingReport = { coords: t.coords, player: t.player, spiedAt: t.spiedAt };
      dataStore.save(state);
      console.log(`🌾 [farm] Шпионы на [${t.coords}] отправлены — ждём отчёт ${fc.reportGraceMs || 120000}мс`);
      return { spied: t.coords, waitingReport: true };
    }
    // Шпионаж не удался (кулдаун/ошибка) — снимаем с очереди
    console.warn(`🌾 [farm] Шпионаж на [${t.coords}] не отправился: skipped=${JSON.stringify(spyRes.skipped)} failed=${JSON.stringify(spyRes.failed)}`);
    return finishTarget(context, config, F, t, state, { spyFailed: true });
  } catch (e) {
    // Подробный лог ошибки + состояние, чтобы видеть где сломалось
    console.error(
      `🌾 [farm] ❌ ОШИБКА: ${e.message}\n${e.stack}\nСостояние: ${JSON.stringify({ queue: F.queue, current_goal: F.current_goal, pendingReport: F.pendingReport, scanSystem: F.scanSystem })}`,
    );
    return { error: e.message };
  }
}

/**
 * Завершить цель: убрать из очереди, запомнить атаку/сбой, сохранить.
 */
function finishTarget(context, config, F, target, state, info) {
  const before = F.queue.length;
  F.queue = (F.queue || []).filter((q) => q.coords !== target.coords);
  console.log(
    `🌾 [farm] finishTarget [${target.coords}]: queue ${before}→${F.queue.length}, info=${JSON.stringify(info)}`,
  );
  if (info.ok) {
    F.attacked[target.coords] = Date.now();
    console.log(`🌾 [farm] [${target.coords}] помечено как атакованное (кулдаун ${Math.round(((config.farm || {}).farmCooldownMs || 3600000) / 3600000)}ч)`);
  } else if (info.noReport || info.spyFailed || info.empty) {
    F.failed[target.coords] = { ts: Date.now(), reason: info.noReport ? "no_report" : info.empty ? "empty" : "spy_failed" };
  } else if (info.lowDiamond) {
    F.failed[target.coords] = { ts: Date.now(), reason: `low_diamond < ${config.farm && config.farm.minDiamond}` };
  }
  F.current_goal = null;
  dataStore.save(state);
  return { target: target.coords, ...info };
}

/**
 * Скан следующей системы: домашняя → +1..systemRange (циклически).
 * @returns {Object|null} результат getSystem/switchSystem
 */
async function scanNextSystem(context, config, F, home) {
  const range = (config.farm && config.farm.systemRange) || 30;
  let sys = null;
  if (F.scanSystem == null) {
    F.scanSystem = home.system;
    console.log(`🌾 [farm] Скан: начинаем с домашней системы ${home.galaxy}:${home.system}`);
    sys = await getSystem(context, home.galaxy, home.system);
  } else {
    const max = home.system + range - 1;
    const next = F.scanSystem + 1 > max ? home.system : F.scanSystem + 1;
    console.log(`🌾 [farm] Переход к системе ${home.galaxy}:${next} (range=${range}, было ${F.scanSystem})`);
    F.scanSystem = next;
    sys = next === home.system
      ? await getSystem(context, home.galaxy, next)
      : await switchSystem(context, home.galaxy, next);
  }
  if (!sys) {
    console.warn(`🌾 [farm] Скан системы ${F.scanSystem} не вернул данных`);
    return null;
  }
  return sys;
}

/**
 * Найти шпионский отчёт по координатам и распарсить ресурсы.
 * Тело сообщения лежит INLINE в списке (секция showmes<ID> до следующей строки).
 * Отдельные URL — только fallback. Секция ОБЯЗАТЕЛЬНО содержит координаты и "шпион".
 * @returns {Promise<Object|null>} {metal, diamond, uran, player, msgId, source} | null
 */
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/** Секция HTML сообщения: от showmes<ID>" до следующей строки <tr id="number_ */
function extractBodySection(html, id) {
  const marker = `showmes${id}"`;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const nextRow = html.indexOf('<tr id="number_', start);
  return html.slice(start, nextRow === -1 ? undefined : nextRow);
}

/**
 * Число с группировкой по 3 цифры: "87 600 981 935 496" → 87600981935496.
 * Хвостовые группы не из 3 цифр отбрасываем (защита от перелива в соседний текст/дату).
 */
function pickNumber(text, label) {
  const i = text.indexOf(label);
  if (i < 0) return 0;
  const rest = text.slice(i + label.length, i + label.length + 80);
  const m = rest.match(/[\d\u00a0]+(?:\s+[\d\u00a0]+)*/);
  if (!m) return 0;
  const groups = m[0].trim().split(/\s+/);
  let num = groups[0];
  for (let k = 1; k < groups.length; k++) {
    if (/^\d{3}$/.test(groups[k])) num += groups[k];
    else break;
  }
  return parseInt(num, 10) || 0;
}

async function findSpyReport(context, coords) {
  let html = null;
  try {
    html = await fetchHtml(context, "/messages.php?mode=show&messcat=100");
  } catch (e) {
    console.warn(`🌾 [farm] Не удалось открыть список сообщений: ${e.message}`);
    return null;
  }
  const list = parseMessages(html);
  const candidates = list.filter(
    (m) => m.coords === coords && (/шпион/i.test(m.action) || /шпион/i.test(m.theme))
  );
  console.log(
    `🌾 [farm] Сообщений: всего=${list.length}, шпионских по ${coords}=${candidates.length}` +
      (candidates.length ? " — " + candidates.slice(0, 5).map((m) => `#${m.id}(${m.date}|${m.action}|${m.theme})`).join(" ; ") : ""),
  );
  for (const msg of candidates) {
    // 1) тело inline в списке
    let section = extractBodySection(html, msg.id);
    let source = "inline";
    if (!section || !stripTags(section).includes(coords)) {
      // 2) fallback: отдельные URL (они могут отдавать список — тоже скоупим по id)
      for (const url of [
        `/messages.php?mode=show&messcat=100&rand=${msg.id}`,
        `/messages.php?mode=show&id=${msg.id}`,
      ]) {
        try {
          const h2 = await fetchHtml(context, url);
          const s2 = extractBodySection(h2, msg.id);
          if (s2 && stripTags(s2).includes(coords)) {
            section = s2;
            source = url;
            break;
          }
        } catch (e) {
          console.warn(`🌾 [farm] URL ${url} не открылся: ${e.message}`);
        }
      }
    }
    if (!section) {
      console.log(`🌾 [farm] #${msg.id}: секция тела не найдена — следующее сообщение`);
      continue;
    }
    const text = stripTags(section);
    if (!text.includes(coords) || !/шпион/i.test(text)) {
      console.log(`🌾 [farm] #${msg.id} (${source}): секция не похожа на шпионский отчёт по ${coords} — пропускаю. Кусок: ${text.slice(0, 200)}`);
      continue;
    }
    const res = parseReportResources(text, coords);
    if (res) {
      console.log(`🌾 [farm] #${msg.id} (${source}): М=${res.metal}, А=${res.diamond}, У=${res.uran}, игрок=${res.player}`);
      return { ...res, msgId: msg.id, source };
    }
    console.log(`🌾 [farm] #${msg.id} (${source}): ресурсы не распарсились. Кусок: ${text.slice(0, 300)}`);
  }
  console.warn(`🌾 [farm] Шпионский отчёт по ${coords} не найден/не распарсен`);
  return null;
}

/**
 * Парсинг ресурсов из ТЕЛА шпионского доклада (уже скоупленного по сообщению).
 * Формат: "Шпионский доклад «имя» с планеты [g:s:p] Металл X Алмаз Y Уран Z"
 */
function parseReportResources(text, coords) {
  const metal = pickNumber(text, "Металл");
  const diamond = pickNumber(text, "Алмаз");
  const uran = pickNumber(text, "Уран");
  if (!metal && !diamond && !uran) {
    const idx = text.search(/шпион/i);
    console.log(`🌾 [farm] parseReportResources: числа не найдены. Кусок: ${idx >= 0 ? text.slice(idx, idx + 300) : text.slice(0, 300)}`);
    return null;
  }
  const player = (text.match(/Шпионский доклад\s*[«"]([^»"]+)[»"]/) || [])[1] || "?";
  return { metal, diamond, uran, player };
}

module.exports = {
  runFarmCycle,
  findSpyReport,
  parseReportResources,
  stripTags,
  extractBodySection,
  pickNumber,
  LINER_CAPACITY,
};

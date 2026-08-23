/**
 * farm.js — АВТОФАРМ ресурсов (цепочка последовательных действий).
 *
 * Цепочка (по PLAN.md):
 *  1. Проверки-условий:
 *     - нет вражеских атак на наши тела;
 *     - на луне 1:363:6* (moonCp) больше minFreeSlots свободных слотов флота;
 *     - на луне больше minBattleships свободных линкоров;
 *     - если по всем неактивным текущей системы уже есть атаки — шпионим следующую систему
 *       (смена системы: galaxy.php?mode=1&galaxyGO=1&systemGO=N);
 *     - сверяем текущие полёты с новыми целями, дубли пропускаем.
 *  2. Шпионаж: зонды на всех неактивных системы (spy.js).
 *  3. Сообщения: шпионские доклады по тем же координатам (система совпадает).
 *  4. «Ишкофарм» — отправка флота по докладу (форма select на messages.php, кнопка gRPhPPPPh).
 *  5. Проверка: миссия появилась в списке миссий (overview).
 *
 * Состояние (data/bot-state.json):
 *   farm: {
 *     farmed: { "g:s:p": timestamp },   // по этим координатам уже отправлен фарм
 *     lastSystem: 363,                  // последняя система, по которой шпионили
 *     systems: [363, 364, ...]          // из config
 *   }
 */

const { fetchHtml, postForm } = require("./http");
const { parseMessages, filterSpyReports } = require("./parse-messages");
const { getSystem, switchSystem, findInactiveTargets } = require("./galaxy");
const { spyTargets } = require("./spy");
const { parseFleet } = require("./parse-fleet");
const { classifyMission } = require("./missions");
const dataStore = require("./data-store");
const fleetState = require("./fleet-state");

/**
 * Проверки-условия для автофарма.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 * @param {Object} missionsData — результат collectMissions()
 * @returns {Promise<Object>} { ok, reasons: string[], freeSlots, battleships }
 */
async function checkFarmConditions(context, config, missionsData) {
  const reasons = [];
  const fc = config.farm || {};
  const minFree = fc.minFreeSlots != null ? fc.minFreeSlots : 3;
  const minBattleships = fc.minBattleships != null ? fc.minBattleships : 10_000_000;

  // 1) Нет вражеских атак на наши тела
  const incoming = (missionsData.attacks && missionsData.attacks.incoming) || [];
  if (incoming.length > 0) {
    reasons.push(`Входящие атаки: ${incoming.length} — фарм отложен (приоритет сейв)`);
  }

  // 2) Свободные ОБЩИЕ слоты флота на луне (fleet.php?cp=moonCp)
  //    Считаются из текстового счётчика «Флоты X из Y» (все миссии),
  //    НЕ из экспедиционных hidden-полей (только миссии-экспедиции).
  let freeSlots = null;
  let freeSlotsSource = null;
  let fleetMax = null;
  let battleships = null;
  try {
    const html = await fetchHtml(context, `/fleet.php?cp=${fc.fromMoonCp || config.moonCp}`);
    const fleet = parseFleet(html);
    freeSlots = fleet.freeSlots;
    freeSlotsSource = fleet.freeSlotsSource;
    fleetMax = fleet.fleetMax;
    // линкоры: из ship-инпутов (если есть в raw) или из дока
    const lin = (fleet.ships || []).find((s) => s.name === fc.shipName || s.name === "Линкор");
    if (lin && lin.available != null) {
      battleships = parseInt(lin.available, 10);
    } else {
      const dockLin = (fleet.dockShips || []).find((s) => s.name === "Линкор");
      if (dockLin) battleships = dockLin.available;
    }
  } catch (e) {
    reasons.push(`Не удалось прочитать флот луны: ${e.message}`);
  }

  // Детальный лог каждой проверки (✅/❌) — видно, где именно не сработало
  const checks = [];
  checks.push(`атаки=${incoming.length} ${incoming.length === 0 ? "✅" : "❌"}`);
  if (freeSlots != null) {
    const ok = freeSlots > minFree;
    checks.push(`слоты=${freeSlots} из ${fleetMax ?? "?"} (нужно >${minFree}) ${ok ? "✅" : "❌"}`);
    if (!ok) reasons.push(`Свободных слотов ${freeSlots} (нужно > ${minFree})`);
  } else {
    checks.push(`слоты=не распарсилось ${freeSlotsSource ? `(${freeSlotsSource})` : ""} ❌`);
    reasons.push("Не удалось определить свободные слоты флота");
  }
  if (battleships != null) {
    const ok = battleships >= minBattleships;
    checks.push(`линкоры=${battleships} (нужно >=${minBattleships}) ${ok ? "✅" : "❌"}`);
    if (!ok) reasons.push(`Линкоров ${battleships} (нужно >= ${minBattleships})`);
  } else {
    checks.push(`линкоры=не найдены ❌`);
    reasons.push(`Линкоры не найдены на луне (ship-инпуты и док пуст)`);
  }
  console.log(`🌾 [farm] Проверки: ${checks.join(", ")}`);

  return {
    ok: reasons.length === 0,
    reasons,
    freeSlots,
    freeSlotsSource,
    fleetMax,
    battleships,
    minFree,
    minBattleships,
    incomingCount: incoming.length,
  };
}

/**
 * Координаты, по которым уже летят наши атаки/фарм (из миссий).
 * @param {Array} missions
 * @returns {Set<string>}
 */
function busyTargetCoords(missions) {
  const set = new Set();
  for (const m of missions) {
    const type = classifyMission(m);
    if (type === "attack" || type === "farm") {
      // цель = последняя координата (куда летит)
      if (m.coords && m.coords.length) set.add(m.coords[m.coords.length - 1]);
    }
  }
  return set;
}

/**
 * Страница сообщений (категория 100) на 100 сообщений.
 * GET отдаёт компактный список (10 сообщений, без панели «Ишкофарм»);
 * POST формы select с pageMess=0 — полная страница со 100 докладами и панелью.
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<string>} raw-HTML
 */
async function fetchMessagesPage(context) {
  const { BASE } = require("./http");
  const url = "/messages.php?mode=show&messcat=100";
  const { status, html } = await postForm(
    context,
    url + "&lim=1",
    { messages: "1", category: "100", sortDesc: "DESC", pageMess: "0" },
    { referer: BASE + url }
  );
  if (status !== 200) throw new Error(`HTTP ${status} для ${url}`);
  return html;
}

/**
 * Отправить «Ишкофарм» по шпионскому докладу.
 *
 * ВАЖНО (проверено вживую 23.08):
 *  - панель «Ишкофарм» сервер рендерит ТОЛЬКО на странице со 100 сообщениями
 *    (POST формы select с pageMess=0). GET и pageMess=1 (10 сообщений) — компактный
 *    список БЕЗ панели: POST с полями панели просто игнорируется (200, но флот не летит).
 *  - имя submit-кнопки панели — СЛУЧАЙНЫЙ токен на каждый рендер (gRPhPPPPh, suQhsQQQ...).
 *    Захардкоженный токен из старого сэмпла сервер не узнаёт → парсим со страницы:
 *    единственная submit-кнопка со значением "[ Отправить ]" (остальные — "[ ok ]").
 *  - minSPY = окно свежести докладов в МИНУТАХ (0 = все доклады).
 *
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 * @param {string} reportId — id сообщения (доклада)
 * @returns {Promise<Object>} { ok, error? }
 */
async function farmFromReport(context, config, reportId) {
  const fc = config.farm || {};
  const { BASE } = require("./http");
  const MSG_URL = "/messages.php?mode=show&messcat=100";
  const referer = BASE + MSG_URL;

  // 1) Страница со 100 докладами (только там есть панель «Ишкофарм»)
  let listHtml;
  try {
    listHtml = await fetchMessagesPage(context);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // 2) Все showmes-поля со страницы (обязательны в форме)
  const form = { messages: "1", category: "100", sortDesc: "DESC", pageMess: "0" };
  const showmesRe = /name="showmes(\d+)" type="hidden" value="\1"/g;
  let m;
  while ((m = showmesRe.exec(listHtml)) !== null) {
    form[`showmes${m[1]}`] = m[1];
  }
  if (form[`showmes${reportId}`] == null) {
    return { ok: false, error: `Доклад ${reportId} не найден на странице сообщений` };
  }

  // 3) Выбранный доклад + настройки панели Ишкофарм
  form[`delmes${reportId}`] = "on";
  if (fc.resFL !== false) form.resFL = "on";
  form.maxFL = String(fc.maxFL != null ? fc.maxFL : 0);
  form.moreFL = String(fc.moreFL != null ? fc.moreFL : 10);
  form.slotsFL = String(fc.slotsFL != null ? fc.slotsFL : 3);
  form.typeFL = String(fc.typeFL != null ? fc.typeFL : 207); // 207 = Линкор
  form.minSPY = String(fc.minSPY != null ? fc.minSPY : 15);

  // 4) Токен submit-кнопки панели — парсим со страницы (имя меняется на каждом рендере)
  const tagRe = /<input[^>]*type="submit"[^>]*>/g;
  let btnName = null;
  while ((m = tagRe.exec(listHtml)) !== null) {
    const tag = m[0];
    if (/\[\s*Отправить\s*\]/.test(tag)) {
      const nm = tag.match(/name="([^"]+)"/);
      if (nm) { btnName = nm[1]; break; }
    }
  }
  if (!btnName) {
    return { ok: false, error: "Панель «Ишкофарм» не найдена на странице (нет кнопки [ Отправить ])" };
  }
  form[btnName] = "[ Отправить ]";

  const { status: s2, html: resp } = await postForm(context, MSG_URL + "&lim=1", form, { referer });
  if (s2 !== 200) return { ok: false, error: `HTTP ${s2}` };

  const { extractError } = require("./parse-form");
  const err = extractError(resp);
  if (err) return { ok: false, error: err };
  return { ok: true };
}

/**
 * Основной цикл автофарма.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 * @param {Object} missionsData — результат collectMissions()
 * @returns {Promise<Object>} отчёт цикла
 */
async function runFarmCycle(context, config, missionsData) {
  const fc = config.farm || {};
  if (!fc.enabled) return { skipped: "farm disabled" };
  const dryRun = fc.dryRun !== false;

  const state = dataStore.load();
  state.farm = state.farm || { farmed: {}, lastSystem: null };
  state.farm.farmed = state.farm.farmed || {};

  const report = { conditions: null, spied: [], farmed: [], verified: [] };

  // --- 0. Основной флот должен быть на главной луне (оттуда фармим) ---
  const mf = fleetState.getMainFleet();
  if (mf.at !== "home-moon") {
    const reason = `Основной флот не на главной луне (сейчас: ${mf.coords}, cp=${mf.cp})`;
    console.log(`🌾 [farm] ${reason} — фарм ждёт`);
    report.conditions = { ok: false, reasons: [reason], freeSlots: null, battleships: null };
    dataStore.save(state);
    return report;
  }

  // --- 1. Условия ---
  const cond = await checkFarmConditions(context, config, missionsData);
  report.conditions = cond;
  if (!cond.ok) {
    console.log(`🌾 [farm] Условия не выполнены: ${cond.reasons.join("; ")}`);
    dataStore.save(state);
    return report;
  }
  console.log(`🌾 [farm] Условия выполнены (слоты=${cond.freeSlots}, линкоры=${cond.battleships}) — ищем цели`);

  // координаты, по которым уже летят атаки/фарм
  const busy = busyTargetCoords(missionsData.missions);
  const ourCoords = (state.bodies || []).map((b) => b.coords);

  // --- 2. Выбор системы: home, затем следующие ---
  const systems = fc.systems || [config.home.system, config.home.system + 1, config.home.system + 2];
  let systemData = null;
  let targets = [];
  for (const sys of systems) {
    const gd = sys === config.home.system
      ? await getSystem(context, config.home.galaxy, sys)
      : await switchSystem(context, config.home.galaxy, sys);
    const t = findInactiveTargets(gd, {
      ourCoords,
      busyCoords: [...busy],
      includeVacation: !!fc.includeVacation,
    });
    if (t.length > 0) {
      systemData = gd;
      targets = t;
      console.log(`🌾 [farm] Система ${gd.galaxy}:${sys}: неактивных целей ${t.length}`);
      break;
    }
    console.log(`🌾 [farm] Система ${sys}: новых целей нет — следующая`);
  }

  if (!targets.length) {
    console.log("🌾 [farm] Новых целей нет в доступных системах");
    dataStore.save(state);
    return report;
  }

  // --- 3. Шпионаж по новым целям ---
  const spyRes = await spyTargets(context, config, targets, { dryRun });
  report.spied = spyRes.sent;

  // --- 4. Шпионские доклады → Ишкофарм ---
  // (доклады появляются через 1-3 минуты после прилёта зондов)
  const msgsHtml = await fetchMessagesPage(context);
  const messages = parseMessages(msgsHtml);
  const spyReports = filterSpyReports(messages);

  const sysSet = new Set(targets.map((t) => `${t.galaxy}:${t.system}`));
  const farmCooldownMs = fc.farmCooldownMs || 12 * 3600 * 1000;
  const now = Date.now();

  // --- 4.1. Верификация ранее отправленного фарма ---
  // Шпионы летают не мгновенно: после отправки «Ишкофарм» ждём, пока миссия
  // появится в overview (missionsData собран на этом тике). Подтвердилось →
  // farmed (кулдаун 12ч). Не подтвердилось 10 минут → снимаем sent и повторяем.
  // Так кулдаун не ставится «в воздух» при тихом сбое отправки.
  state.farm.sent = state.farm.sent || {};
  const SENT_RETRY_MS = 10 * 60 * 1000;
  for (const [coords, info] of Object.entries(state.farm.sent)) {
    const isFlying = missionsData.missions.some((m) => {
      const t = classifyMission(m);
      return (t === "attack" || t === "farm") && m.coords.includes(coords);
    });
    if (isFlying) {
      state.farm.farmed[coords] = Date.now();
      delete state.farm.sent[coords];
      report.verified.push({ coords, type: "verified" });
      console.log(`🌾 [farm] Верифицировано: ${coords} — фарм-флот летит`);
    } else if (Date.now() - info.at > SENT_RETRY_MS) {
      delete state.farm.sent[coords];
      console.log(`🌾 [farm] ${coords}: миссия не подтвердилась за 10 мин — повторим по докладу ${info.reportId}`);
    }
  }

  for (const msg of spyReports) {
    if (!msg.coords) continue;
    const [g, s] = msg.coords.split(":");
    if (!sysSet.has(`${g}:${s}`)) continue; // не та система
    if (state.farm.farmed[msg.coords] && now - state.farm.farmed[msg.coords] < farmCooldownMs) continue;
    if (state.farm.sent[msg.coords]) continue; // уже отправлено, ждём верификации
    if (busy.has(msg.coords)) continue; // по этим координатам уже летит флот

    const res = dryRun
      ? { ok: true, dryRun: true }
      : await farmFromReport(context, config, msg.id);

    if (res.ok) {
      if (!dryRun) state.farm.sent[msg.coords] = { at: now, reportId: msg.id };
      report.farmed.push({ id: msg.id, coords: msg.coords, dryRun });
      console.log(`🌾 [farm] Ишкофарм по докладу ${msg.id} → ${msg.coords} [${dryRun ? "dry-run" : "sent, ждём верификации"}]`);
    } else {
      console.warn(`❌ [farm] Ишкофарм ${msg.id} → ${msg.coords}: ${res.error}`);
    }
    if (!dryRun) await new Promise((r) => setTimeout(r, 1500));
  }

  state.farm.lastSystem = systemData ? systemData.system : state.farm.lastSystem;
  // Сохраняем ПЕРЕЗАГРУЖЕННый state: наша копия state загружена до spyTargets(),
  // и простой save(state) затрёт spy_sent (кулдауны шпионажа), который записал
  // spy.js. Мержим только секцию farm.
  const fresh = dataStore.load();
  fresh.farm = fresh.farm || { farmed: {} };
  fresh.farm.farmed = { ...(fresh.farm.farmed || {}), ...state.farm.farmed };
  fresh.farm.sent = { ...(fresh.farm.sent || {}), ...state.farm.sent };
  fresh.farm.lastSystem = state.farm.lastSystem;
  dataStore.save(fresh);
  return report;
}

module.exports = { runFarmCycle, checkFarmConditions, farmFromReport, busyTargetCoords, fetchMessagesPage };

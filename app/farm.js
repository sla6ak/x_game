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

  // 1) Нет вражеских атак на наши тела
  const incoming = (missionsData.attacks && missionsData.attacks.incoming) || [];
  if (incoming.length > 0) {
    reasons.push(`Входящие атаки: ${incoming.length} — фарм отложен (приоритет сейв)`);
  }

  // 2) Свободные слоты флота на луне (fleet.php?cp=moonCp)
  let freeSlots = null;
  let battleships = null;
  try {
    const html = await fetchHtml(context, `/fleet.php?cp=${fc.fromMoonCp || config.moonCp}`);
    const fleet = parseFleet(html);
    freeSlots = fleet.freeSlots;
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

  const minFree = fc.minFreeSlots != null ? fc.minFreeSlots : 3;
  const minBattleships = fc.minBattleships != null ? fc.minBattleships : 10_000_000;

  if (freeSlots != null && freeSlots <= minFree) {
    reasons.push(`Свободных слотов ${freeSlots} (нужно > ${minFree})`);
  }
  if (battleships != null && battleships < minBattleships) {
    reasons.push(`Линкоров ${battleships} (нужно >= ${minBattleships})`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    freeSlots,
    battleships,
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
 * Отправить «Ишкофарм» по шпионскому докладу.
 * Форма select на messages.php?mode=show&messcat=100:
 *   gRPhPPPPh=[Отправить] + настройки панели (typeFL, moreFL, slotsFL, minSPY, resFL)
 *   + delmes<ID> (выбранный доклад) + showmes<ID> (все видимые строки)
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 * @param {string} reportId — id сообщения (доклада)
 * @returns {Promise<Object>} { ok, error? }
 */
async function farmFromReport(context, config, reportId) {
  const fc = config.farm || {};
  const html = await fetchHtml(context, "/messages.php?mode=show&messcat=100");

  // собираем все showmes-поля со страницы (они обязательны в форме)
  const form = {};
  form.messages = "1";
  form.category = "100";
  form.sortDesc = "DESC";
  form.pageMess = "1";
  const showmesRe = /name="showmes(\d+)" type="hidden" value="\1"/g;
  let m;
  while ((m = showmesRe.exec(html)) !== null) {
    form[`showmes${m[1]}`] = m[1];
  }
  if (form[`showmes${reportId}`] == null) {
    return { ok: false, error: `Доклад ${reportId} не найден на странице сообщений` };
  }

  // выбранный доклад
  form[`delmes${reportId}`] = "on";

  // настройки панели Ишкофарм
  if (fc.resFL !== false) form.resFL = "on";
  form.maxFL = String(fc.maxFL != null ? fc.maxFL : 0);
  form.moreFL = String(fc.moreFL != null ? fc.moreFL : 10);
  form.slotsFL = String(fc.slotsFL != null ? fc.slotsFL : 3);
  form.typeFL = String(fc.typeFL != null ? fc.typeFL : 207); // 207 = Линкор
  form.minSPY = String(fc.minSPY != null ? fc.minSPY : 15);
  form.gRPhPPPPh = "[ Отправить ]";

  const { status, html: resp } = await postForm(
    context,
    "/messages.php?mode=show&messcat=100&lim=1",
    form
  );
  if (status !== 200) return { ok: false, error: `HTTP ${status}` };

  const { stripHtml, extractError } = require("./parse-form");
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

  // --- 1. Условия ---
  const cond = await checkFarmConditions(context, config, missionsData);
  report.conditions = cond;
  if (!cond.ok) {
    console.log(`🌾 [farm] Условия не выполнены: ${cond.reasons.join("; ")}`);
    dataStore.save(state);
    return report;
  }

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
  const msgsHtml = await fetchHtml(context, "/messages.php?mode=show&messcat=100");
  const messages = parseMessages(msgsHtml);
  const spyReports = filterSpyReports(messages);

  const sysSet = new Set(targets.map((t) => `${t.galaxy}:${t.system}`));
  const farmCooldownMs = fc.farmCooldownMs || 12 * 3600 * 1000;
  const now = Date.now();

  for (const msg of spyReports) {
    if (!msg.coords) continue;
    const [g, s] = msg.coords.split(":");
    if (!sysSet.has(`${g}:${s}`)) continue; // не та система
    if (state.farm.farmed[msg.coords] && now - state.farm.farmed[msg.coords] < farmCooldownMs) continue;

    const res = dryRun
      ? { ok: true, dryRun: true }
      : await farmFromReport(context, config, msg.id);

    if (res.ok) {
      state.farm.farmed[msg.coords] = now;
      report.farmed.push({ id: msg.id, coords: msg.coords, dryRun });
      console.log(`🌾 [farm] Ишкофарм по докладу ${msg.id} → ${msg.coords} [${dryRun ? "dry-run" : "sent"}]`);
    } else {
      console.warn(`❌ [farm] Ишкофарм ${msg.id} → ${msg.coords}: ${res.error}`);
    }
    if (!dryRun) await new Promise((r) => setTimeout(r, 1500));
  }

  // --- 5. Верификация: миссии в overview ---
  if (report.farmed.length && !dryRun) {
    const { collectMissions } = require("./missions");
    const fresh = await collectMissions(context, config);
    const farmCoords = new Set(report.farmed.map((f) => f.coords));
    for (const m of fresh.missions) {
      const type = classifyMission(m);
      if ((type === "attack" || type === "farm") && m.coords.some((c) => farmCoords.has(c))) {
        report.verified.push({ coords: m.coords.join("→"), type });
      }
    }
    console.log(`🌾 [farm] Верификация: подтверждено миссий ${report.verified.length}`);
  }

  state.farm.lastSystem = systemData ? systemData.system : state.farm.lastSystem;
  dataStore.save(state);
  return report;
}

module.exports = { runFarmCycle, checkFarmConditions, farmFromReport, busyTargetCoords };

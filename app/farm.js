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
 *  2. Ротация систем: счётчик (курсор) по окну home ± systemRange (config.farm.systemRange).
 *     Порядок: home, home+1..home+range, home-1..home-range, затем снова home.
 *     Курсор хранится в state (farm.cursor) — если миссии заняты, цикл выходит
 *     на ранней проверке, и следующий тик продолжает с той же системы.
 *  3. Шпионаж: зонды на неактивные цели текущей системы (spy.js).
 *  4. Сообщения: шпионские доклады текущей системы → «Ишкофарм» (messages.php,
 *     панель со 100 докладами, submit-кнопка — динамический токен).
 *  5. Верификация: миссия появилась в overview (секция sent → farmed).
 *
 * Система считается обработанной, когда все её цели прошпионены (spy_sent)
 * и по ней не осталось «фермных» докладов (farmed/sent). Тогда курсор
 * переходит к следующей системе. Защита от зависания: maxSystemWaitMs.
 *
 * Состояние (data/bot-state.json):
 *   farm: {
 *     farmed: { "g:s:p": timestamp },   // подтверждённый фарм (кулдаун 12ч)
 *     sent:   { "g:s:p": { at, reportId } }, // отправлен, ждём верификации
 *     cursor: 363,                      // текущая система (счётчик)
 *     cursorSince: timestamp            // когда начали работать с этой системой
 *   }
 */

const { fetchHtml, postForm, BASE } = require("./http");
const { parseMessages, filterSpyReports } = require("./parsers/messages");
const { getSystem, switchSystem, findInactiveTargets } = require("./galaxy");
const { spyTargets } = require("./spy");
const { parseFleet } = require("./parsers/fleet");
const {
  classifyMission,
  isMainMoonUnderAttack,
  collectMissions,
} = require("./missions");
const { extractError } = require("./parsers/forms");
const { delay, randomizeMs } = require("./helpers/async");
const dataStore = require("./data-store");
const fleetState = require("./fleet-state");

function normalizeFleetMetricValue(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).replace(/\s+/g, "").replace(/,/g, "");
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveBattleshipsFromFleet(fleet, shipName = "Линкор") {
  const raw = (fleet?.ships || []).find(
    (s) => s.name === shipName || s.name === "Линкор",
  );
  if (raw && raw.available != null) {
    const parsed = normalizeFleetMetricValue(raw.available);
    return parsed > 0 ? parsed : 0;
  }

  // Важно: если в свежем fleet.php нет подтверждённого raw ship-инпута,
  // не подменяем это старым или «доковым» tooltip-значением. При отсутствии
  // живых данных считаем, что доступных линкоров нет.
  return 0;
}

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
  const minBattleships =
    fc.minBattleships != null ? fc.minBattleships : 20_000_000_000;

  // 1) Нет атак на главную луну (PLAN: фарм только когда её не атакуют)
  const mainMoonAttacks =
    missionsData.mainMoonIncoming ||
    (isMainMoonUnderAttack(missionsData, config) ? [{}] : []);
  if (mainMoonAttacks.length > 0) {
    reasons.push(
      `Атака на главную луну (${mainMoonAttacks.length}) — фарм отложен (приоритет сейва)`,
    );
  }

  // 2) Свободные ОБЩИЕ слоты флота на луне (fleet.php?cp=moonCp)
  //    Считаются из текстового счётчика «Флоты X из Y» (все миссии),
  //    НЕ из экспедиционных hidden-полей (только миссии-экспедиции).
  let freeSlots = null;
  let freeSlotsSource = null;
  let fleetMax = null;
  let battleships = null;
  try {
    const html = await fetchHtml(
      context,
      `/fleet.php?cp=${fc.fromMoonCp || config.moonCp}`,
    );
    const fleet = parseFleet(html);
    freeSlots = fleet.freeSlots;
    freeSlotsSource = fleet.freeSlotsSource;
    fleetMax = fleet.fleetMax;
    // линкоры: из ship-инпутов (если есть в raw) или из дока
    battleships = resolveBattleshipsFromFleet(fleet, fc.shipName || "Линкор");
  } catch (e) {
    reasons.push(`Не удалось прочитать флот луны: ${e.message}`);
  }

  // Детальный лог каждой проверки (✅/❌) — видно, где именно не сработало
  const checks = [];
  checks.push(
    `атака глав.луны=${mainMoonAttacks.length} ${mainMoonAttacks.length === 0 ? "✅" : "❌"}`,
  );
  if (freeSlots != null) {
    const ok = freeSlots > minFree;
    checks.push(
      `слоты=${freeSlots} из ${fleetMax ?? "?"} (нужно >${minFree}) ${ok ? "✅" : "❌"}`,
    );
    if (!ok) reasons.push(`Свободных слотов ${freeSlots} (нужно > ${minFree})`);
  } else {
    checks.push(
      `слоты=не распарсилось ${freeSlotsSource ? `(${freeSlotsSource})` : ""} ❌`,
    );
    reasons.push("Не удалось определить свободные слоты флота");
  }
  if (battleships != null) {
    const ok = battleships >= minBattleships;
    checks.push(
      `линкоры=${battleships} (нужно >=${minBattleships}) ${ok ? "✅" : "❌"}`,
    );
    if (!ok)
      reasons.push(`Линкоров ${battleships} (нужно >= ${minBattleships})`);
  } else {
    battleships = 0;
    checks.push(`линкоры=0 (не найдено в свежем fleet.php) ❌`);
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
    incomingCount: mainMoonAttacks.length,
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

function parseSpySentMeta(value) {
  if (value == null) return { ts: 0, permanent: false };
  if (typeof value === "object") {
    return {
      ts: Number(value.ts ?? value.at ?? 0) || 0,
      permanent: !!value.permanent,
    };
  }
  return { ts: Number(value) || 0, permanent: false };
}

function hasPendingIshkoFarmReports(
  reports,
  farmState = {},
  now = Date.now(),
  farmCooldownMs = 12 * 60 * 60 * 1000,
) {
  const farmed = farmState.farmed || {};
  const sent = farmState.sent || {};
  for (const msg of reports || []) {
    const key = msg.coords || `report:${msg.id}`;
    const farmedTs = Number(farmed[key] || 0);
    const isSent = !!sent[key];
    if (isSent) return true;
    if (farmedTs && now - farmedTs < farmCooldownMs) return true;
  }
  return false;
}

function filterPendingSpyTargets(targets, spySent = {}, opts = {}) {
  const cooldownMs = opts.cooldownMs || 6 * 60 * 60 * 1000;
  const now = Date.now();
  const ignoreCooldown = !!opts.ignoreCooldown;
  return (targets || []).filter((t) => {
    const meta = parseSpySentMeta(spySent[t.coords]);
    if (meta.permanent) return false;
    if (!ignoreCooldown && meta.ts && now - meta.ts < cooldownMs) return false;
    return true;
  });
}

function shouldIgnoreSpyCooldownForSystem(
  farmState = {},
  system,
  now = Date.now(),
) {
  if (farmState == null) return true;
  const activeSystem = Number(farmState.cursor);
  const hasActiveSystem = Number.isFinite(activeSystem);
  if (!hasActiveSystem) return true;
  if (Number(activeSystem) !== Number(system)) return true;
  if (!farmState.cursorSince) return true;
  return false;
}

function pruneExpiredSpySentForTargets(targets, spySent = {}, opts = {}) {
  const cooldownMs = opts.cooldownMs || 6 * 60 * 60 * 1000;
  const now = Date.now();
  const staleCoords = [];
  for (const target of targets || []) {
    const meta = parseSpySentMeta(spySent[target.coords]);
    if (!meta.ts) continue;
    if (!meta.permanent && now - meta.ts >= cooldownMs) {
      staleCoords.push(target.coords);
    }
  }
  return staleCoords;
}

function getSystemWindow(homeSystem, radius = 30) {
  const windowSystems = [];
  for (let sys = homeSystem - radius; sys <= homeSystem + radius; sys++) {
    windowSystems.push(sys);
  }
  return windowSystems;
}

function getNextSystemInWindow(currentSystem, homeSystem, radius = 30) {
  const windowSystems = getSystemWindow(homeSystem, radius);
  const idx = windowSystems.indexOf(Number(currentSystem));
  if (idx === -1) return homeSystem - radius;
  return windowSystems[(idx + 1) % windowSystems.length];
}

function isSystemWindowComplete(processedSystems, homeSystem, radius = 30) {
  const required = new Set(getSystemWindow(homeSystem, radius).map(String));
  const actual = new Set(Object.keys(processedSystems || {}).map(String));
  for (const sys of required) {
    if (!actual.has(sys)) return false;
  }
  return true;
}

/**
 * Страница сообщений (категория 100) на 100 сообщений.
 * GET отдаёт компактный список (10 сообщений, без панели «Ишкофарм»);
 * POST формы select с pageMess=0 — полная страница со 100 докладами и панелью.
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<string>} raw-HTML
 */
async function fetchMessagesPage(context) {
  const url = "/messages.php?mode=show&messcat=100";
  const { status, html } = await postForm(
    context,
    url + "&lim=1",
    { messages: "1", category: "100", sortDesc: "DESC", pageMess: "0" },
    { referer: BASE + url },
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
  const form = {
    messages: "1",
    category: "100",
    sortDesc: "DESC",
    pageMess: "0",
  };
  const showmesRe = /name="showmes(\d+)" type="hidden" value="\1"/g;
  let m;
  while ((m = showmesRe.exec(listHtml)) !== null) {
    form[`showmes${m[1]}`] = m[1];
  }
  if (form[`showmes${reportId}`] == null) {
    return {
      ok: false,
      error: `Доклад ${reportId} не найден на странице сообщений`,
    };
  }

  // 3) Выбранный доклад + настройки панели Ишкофарм
  form[`delmes${reportId}`] = "on";
  if (fc.resFL !== false) form.resFL = "on";
  form.maxFL = String(fc.maxFL != null ? fc.maxFL : 0);
  form.moreFL = String(fc.moreFL != null ? fc.moreFL : 10);
  form.slotsFL = String(fc.slotsFL != null ? fc.slotsFL : 3);
  form.typeFL = String(fc.typeFL != null ? fc.typeFL : 207); // 207 = Линкор
  // В игре старые доклады уже отфильтровываются сами. Для Ишкофарма
  // по факту достаточно выставить окно 10 минут и просто шпионить/жать
  // кнопку по кругу, без дополнительного контроля возраста докладов в боте.
  form.minSPY = String(fc.minSPY != null ? fc.minSPY : 10);

  // 4) Токен submit-кнопки панели — парсим со страницы (имя меняется на каждом рендере)
  const tagRe = /<input[^>]*type="submit"[^>]*>/g;
  let btnName = null;
  while ((m = tagRe.exec(listHtml)) !== null) {
    const tag = m[0];
    if (/\[\s*Отправить\s*\]/.test(tag)) {
      const nm = tag.match(/name="([^"]+)"/);
      if (nm) {
        btnName = nm[1];
        break;
      }
    }
  }
  if (!btnName) {
    return {
      ok: false,
      error:
        "Панель «Ишкофарм» не найдена на странице (нет кнопки [ Отправить ])",
    };
  }
  form[btnName] = "[ Отправить ]";

  const { status: s2, html: resp } = await postForm(
    context,
    MSG_URL + "&lim=1",
    form,
    { referer },
  );
  if (s2 !== 200) return { ok: false, error: `HTTP ${s2}` };

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
  state.farm = state.farm || { farmed: {}, sent: {} };
  state.farm.farmed = state.farm.farmed || {};
  state.farm.sent = state.farm.sent || {};

  const report = { conditions: null, spied: [], farmed: [], verified: [] };

  // Сохраняем ТОЛЬКО секцию farm (пЕРЕЗАГРУЖАЯ state): наша копия загружена
  // до spyTargets()/collectMissions(), и прямой save(state) затрёт изменения
  // других модулей (spy_sent, missions...).
  const saveFarmState = () => {
    const fresh = dataStore.load();
    fresh.farm = {
      ...(fresh.farm || {}),
      farmed: { ...(fresh.farm?.farmed || {}), ...state.farm.farmed },
      sent: { ...(fresh.farm?.sent || {}), ...state.farm.sent },
      cursor: state.farm.cursor,
      cursorSince: state.farm.cursorSince,
    };
    delete fresh.farm.lastSystem; // заменена на cursor
    delete fresh.farm.processedSystems; // упростили обход: нет списка обработанных систем
    dataStore.save(fresh);
  };

  // --- 0. Основной флот должен быть на главной луне (оттуда фармим) ---
  const mf = fleetState.getMainFleet();
  if (mf.at !== "home-moon") {
    const reason = `Основной флот не на главной луне (сейчас: ${mf.coords}, cp=${mf.cp})`;
    console.log(`🌾 [farm] ${reason} — фарм ждёт`);
    report.conditions = {
      ok: false,
      reasons: [reason],
      freeSlots: null,
      battleships: null,
    };
    saveFarmState();
    return report;
  }

  // --- 1. Условия ---
  const cond = await checkFarmConditions(context, config, missionsData);
  report.conditions = cond;
  if (!cond.ok) {
    console.log(`🌾 [farm] Условия не выполнены: ${cond.reasons.join("; ")}`);
    saveFarmState();
    return report;
  }
  console.log(
    `🌾 [farm] Условия выполнены (слоты=${cond.freeSlots}, линкоры=${cond.battleships}) — ищем цели`,
  );

  // координаты, по которым уже летят атаки/фарм
  const busy = busyTargetCoords(missionsData.missions);
  const ourCoords = (missionsData.bodies || []).map((b) => b.coords);

  // --- 2. Ротация систем: счётчик (курсор) по окну home ± systemRange ---
  // Ширина окна — config.farm.systemRange (по умолчанию 30): системы
  // home, home+1..home+range, home-1..home-range. Курсор персистентный:
  // если миссии заняты (ранний выход выше), следующий тик продолжит с той же.
  const homeSys = config.home.system;
  const range = fc.systemRange != null ? fc.systemRange : 30;
  const maxScan = fc.maxScanPerTick || 10;
  const GRACE_MS = randomizeMs(
    fc.reportGraceMs != null ? fc.reportGraceMs : 2 * 60 * 1000,
    0.1,
  );
  const MAX_SYSTEM_MS = randomizeMs(
    fc.maxSystemWaitMs != null ? fc.maxSystemWaitMs : 20 * 60 * 1000,
    0.1,
  );

  const windowSystems = getSystemWindow(homeSys, range);
  let cursor = Number.isInteger(state.farm.cursor)
    ? state.farm.cursor
    : homeSys - range;
  if (!windowSystems.includes(cursor)) cursor = homeSys - range;
  state.farm.cursor = cursor;

  const strictWaitForIshkoFarm = async (reason) => {
    state.farm.cursor = cursor;
    state.farm.cursorSince = Date.now();
    saveFarmState();
    console.warn(`⚠️ [farm] ${reason} — строгая пауза до отправки Ишкофарма`);
    return report;
  };

  let systemData = null;
  let targets = [];
  let scanned = 0;

  // Строгая пауза: если текущая система уже ждёт отправку Ишкофарма,
  // нельзя уходить в следующую систему и повторно шпионить те же цели.
  if (state.farm.cursor === cursor && state.farm.cursorSince) {
    const msgsHtml = await fetchMessagesPage(context);
    const messages = parseMessages(msgsHtml);
    const currentSystemReports = filterSpyReports(messages, {
      galaxy: config.home.galaxy,
      system: cursor,
    });
    const farmCooldownMs = fc.farmCooldownMs || 12 * 3600 * 1000;
    if (
      hasPendingIshkoFarmReports(
        currentSystemReports,
        state.farm,
        Date.now(),
        farmCooldownMs,
      )
    ) {
      return strictWaitForIshkoFarm(
        `Система ${cursor} держится на ожидании Ишкофарма`,
      );
    }
  }

  while (scanned < Math.max(windowSystems.length, maxScan)) {
    const gd =
      cursor === homeSys
        ? await getSystem(context, config.home.galaxy, cursor)
        : await switchSystem(context, config.home.galaxy, cursor);
    const rawTargets = findInactiveTargets(gd, {
      ourCoords,
      busyCoords: [...busy],
      includeVacation: !!fc.includeVacation,
    });
    const eligibleTargets = rawTargets.filter(
      (t) =>
        !["vacation", "banned"].includes(String(t.status || "").toLowerCase()),
    );
    const freshSpy = dataStore.load();
    // Обход по кругу НЕ должен останавливаться на свежем spy_sent.
    // Cooldown нужен только для защиты от немедленного повторного шпионажа
    // одной и той же цели, но не для блокировки движения по window.
    const pendingTargets = filterPendingSpyTargets(
      eligibleTargets,
      freshSpy.spy_sent || {},
      {
        cooldownMs: fc.spyCooldownMs || 60 * 1000,
        ignoreCooldown: shouldIgnoreSpyCooldownForSystem(
          state.farm,
          cursor,
          Date.now(),
        ),
      },
    );
    const vacationOnly = rawTargets.length > 0 && eligibleTargets.length === 0;
    scanned++;
    if (pendingTargets.length > 0) {
      systemData = gd;
      targets = pendingTargets;
      console.log(
        `🌾 [farm] Система ${gd.galaxy}:${cursor}: неактивных целей ${pendingTargets.length} (проход по кругу ${windowSystems.join(",")})`,
      );
      break;
    }
    if (vacationOnly || rawTargets.length === 0) {
      const nextIdx =
        (windowSystems.indexOf(Number(cursor)) + 1) % windowSystems.length;
      cursor = windowSystems[nextIdx];
      state.farm.cursor = cursor;
      state.farm.cursorSince = null;
      saveFarmState();
      continue;
    }
    if (rawTargets.length > 0 && pendingTargets.length === 0) {
      // В круговом обходе не держим систему на одной и той же цели из-за
      // свежего spy_sent: просто переходим к следующей системе и продолжаем.
      const nextIdx =
        (windowSystems.indexOf(Number(cursor)) + 1) % windowSystems.length;
      cursor = windowSystems[nextIdx];
      state.farm.cursor = cursor;
      state.farm.cursorSince = null;
      saveFarmState();
      continue;
    }
  }

  if (
    !targets.length &&
    Number(state.farm.cursor) === Number(cursor) &&
    state.farm.cursorSince &&
    Date.now() - state.farm.cursorSince >= GRACE_MS
  ) {
    console.log(
      `🌾 [farm] Система ${cursor}: grace-период истёк, проверяем доклады и запускаем Ишкофарм`,
    );

    const msgsHtml = await fetchMessagesPage(context);
    const messages = parseMessages(msgsHtml);
    const spyReports = filterSpyReports(messages, {
      galaxy: config.home.galaxy,
      system: cursor,
    });

    const farmCooldownMs = fc.farmCooldownMs || 12 * 3600 * 1000;
    const now = Date.now();
    state.farm.sent = state.farm.sent || {};
    for (const msg of spyReports) {
      const targetKey = msg.coords || `report:${msg.id}`;
      if (
        state.farm.farmed[targetKey] &&
        now - state.farm.farmed[targetKey] < farmCooldownMs
      )
        continue;
      if (state.farm.sent[targetKey]) continue;
      if (msg.coords && busy.has(msg.coords)) continue;

      const res = dryRun
        ? { ok: true, dryRun: true }
        : await farmFromReport(context, config, msg.id);

      if (res.ok) {
        if (!dryRun) {
          state.farm.sent[targetKey] = {
            at: now,
            reportId: msg.id,
            coords: msg.coords || null,
          };
        }
        report.farmed.push({
          id: msg.id,
          coords: msg.coords || null,
          dryRun,
        });
        console.log(
          `🌾 [farm] Ишкофарм по докладу ${msg.id}${msg.coords ? ` → ${msg.coords}` : ""} [${dryRun ? "dry-run" : "sent, ждём верификации"}]`,
        );
      } else {
        const fleetShortage =
          /нет флотов|некуда вылетать|необходимы для и шкофарма|недостаточно флотов|нет подходящих флотов/i.test(
            String(res.error || ""),
          );
        if (fleetShortage) {
          // СТРОГАЯ ПАУЗА: если реальная проверка условий говорит, что флоты
          // на луне отсутствуют, бот не двигает курсор и не шпионит дальше.
          // Он ждет следующей итерации, когда только повторно проверит условия.
          state.farm.cursor = cursor;
          state.farm.cursorSince = Date.now();
          saveFarmState();
          console.warn(
            `⚠️ [farm] На луне нет флотов для Ишкофарма в системе ${cursor}; полная пауза до свежей проверки условий`,
          );
          return report;
        }
        console.warn(
          `❌ [farm] Ишкофарм ${msg.id}${msg.coords ? ` → ${msg.coords}` : ""}: ${res.error}`,
        );
      }
      if (!dryRun) await delay(randomizeMs(1500, 0.1));
    }

    const refreshedMissionsData = await collectMissions(context, config);
    const condAfter = await checkFarmConditions(
      context,
      config,
      refreshedMissionsData,
    );
    report.conditions = condAfter;
    if (!condAfter.ok) {
      console.log(
        `🌾 [farm] Условия после шпионажа/ишкофарма не выполнены: ${condAfter.reasons.join("; ")} — ждём свободные миссии и корабли`,
      );
      state.farm.cursor = cursor;
      state.farm.cursorSince = Date.now();
      saveFarmState();
      return report;
    }

    const freshSpy = dataStore.load();
    const spiedSet = new Set(Object.keys(freshSpy.spy_sent || {}));
    const allSpied = true;
    const farmableLeft = spyReports.filter((r) => {
      const targetKey = r.coords || `report:${r.id}`;
      if (
        state.farm.farmed[targetKey] &&
        now - state.farm.farmed[targetKey] < farmCooldownMs
      )
        return false;
      if (state.farm.sent[targetKey]) return false;
      if (r.coords && busy.has(r.coords)) return false;
      return true;
    });
    const sinceGrace = state.farm.cursorSince || now;
    const elapsed = Date.now() - sinceGrace;
    const gracePassed = elapsed >= GRACE_MS;
    const stuckTooLong = elapsed >= MAX_SYSTEM_MS;

    if (
      stuckTooLong ||
      (allSpied && farmableLeft.length === 0 && gracePassed)
    ) {
      const done = cursor;
      const nextIdx =
        (windowSystems.indexOf(Number(cursor)) + 1) % windowSystems.length;
      cursor = windowSystems[nextIdx];
      state.farm.cursor = cursor;
      state.farm.cursorSince = null;
      console.log(
        `🌾 [farm] Система ${done} обработана после докладов — следующая: ${cursor}`,
      );
    } else {
      console.log(
        `🌾 [farm] Система ${cursor}: ждём после grace (${Math.round(elapsed / 60000)}/${Math.round(GRACE_MS / 60000)} мин)`,
      );
    }

    state.farm.cursor = cursor;
    saveFarmState();
    return report;
  }

  if (!targets.length) {
    const idx = windowSystems.indexOf(Number(cursor));
    const next = windowSystems[(idx + 1) % windowSystems.length];
    console.log(
      `🌾 [farm] Целей нет (проверено систем: ${scanned}, курсор теперь ${next})`,
    );
    state.farm.cursor = next;
    state.farm.cursorSince = null;
    saveFarmState();
    return report;
  }

  // Только что начали работать с системой — запускаем grace-таймер.
  // Зондам нужно 1-3 минуты, чтобы вернуть доклады, а по плану: сначала
  // отправить шпионаж, потом ждать grace-период до обработки докладов.
  if (!state.farm.cursorSince) {
    state.farm.cursorSince = Date.now();
  }

  // --- 3. Шпионаж по новым целям ---
  const spyRes = await spyTargets(context, config, targets, {
    dryRun,
    ignoreCooldown: shouldIgnoreSpyCooldownForSystem(
      state.farm,
      cursor,
      Date.now(),
    ),
  });
  report.spied = spyRes.sent;

  const spyNow = Date.now();
  const graceElapsed = spyNow - (state.farm.cursorSince || spyNow) >= GRACE_MS;
  if (spyRes.sent.length === 0) {
    console.log(
      `🌾 [farm] Нет новых шпионских отправок в ${cursor}: ждём/пропускаем доклады`,
    );
    state.farm.cursor = cursor;
    saveFarmState();
    return report;
  }
  if (!graceElapsed) {
    console.log(
      `🌾 [farm] Система ${cursor}: ждём доклады шпионов (${Math.round((GRACE_MS - (spyNow - (state.farm.cursorSince || spyNow))) / 60000)} мин до Ишкофарма)`,
    );
    state.farm.cursor = cursor;
    saveFarmState();
    return report;
  }

  // Строгий стоп: после grace-задержки нельзя повторно шпионить, пока
  // в этой системе есть доклады, ожидающие Ишкофарма.
  const waitMsgsHtml = await fetchMessagesPage(context);
  const waitMessages = parseMessages(waitMsgsHtml);
  const waitSpyReports = filterSpyReports(waitMessages, {
    galaxy: config.home.galaxy,
    system: cursor,
  });
  const waitFarmCooldownMs = fc.farmCooldownMs || 12 * 3600 * 1000;
  if (
    hasPendingIshkoFarmReports(
      waitSpyReports,
      state.farm,
      Date.now(),
      waitFarmCooldownMs,
    )
  ) {
    return strictWaitForIshkoFarm(
      `Система ${cursor} ждёт доставку докладов перед новым шпионажем`,
    );
  }

  // --- 4. Шпионские доклады → Ишкофарм ---
  // (доклады появляются через 1-3 минуты после прилёта зондов)
  const msgsHtml = await fetchMessagesPage(context);
  const messages = parseMessages(msgsHtml);
  const spyReports = filterSpyReports(messages, {
    galaxy: config.home.galaxy,
    system: cursor,
  });

  const cursorSys = String(cursor);
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
      console.log(
        `🌾 [farm] ${coords}: миссия не подтвердилась за 10 мин — повторим по докладу ${info.reportId}`,
      );
    }
  }

  for (const msg of spyReports) {
    const targetKey = msg.coords || `report:${msg.id}`;

    if (
      state.farm.farmed[targetKey] &&
      now - state.farm.farmed[targetKey] < farmCooldownMs
    )
      continue;
    if (state.farm.sent[targetKey]) continue; // уже отправлено, ждём верификации
    if (msg.coords && busy.has(msg.coords)) continue; // по этим координатам уже летит флот

    const res = dryRun
      ? { ok: true, dryRun: true }
      : await farmFromReport(context, config, msg.id);

    if (res.ok) {
      if (!dryRun) {
        state.farm.sent[targetKey] = {
          at: now,
          reportId: msg.id,
          coords: msg.coords || null,
        };
      }
      report.farmed.push({
        id: msg.id,
        coords: msg.coords || null,
        dryRun,
      });
      console.log(
        `🌾 [farm] Ишкофарм по докладу ${msg.id}${msg.coords ? ` → ${msg.coords}` : ""} [${dryRun ? "dry-run" : "sent, ждём верификации"}]`,
      );
    } else {
      const fleetShortage =
        /нет флотов|некуда вылетать|необходимы для и шкофарма|недостаточно флотов|нет подходящих флотов/i.test(
          String(res.error || ""),
        );
      if (fleetShortage) {
        state.farm.cursor = cursor;
        state.farm.cursorSince = Date.now();
        saveFarmState();
        console.warn(
          `⚠️ [farm] Нет флотов для Ишкофарма в системе ${cursor}; полная пауза до свежей проверки условий`,
        );
        return report;
      }
      console.warn(
        `❌ [farm] Ишкофарм ${msg.id}${msg.coords ? ` → ${msg.coords}` : ""}: ${res.error}`,
      );
    }
    if (!dryRun) await delay(1500);
  }

  // Проверяем условия заново после шпионажа/докладов: мисии и корабли должны
  // быть свободны, иначе мы не переходим к следующей системе, а ждём, пока
  // освободятся слоты и линкоры.
  const refreshedMissionsData = await collectMissions(context, config);
  const condAfter = await checkFarmConditions(
    context,
    config,
    refreshedMissionsData,
  );
  report.conditions = condAfter;
  if (!condAfter.ok) {
    console.log(
      `🌾 [farm] Условия после шпионажа/ишкофарма не выполнены: ${condAfter.reasons.join("; ")} — ждём свободные миссии и корабли`,
    );
    state.farm.cursor = cursor;
    state.farm.cursorSince = Date.now();
    saveFarmState();
    return report;
  }

  // --- 5. Система обработана? Переходим к следующей ---
  // Обработана = все цели прошпионены (spy_sent) И по системе не осталось
  // «фермных» докладов (все farmed/sent/busy) И прошёл grace-период
  // (зонды успели долететь). Если застряли на системе > maxSystemWaitMs —
  // переходим принудительно.
  const freshSpy = dataStore.load();
  const spiedSet = new Set(Object.keys(freshSpy.spy_sent || {}));
  const allSpied = targets.every((t) => spiedSet.has(t.coords));
  const farmableLeft = spyReports.filter((r) => {
    const targetKey = r.coords || `report:${r.id}`;
    if (
      state.farm.farmed[targetKey] &&
      now - state.farm.farmed[targetKey] < farmCooldownMs
    )
      return false;
    if (state.farm.sent[targetKey]) return false;
    if (r.coords && busy.has(r.coords)) return false;
    return true;
  });

  const sinceGrace = state.farm.cursorSince || now;
  const elapsed = Date.now() - sinceGrace;
  const gracePassed = elapsed >= GRACE_MS;
  const stuckTooLong = elapsed >= MAX_SYSTEM_MS;

  if (stuckTooLong || (allSpied && farmableLeft.length === 0 && gracePassed)) {
    const done = cursor;
    const nextIdx =
      (windowSystems.indexOf(Number(cursor)) + 1) % windowSystems.length;
    cursor = windowSystems[nextIdx];
    state.farm.cursor = cursor;
    state.farm.cursorSince = null;
    console.log(
      `🌾 [farm] Система ${done} обработана (целей прошпионено: ${allSpied}, докладов осталось: ${farmableLeft.length}, ${stuckTooLong ? "принудительно" : "grace"}) — следующая: ${cursor}`,
    );
  } else {
    console.log(
      `🌾 [farm] Система ${cursor}: ждём (allSpied=${allSpied}, докладов осталось: ${farmableLeft.length}, grace ${Math.round(elapsed / 60000)}/${Math.round(GRACE_MS / 60000)} мин)`,
    );
  }

  state.farm.cursor = cursor;
  saveFarmState();
  return report;
}

module.exports = {
  runFarmCycle,
  checkFarmConditions,
  farmFromReport,
  busyTargetCoords,
  filterPendingSpyTargets,
  shouldIgnoreSpyCooldownForSystem,
  fetchMessagesPage,
  getSystemWindow,
  getNextSystemInWindow,
  isSystemWindowComplete,
  normalizeFleetMetricValue,
  resolveBattleshipsFromFleet,
  hasPendingIshkoFarmReports,
};

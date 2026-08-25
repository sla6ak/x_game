/**
 * expedition.js — запуск экспедиций из 1-й луны планеты 1:363:6.
 *
 * Архитектура:
 *  - getExpeditionPlan(): надёжный план по raw-HTML (слоты, корабли дока).
 *  - launchExpeditions(): выполняет план. dryRun=true → только лог (без отправки).
 *  - doRealLaunch(): реальная отправка через браузер (формы floten1 → цель).
 *
 * ВАЖНО: по умолчанию dryRun=true — бот НИЧЕГО не отправляет, только логирует.
 * Включать реальную отправку только после проверки плана.
 */

const { fetchHtml, BASE } = require("./http");
const { parseFleet } = require("./parsers/fleet");
const { blockResources } = require("./helpers/browser");
const { sendMission } = require("./mission-sender");

/**
 * Построить план экспедиции по raw-HTML флот-страницы луны.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 */
async function getExpeditionPlan(context, config) {
  const moonCp = config.expedition.fromMoonCp;
  const html = await fetchHtml(context, `/fleet.php?cp=${moonCp}`);
  const fleet = parseFleet(html);

  const shipName = config.expedition.shipName;
  const shipId = config.shipIds ? config.shipIds[shipName] || null : null;
  const liveShip = (fleet.ships || []).find((s) => s.name === shipName);
  const dockShip = (fleet.dockShips || []).find((s) => s.name === shipName);
  const availableShips =
    liveShip && liveShip.available != null
      ? Number(liveShip.available)
      : dockShip && dockShip.available != null
        ? Number(dockShip.available)
        : 0;

  const requestedCount = config.expedition.shipCount;
  const resolvedCount =
    requestedCount === "all" ||
    requestedCount === "ALL" ||
    requestedCount === null ||
    requestedCount === undefined ||
    requestedCount === ""
      ? "all"
      : Number(requestedCount);

  const reasons = [];
  if (!config.expedition.enabled) reasons.push("expedition disabled");
  if (!moonCp) reasons.push("missing moonCp");
  if (!config.expedition.targets || config.expedition.targets.length === 0)
    reasons.push("missing target");
  if (!shipId) reasons.push(`unknown shipId for ${shipName}`);
  if ((fleet.freeExpeditionSlots || 0) <= 0)
    reasons.push("no free expedition slots");
  if (availableShips <= 0) reasons.push("no ships available on moon");
  if (
    resolvedCount !== "all" &&
    (!Number.isFinite(Number(resolvedCount)) || Number(resolvedCount) <= 0)
  ) {
    reasons.push("invalid ship limit");
  }

  const ready = reasons.length === 0;
  const effectiveDryRun = Boolean(config.expedition.dryRun) || !ready;

  return {
    fromMoonCp: moonCp,
    fromCoords: fleet.coords,
    maxSlots: fleet.expMax,
    usedSlots: fleet.expUsed,
    freeSlots: fleet.freeExpeditionSlots || 0,
    // для отладки: общие миссии (не только экспедиционные)
    fleetFree: fleet.freeSlots,
    fleetMax: fleet.fleetMax,
    target: config.expedition.targets[0],
    shipName,
    shipId,
    shipCount: resolvedCount,
    availableShips,
    ready,
    readinessReasons: reasons,
    dryRun: effectiveDryRun,
  };
}

/**
 * Запустить экспедиции (dry-run или реальная отправка).
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 * @returns {Promise<Object|null>} план или null если слоты заняты
 */
async function launchExpeditions(context, config) {
  const plan = await getExpeditionPlan(context, config);

  if (plan.freeSlots <= 0) {
    console.log(
      `🧪 [expedition] Экспедиционные слоты заняты (${plan.usedSlots}/${plan.maxSlots}), ` +
        `общие миссии: ${plan.fleetMax != null ? `${plan.fleetFree} из ${plan.fleetMax} свободны` : "не распарсилось"} — ждём.`,
    );
    return null;
  }

  console.log(`🚀 [expedition] Свободных слотов: ${plan.freeSlots}. План:`);
  console.log(`   Откуда: ${plan.fromCoords} (cp=${plan.fromMoonCp})`);
  console.log(`   Куда:     ${plan.target}`);
  console.log(
    `   Корабль:  ${plan.shipName} (id=${plan.shipId}), лимит=${plan.shipCount}, реально на луне=${plan.availableShips}`,
  );

  if (plan.readinessReasons && plan.readinessReasons.length) {
    console.log(
      `🚦 [expedition] Автопроверка: готовность=${plan.ready ? "OK" : "NO"} — ${plan.readinessReasons.join("; ")}`,
    );
  } else {
    console.log(
      `🚦 [expedition] Автопроверка: готовность=OK — можно отправлять.`,
    );
  }

  if (plan.dryRun) {
    console.log(
      `🏃 [expedition] DRY-RUN: бот автоматически удерживает отправку, пока условия не готовы.`,
    );
    return plan;
  }

  // Реальная отправка (браузер)
  await doRealLaunch(context, config, plan);
  return plan;
}

/**
 * Реальная отправка экспедиции через браузер.
 * Этап 1: fleet.php?cp=<moon> → форма floten1 (корабли + moreFL) → "Далее"
 * Этап 2: страница выбора цели (координаты + тип миссии = Экспедиция) → подтверждение
 *
 * ВНИМАНИЕ: многошаговый flow, структура страницы цели может отличаться.
 * Функция best-effort: логит каждый шаг, не бросает исключение на неудачу.
 */
async function doRealLaunch(context, config, plan) {
  const page = await context.newPage();
  try {
    await blockResources(page);

    const shipId = plan.shipId;
    if (!shipId) {
      console.error(
        `❌ [expedition] Неизвестный shipId для "${plan.shipName}" — добавьте в config.shipIds.`,
      );
      return;
    }

    const rawRequested =
      plan.shipCount === "all" || plan.shipCount === "ALL"
        ? Number.MAX_SAFE_INTEGER
        : Number(plan.shipCount) || 0;
    const available = Number(plan.availableShips || 0);
    const requestedCount =
      Number.isFinite(available) && available > 0
        ? Math.min(rawRequested, available)
        : rawRequested;

    const targetParts = String(plan.target || "")
      .split(":")
      .map((n) => Number(n));
    const targetMission = Number(config.expedition.targetMission || 15);
    const targetCoords =
      targetParts.length === 3 && targetParts.every(Number.isFinite)
        ? {
            galaxy: targetParts[0],
            system: targetParts[1],
            planet: targetParts[2],
            planettype: 1,
          }
        : null;

    const finalTarget =
      targetCoords ||
      (() => {
        const alt = String(config.expedition.targets?.[0] || "1:363:6")
          .split(":")
          .map((n) => Number(n));
        return alt.length === 3
          ? {
              galaxy: alt[0],
              system: alt[1],
              planet: alt[2],
              planettype: 1,
            }
          : { galaxy: 1, system: 363, planet: 6, planettype: 1 };
      })();

    console.log(
      `🚀 [expedition] Реальный запуск через mission-sender: target=${finalTarget.galaxy}:${finalTarget.system}:${finalTarget.planet} mission=${targetMission} ship${shipId}=${requestedCount}`,
    );

    const result = await sendMission(context, {
      fromCp: plan.fromMoonCp,
      target: finalTarget,
      mission: targetMission,
      ships: { [shipId]: requestedCount },
      page,
      moreFL: 0,
      dryRun: false,
    });

    console.log(
      `📌 [expedition] Результат реальной отправки: ${JSON.stringify({ ok: result.ok, stage: result.stage, error: result.error, confirmed: result.confirmed })}`,
    );
  } catch (err) {
    console.error(`❌ [expedition] Ошибка реальной отправки:`, err.message);
  } finally {
    await page.close();
  }
}

module.exports = { launchExpeditions, getExpeditionPlan };

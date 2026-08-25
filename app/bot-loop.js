/**
 * bot-loop.js — главный цикл бота.
 *
 * Каждый pollIntervalMs:
 *   1. collectMissions — сбор/хранение/анализ миссий (read-only)
 *   2. runSafetyCheck — безопасность флота (приоритет №1)
 *   3. runFarmCycle — автофарм (если сейв не занял слоты)
 *   4. runExpedition — автоэкспедиции (если есть свободные слоты)
 *
 * SESSION_EXPIRED → re-login и продолжение.
 */

const { collectMissions, isMainMoonUnderAttack } = require("./missions");
const { runSafetyCheck } = require("./fleet-safety");
const { runFarmCycle } = require("./farm");
const { launchExpeditions } = require("./expedition");
const { delay, randomizeMs } = require("./helpers/async");
const { loadBotControls } = require("./helpers/config");
const dataStore = require("./data-store");

/**
 * Один итерация цикла.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 * @returns {Promise<Object>} отчёт итерации
 */
async function botTick(context, config) {
  const tick = {
    ts: new Date().toISOString(),
    missions: null,
    safety: null,
    farm: null,
    expedition: null,
  };

  const controls = loadBotControls();
  config.farm = { ...(config.farm || {}), enabled: !!controls.farm };
  config.expedition = {
    ...(config.expedition || {}),
    enabled: !!controls.expedition,
    shipCount:
      Number.isFinite(Number(controls.expeditionShipCount)) &&
      Number(controls.expeditionShipCount) > 0
        ? Number(controls.expeditionShipCount)
        : (config.expedition?.shipCount ?? 500000000000),
  };
  config.safety = { ...(config.safety || {}), enabled: !!controls.safety };

  console.log(
    `🔘 [loop] флаги: farm=${!!controls.farm ? "ON" : "OFF"}, expedition=${!!controls.expedition ? "ON" : "OFF"}, safety=${!!controls.safety ? "ON" : "OFF"}`,
  );

  // 1. Миссии (всегда)
  const missionsData = await collectMissions(context, config);
  tick.missions = {
    total: missionsData.missions.length,
    byType: missionsData.analysis.byType,
    incomingAttacks: missionsData.attacks.incoming.length,
    mainMoonAttacks: (missionsData.mainMoonIncoming || []).length,
  };

  // 2. Сейв (приоритет)
  const safetyCfg = config.safety || {};
  if (safetyCfg.enabled) {
    console.log("🔒 [loop] safety: включён → запускаем runSafetyCheck");
    tick.safety = await runSafetyCheck(context, config, missionsData);
  } else {
    console.log("🔒 [loop] safety: выключен → пропускаем runSafetyCheck");
  }

  // 3. Фарм (только если главную луну не атакуют)
  const farmCfg = config.farm || {};
  const mainMoonUnderAttack = isMainMoonUnderAttack(missionsData, config);
  if (farmCfg.enabled && !mainMoonUnderAttack) {
    console.log("🌾 [loop] farm: включён → запускаем runFarmCycle");
    tick.farm = await runFarmCycle(context, config, missionsData);
  } else if (farmCfg.enabled && mainMoonUnderAttack) {
    console.log(
      "🌾 [loop] farm: включён, но пропускаем из-за атаки на главную луну",
    );
    tick.farm = { skipped: "атака на главную луну — приоритет сейва" };
  } else {
    console.log("🌾 [loop] farm: выключен → пропускаем runFarmCycle");
  }

  // 4. Экспедиции
  const expCfg = config.expedition || {};
  if (expCfg.enabled) {
    console.log("🚀 [loop] expedition: включён → запускаем launchExpeditions");
    tick.expedition = await launchExpeditions(context, config);
  } else {
    console.log(
      "🚀 [loop] expedition: выключен → пропускаем launchExpeditions",
    );
  }

  // логируем в state
  const state = dataStore.load();
  state.last_tick = tick;
  dataStore.save(state);

  return tick;
}

/**
 * Бесконечный цикл.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 * @param {Object} opts — { onTick, stop: () => bool }
 */
async function botLoop(context, config, opts = {}) {
  const baseInterval = config.pollIntervalMs || 90000;
  const interval = randomizeMs(baseInterval, 0.1);
  console.log(
    `🤖 Бот запущен. Интервал: ${Math.round(baseInterval / 1000)}с (±10%)`,
  );

  while (!(opts.stop && opts.stop())) {
    const started = Date.now();
    try {
      const tick = await botTick(context, config);
      if (opts.onTick) opts.onTick(tick);
    } catch (e) {
      if (e && e.code === "SESSION_EXPIRED") {
        console.warn("⚠️ Сессия истекла — требуется повторный логин");
        throw e;
      }
      console.error(`❌ Ошибка цикла: ${e.message}`);
    }
    const elapsed = Date.now() - started;
    const nextDelay = Math.max(5000, interval - elapsed);
    await delay(randomizeMs(Math.max(5000, nextDelay), 0.1));
  }
}

module.exports = { botTick, botLoop };

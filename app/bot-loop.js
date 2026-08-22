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

const { collectMissions } = require("./missions");
const { runSafetyCheck } = require("./fleet-safety");
const { runFarmCycle } = require("./farm");
const { launchExpeditions } = require("./expedition");
const dataStore = require("./data-store");

/**
 * Один итерация цикла.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 * @returns {Promise<Object>} отчёт итерации
 */
async function botTick(context, config) {
  const tick = { ts: new Date().toISOString(), missions: null, safety: null, farm: null, expedition: null };

  // 1. Миссии (всегда)
  const missionsData = await collectMissions(context, config);
  tick.missions = {
    total: missionsData.missions.length,
    byType: missionsData.analysis.byType,
    incomingAttacks: missionsData.attacks.incoming.length,
  };

  // 2. Сейв (приоритет)
  const safetyCfg = config.safety || {};
  if (safetyCfg.enabled) {
    tick.safety = await runSafetyCheck(context, config, missionsData);
  }

  // 3. Фарм (только если нет срочного сейва)
  const farmCfg = config.farm || {};
  const hasUrgentAttack =
    (tick.safety && tick.safety.incoming > 0) ||
    missionsData.attacks.incoming.length > 0;
  if (farmCfg.enabled && !hasUrgentAttack) {
    tick.farm = await runFarmCycle(context, config, missionsData);
  } else if (farmCfg.enabled && hasUrgentAttack) {
    tick.farm = { skipped: "есть входящие атаки — приоритет сейва" };
  }

  // 4. Экспедиции
  const expCfg = config.expedition || {};
  if (expCfg.enabled) {
    tick.expedition = await launchExpeditions(context, config);
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
  const interval = config.pollIntervalMs || 60000;
  console.log(`🤖 Бот запущен. Интервал: ${Math.round(interval / 1000)}с`);

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
    await new Promise((r) => setTimeout(r, Math.max(5000, interval - elapsed)));
  }
}

module.exports = { botTick, botLoop };

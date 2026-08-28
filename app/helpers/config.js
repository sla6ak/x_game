/**
 * config.js — загрузка config.json (единая точка доступа).
 *
 * Раньше каждый модуль (serverXG, session-manager, fleet-state)
 * читал config.json самостоятельно.
 */

const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "..", "..", "config.json");
const CONTROLS_FILE = path.join(__dirname, "..", "..", "bot-controls.json");

/**
 * Прочитать и разобрать config.json.
 * @returns {Object} конфиг
 */
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
}

function normalizeInteger(value, fallback, { min = 0, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, Math.round(n)));
  return clamped;
}

function loadBotControls() {
  const defaults = {
    farm: true,
    expedition: true,
    safety: true,
    expeditionShipCount: 500000000000,
    farmReserveSlots: 3,
  };

  try {
    const parsed = JSON.parse(fs.readFileSync(CONTROLS_FILE, "utf-8"));
    const next = { ...defaults, ...parsed };
    const expeditionShipCount = normalizeInteger(
      next.expeditionShipCount,
      defaults.expeditionShipCount,
      { min: 1 },
    );
    next.expeditionShipCount = expeditionShipCount;
    next.farmReserveSlots = normalizeInteger(next.farmReserveSlots, 3, {
      min: 0,
      max: 42,
    });
    return next;
  } catch (e) {
    return defaults;
  }
}

function saveBotControls(controls) {
  const rawExpedition = Number(controls?.expeditionShipCount ?? 500000000000);
  const rawReserve = Number(controls?.farmReserveSlots ?? 3);
  const next = {
    farm: !!controls?.farm,
    expedition: !!controls?.expedition,
    safety: !!controls?.safety,
    expeditionShipCount:
      Number.isFinite(rawExpedition) && rawExpedition > 0
        ? rawExpedition
        : 500000000000,
    farmReserveSlots: normalizeInteger(rawReserve, 3, {
      min: 0,
      max: 42,
    }),
  };
  fs.writeFileSync(
    CONTROLS_FILE,
    JSON.stringify(next, null, 2) + "\n",
    "utf-8",
  );
  return next;
}

module.exports = {
  loadConfig,
  loadBotControls,
  saveBotControls,
  CONFIG_FILE,
  CONTROLS_FILE,
};

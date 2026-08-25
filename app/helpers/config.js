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

function loadBotControls() {
  const defaults = {
    farm: true,
    expedition: true,
    safety: true,
    expeditionShipCount: 500000000000,
  };

  try {
    const parsed = JSON.parse(fs.readFileSync(CONTROLS_FILE, "utf-8"));
    const next = { ...defaults, ...parsed };
    const n = Number(next.expeditionShipCount);
    next.expeditionShipCount =
      Number.isFinite(n) && n > 0 ? n : defaults.expeditionShipCount;
    return next;
  } catch (e) {
    return defaults;
  }
}

function saveBotControls(controls) {
  const raw = Number(controls?.expeditionShipCount ?? 500000000000);
  const next = {
    farm: !!controls?.farm,
    expedition: !!controls?.expedition,
    safety: !!controls?.safety,
    expeditionShipCount: Number.isFinite(raw) && raw > 0 ? raw : 500000000000,
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

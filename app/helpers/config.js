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
  try {
    return JSON.parse(fs.readFileSync(CONTROLS_FILE, "utf-8"));
  } catch (e) {
    return { farm: true, expedition: true, safety: true };
  }
}

function saveBotControls(controls) {
  const next = {
    farm: !!controls?.farm,
    expedition: !!controls?.expedition,
    safety: !!controls?.safety,
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

/**
 * config.js — загрузка config.json (единая точка доступа).
 *
 * Раньше каждый модуль (serverXG, session-manager, fleet-state)
 * читал config.json самостоятельно.
 */

const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "..", "..", "config.json");

/**
 * Прочитать и разобрать config.json.
 * @returns {Object} конфиг
 */
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
}

module.exports = { loadConfig, CONFIG_FILE };

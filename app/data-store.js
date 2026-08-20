const fs = require("fs");
const path = require("path");

// Единый файл состояния бота. Хранит миссии, атаки, корабли по планете/луне.
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "bot-state.json");

function emptyState() {
  return {
    updated_at: null,
    home: null, // { coords, moon_cp, planet_fleet_url }
    ships: { planet: [], moon: [] },
    missions: [],
    attacks: [],
    expedition_slots: null, // { max, current, free }
    last_expeditions_sent: null,
  };
}

function load() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return { ...emptyState(), ...JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) };
    } catch (e) {
      console.warn("⚠️ [data] Не удалось прочитать state, начинаем заново:", e.message);
    }
  }
  return emptyState();
}

function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  return state;
}

module.exports = { load, save, DATA_FILE };

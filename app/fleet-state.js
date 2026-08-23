/**
 * fleet-state.js — отслеживание ПЛОЖЕНИЯ ОСНОВНОГО ФЛОТА.
 *
 * Основной флот по умолчанию находится на ГЛАВНОЙ ЛУНЕ (config.moonCp)
 * и только с неё фармит неактивных игроков. При эвакуации (сейве)
 * положение записывается в data/bot-state.json:
 *
 *   state.mainFleet = {
 *     at: "home-moon" | "safe-moon",   // где сейчас основной флот
 *     cp: 31694,                       // cp тела, где флот сейчас
 *     coords: "1:363:6",               // координаты
 *     since: 1712345678901,            // когда изменилось положение
 *     evacuatedFrom: null | { cp, coords } // откуда эвакуирован (или null)
 *   }
 *
 * Пока mainFleet.at !== "home-moon" — фарм не запускается
 * (флот может быть в пути или на безопасной луне).
 */

const fs = require("fs");
const path = require("path");
const dataStore = require("./data-store");

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf-8")
);

/** Положение по умолчанию: главная луна. */
function defaultPosition() {
  const { galaxy, system, planet } = config.home;
  return {
    at: "home-moon",
    cp: config.moonCp,
    coords: `${galaxy}:${system}:${planet}`,
    since: null,
    evacuatedFrom: null,
  };
}

/** Текущее положение основного флота (создаёт дефолт, если нет). */
function getMainFleet() {
  const state = dataStore.load();
  if (!state.mainFleet) {
    state.mainFleet = defaultPosition();
    dataStore.save(state);
  }
  return state.mainFleet;
}

/**
 * Записать новое положение основного флота.
 * @param {number} cp — cp тела, где флот
 * @param {string} coords — координаты
 * @param {Object|null} [evacuatedFrom] — { cp, coords } откуда эвакуирован
 */
function setMainFleet(cp, coords, evacuatedFrom = null) {
  const state = dataStore.load();
  state.mainFleet = {
    at: evacuatedFrom ? "safe-moon" : "home-moon",
    cp,
    coords,
    since: Date.now(),
    evacuatedFrom,
  };
  dataStore.save(state);
  console.log(
    `📍 [fleet] Основной флот: ${coords} (cp=${cp})` +
      (evacuatedFrom ? ` — эвакуирован с ${evacuatedFrom.coords}` : ""),
  );
  return state.mainFleet;
}

/** Флот на главной луне? */
function isAtHomeMoon() {
  return getMainFleet().at === "home-moon";
}

module.exports = { getMainFleet, setMainFleet, isAtHomeMoon, defaultPosition };

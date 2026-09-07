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

// Типы кораблей, доступные для выбора (bot-controls)
const FARM_SHIP_NAMES = ["Линкор", "Авианосец", "Большой танкер"];
const EXPEDITION_SHIP_NAMES = [
  "Линкор",
  "Броненосец",
  "Эсминец",
  "Авианосец",
  "Крейсер",
  "Линейный крейсер",
];

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

/**
 * Нормализация списка кораблей экспедиции: [{ name, count }].
 * Отбрасывает невалидные записи (неизвестный тип, count <= 0) и дубликаты
 * типов (берётся первая запись).
 * @param {*} value
 * @returns {Array<{name: string, count: number}>}
 */
function normalizeExpeditionShips(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const name = String(item?.name || "");
    const count = Number(item?.count);
    if (!EXPEDITION_SHIP_NAMES.includes(name)) continue;
    if (!Number.isFinite(count) || count <= 0) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, count: Math.round(count) });
  }
  return out;
}

function loadBotControls() {
  const defaults = {
    farm: true,
    expedition: true,
    safety: true,
    farmReserveSlots: 3,
    farmShipName: "Линкор",
    expeditionShips: [{ name: "Линкор", count: 500000000000 }],
  };

  try {
    const parsed = JSON.parse(fs.readFileSync(CONTROLS_FILE, "utf-8"));
    const next = { ...defaults, ...parsed };
    next.farmReserveSlots = normalizeInteger(next.farmReserveSlots, 3, {
      min: 0,
      max: 42,
    });
    if (!FARM_SHIP_NAMES.includes(next.farmShipName)) next.farmShipName = defaults.farmShipName;
    // Типы кораблей — только новый формат expeditionShips: [{name, count}].
    // Смотрим именно в parsed (не в next): дефолтный expeditionShips из
    // defaults не должен маскировать отсутствие поля в старом файле.
    let expeditionShips = normalizeExpeditionShips(parsed.expeditionShips);
    if (!expeditionShips.length) {
      // Старый файл без expeditionShips — одноразовая миграция из
      // legacy-полей expeditionShipName + expeditionShipCount.
      const name = EXPEDITION_SHIP_NAMES.includes(parsed.expeditionShipName)
        ? parsed.expeditionShipName
        : defaults.expeditionShips[0].name;
      const count = Number(parsed.expeditionShipCount);
      expeditionShips =
        Number.isFinite(count) && count > 0
          ? [{ name, count: Math.round(count) }]
          : defaults.expeditionShips;
    }
    next.expeditionShips = expeditionShips;
    // legacy-поля больше не используются — не возвращаем их наружу
    delete next.expeditionShipName;
    delete next.expeditionShipCount;
    return next;
  } catch (e) {
    return defaults;
  }
}

function saveBotControls(controls) {
  const rawReserve = Number(controls?.farmReserveSlots ?? 3);
  // Новый формат: expeditionShips: [{name, count}]. Если пришёл только
  // legacy-вид (expeditionShipName/Count) — конвертируем в список.
  let expeditionShips = normalizeExpeditionShips(controls?.expeditionShips);
  if (!expeditionShips.length) {
    // legacy-поля из POST (обратная совместимость со старой страницей)
    const name = EXPEDITION_SHIP_NAMES.includes(controls?.expeditionShipName)
      ? controls.expeditionShipName
      : null;
    const count = Number(controls?.expeditionShipCount);
    if (name && Number.isFinite(count) && count > 0) {
      expeditionShips = [{ name, count: Math.round(count) }];
    } else {
      // Пустой список (все строки убрали) — сохраняем предыдущий из файла,
      // чтобы не сбрасывать настройку молча.
      const prev = normalizeExpeditionShips(loadBotControls().expeditionShips);
      expeditionShips = prev.length
        ? prev
        : [{ name: "Линкор", count: 500000000000 }];
    }
  }
  const next = {
    farm: !!controls?.farm,
    expedition: !!controls?.expedition,
    safety: !!controls?.safety,
    expeditionShips,
    farmReserveSlots: normalizeInteger(rawReserve, 3, {
      min: 0,
      max: 42,
    }),
    farmShipName: FARM_SHIP_NAMES.includes(controls?.farmShipName)
      ? controls.farmShipName
      : "Линкор",
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
  normalizeExpeditionShips,
  FARM_SHIP_NAMES,
  EXPEDITION_SHIP_NAMES,
  CONFIG_FILE,
  CONTROLS_FILE,
};

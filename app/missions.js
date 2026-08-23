/**
 * missions.js — ЗАДАЧА 1: собирать, хранить и анализировать информацию всех
 * миссий на странице overview.php.
 *
 * collectMissions(context, config):
 *   1. Запрашивает raw-HTML overview.php
 *   2. Парсит: home, миссии (исходящие/возвращающиеся), атаки, тела (планеты/луны)
 *   3. Хранит в data-store (bot-state.json)
 *   4. Возвращает анализ: слоты, типы миссий, входящие атаки, свободные луны
 *
 * Это read-only операция — ничего не отправляет.
 */

const { fetchHtml } = require("./http");
const { parseMissions, parseAttacks } = require("./parsers/overview");
const { parseBodies, safeMoons } = require("./bodies");
const { normalizeCoords } = require("./helpers/coords");
const dataStore = require("./data-store");

/** Координаты главной планеты/луны из config. */
function getHomeCoords(config) {
  return `${config.home.galaxy}:${config.home.system}:${config.home.planet}`;
}

/**
 * Входящие атаки на главную луну (PLAN: реагируем только на них).
 * @param {Array} incoming — parseAttacks(...).incoming
 * @param {Object} config
 * @returns {Array}
 */
function filterMainMoonIncoming(incoming, config) {
  const home = normalizeCoords(getHomeCoords(config));
  return (incoming || []).filter((a) => {
    if (!a.coords || normalizeCoords(a.coords) !== home) return false;
    // атака на планету с теми же coords — игнорируем (нужна луна)
    if (a.isMoon === false) return false;
    return true;
  });
}

/** Есть ли срочная атака на главную луну (для блокировки фарма). */
function isMainMoonUnderAttack(missionsData, config) {
  const incoming =
    missionsData.mainMoonIncoming ||
    filterMainMoonIncoming(missionsData.attacks?.incoming || [], config);
  return incoming.length > 0;
}

/**
 * Классификация типа миссии по её тексту/типу.
 * @returns {'expedition'|'attack'|'transport'|'farm'|'spy'|'return'|'unknown'}
 */
function classifyMission(mission) {
  const t = (mission.type || "") + " " + (mission.text || "");
  if (/экспедиц/i.test(t)) return "expedition";
  if (/атак/i.test(t) && !/возвращ/i.test(t)) return "attack";
  if (/шпион|разведк/i.test(t)) return "spy";
  if (/фарм|ишкофарм|искать/i.test(t)) return "farm";
  if (/транспорт|оставить|доставк/i.test(t)) return "transport";
  if (mission.is_returning || /возвращ/i.test(t)) return "return";
  return "unknown";
}

/**
 * Анализ набора миссий.
 * @returns {Object} сводка
 */
function analyzeMissions(missions) {
  const byType = {};
  let outgoing = 0;
  let returning = 0;
  for (const m of missions) {
    const type = classifyMission(m);
    byType[type] = (byType[type] || 0) + 1;
    if (m.is_returning) returning++;
    else outgoing++;
  }
  return {
    total: missions.length,
    outgoing,
    returning,
    byType,
    // Занятые слоты = только исходящие миссии (возвращающиеся не занимают слот отправки)
    activeSlots: outgoing,
  };
}

/**
 * Собрать, сохранить и проанализировать все миссии.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config — config.json
 * @returns {Promise<Object>} { home, missions, analysis, attacks, bodies, safeMoons }
 */
async function collectMissions(context, config) {
  const homeCoords = `${config.home.galaxy}:${config.home.system}:${config.home.planet}`;
  const html = await fetchHtml(context, "/overview.php");

  const missions = parseMissions(html);
  const attacks = parseAttacks(html, missions, config.attackKeywords || []);
  const bodies = parseBodies(html, {
    homeCoords,
    homeMoonCp: config.moonCp,
  });
  const analysis = analyzeMissions(missions);
  const mainMoonIncoming = filterMainMoonIncoming(attacks.incoming, config);

  // Координаты под вражеской атакой (любые наши тела)
  const attackedCoords = attacks.incoming.map((a) => a.coords).filter(Boolean);

  // Храним в data-store
  const state = dataStore.load();
  state.home = {
    coords: homeCoords,
    planet_cp: config.planetCp,
    moon_cp: config.moonCp,
  };
  state.missions = missions.map((m) => ({
    ...m,
    classified: classifyMission(m),
  }));
  state.attacks = attacks;
  state.bodies = bodies;
  state.analysis = analysis;
  state.expedition_slots = analysis.byType.expedition
    ? { active: analysis.byType.expedition }
    : null;
  dataStore.save(state);

  return {
    home: state.home,
    missions,
    analysis,
    attacks,
    mainMoonIncoming,
    bodies,
    safeMoons: safeMoons(bodies, attackedCoords, { excludeHome: homeCoords }),
    _html: html,
  };
}

module.exports = {
  collectMissions,
  analyzeMissions,
  classifyMission,
  getHomeCoords,
  filterMainMoonIncoming,
  isMainMoonUnderAttack,
};

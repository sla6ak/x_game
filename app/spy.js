/**
 * spy.js — отправка шпионских зондов на цели (неактивные игроки).
 *
 * Переиспользуемая функция: spyTargets(context, config, targets, opts).
 * Цели: [{ coords: "g:s:p", planet, player, status, ... }] (из parse-galaxy).
 *
 * Дедупликация: цели, на которые уже летит/летел шпионаж (state.spy_sent),
 * пропускаются, если не прошло spyCooldownMs.
 */

const { sendMission } = require("./mission-sender");
const dataStore = require("./data-store");

/**
 * Отправить шпионаж на список целей.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config — config.json
 * @param {Array} targets — цели { coords, planet, player }
 * @param {Object} opts — { probes: число зондов, dryRun: bool }
 * @returns {Promise<Object>} { sent: [], skipped: [], failed: [] }
 */
async function spyTargets(context, config, targets, opts = {}) {
  const probes = opts.probes || (config.farm && config.farm.probeCount) || 5000;
  const dryRun = opts.dryRun != null ? opts.dryRun : (config.farm && config.farm.dryRun) !== false;
  const cooldownMs = (config.farm && config.farm.spyCooldownMs) || 6 * 3600 * 1000;
  const now = Date.now();

  const state = dataStore.load();
  state.spy_sent = state.spy_sent || {};

  const sent = [];
  const skipped = [];
  const failed = [];

  for (const t of targets) {
    const last = state.spy_sent[t.coords];
    if (last && now - last < cooldownMs) {
      skipped.push({ coords: t.coords, reason: "cooldown" });
      continue;
    }

    const res = await sendMission(context, {
      fromCp: config.farm ? config.farm.fromMoonCp : null,
      target: {
        galaxy: t.galaxy != null ? t.galaxy : config.home.galaxy,
        system: t.system,
        planet: t.planet,
        planettype: "1",
      },
      mission: 6, // Шпионаж
      ships: { 210: probes },
      dryRun,
    });

    if (res.ok) {
      state.spy_sent[t.coords] = now;
      sent.push({ coords: t.coords, player: t.player, dryRun });
      console.log(`🕵️ [spy] Шпионаж → ${t.coords} (${t.player || "?"}) [${dryRun ? "dry-run" : "sent"}]`);
    } else {
      failed.push({ coords: t.coords, error: res.error, stage: res.stage });
      console.warn(`❌ [spy] Шпионаж → ${t.coords} не удался (стадия ${res.stage}): ${res.error}`);
    }
    // пауза между отправками (анти-спам)
    await new Promise((r) => setTimeout(r, 1500));
  }

  dataStore.save(state);
  return { sent, skipped, failed };
}

module.exports = { spyTargets };

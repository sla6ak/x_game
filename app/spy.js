/**
 * spy.js — отправка шпионских зондов на цели (неактивные игроки).
 *
 * Переиспользуемая функция: spyTargets(context, config, targets, opts).
 * Цели: [{ coords: "g:s:p", planet, player, status, ... }] (из parsers/galaxy).
 *
 * Дедупликация: цели, на которые уже летит/летел шпионаж (state.spy_sent),
 * пропускаются, если не прошло spyCooldownMs.
 */

const { sendMission } = require("./mission-sender");
const { delay } = require("./helpers/async");
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
  const sentAt = {}; // coords -> ts, только реальные отправки (dry-run не пишет)

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
        // findInactiveTargets отдаёт номер планеты в поле pos (и planet, если задано)
        planet: t.planet != null ? t.planet : t.pos,
        planettype: "1",
      },
      mission: 6, // Шпионаж
      ships: { 210: probes },
      dryRun,
    });

    if (res.ok) {
      if (!dryRun) sentAt[t.coords] = now; // dry-run не пачкает кулдаун
      sent.push({ coords: t.coords, player: t.player, dryRun });
      console.log(`🕵️ [spy] Шпионаж → ${t.coords} (${t.player || "?"}) [${dryRun ? "dry-run" : "sent"}]`);
    } else {
      failed.push({ coords: t.coords, error: res.error, stage: res.stage });
      console.warn(`❌ [spy] Шпионаж → ${t.coords} не удался (стадия ${res.stage}): ${res.error}`);
    }
    // пауза между отправками (анти-спам)
    await delay(1500);
  }

  // Сохраняем кулдауны: ПЕРЕЗАГРУЖАЕМ state, чтобы не затереть изменения
  // других модулей (и наоборот — чтобы spy_sent не терялся при последующих
  // save). Dry-run ничего не записывает.
  if (Object.keys(sentAt).length) {
    const fresh = dataStore.load();
    fresh.spy_sent = { ...(fresh.spy_sent || {}), ...sentAt };
    dataStore.save(fresh);
  }
  return { sent, skipped, failed };
}

module.exports = { spyTargets };

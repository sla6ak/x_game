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

function parseSpySentMeta(value) {
  if (value == null) return { ts: 0, permanent: false };
  if (typeof value === "object") {
    return {
      ts: Number(value.ts ?? value.at ?? 0) || 0,
      permanent: !!value.permanent,
    };
  }
  const ts = Number(value) || 0;
  return { ts, permanent: false };
}

function shouldStopRetryingSpyError(error = "") {
  const msg = String(error || "").toLowerCase();
  return (
    msg.includes("нельзя выполнить данное действие") ||
    msg.includes("в режиме отпуска") ||
    msg.includes("в отпуске") ||
    msg.includes("неактив") ||
    msg.includes("не участвует") ||
    msg.includes("не найден") ||
    msg.includes("не существует")
  );
}

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
  const dryRun =
    opts.dryRun != null
      ? opts.dryRun
      : (config.farm && config.farm.dryRun) !== false;
  const ignoreCooldown = !!opts.ignoreCooldown;
  const cooldownMs = (config.farm && config.farm.spyCooldownMs) || 60 * 1000;
  const now = Date.now();

  const state = dataStore.load();
  state.spy_sent = state.spy_sent || {};

  const sent = [];
  const skipped = [];
  const failed = [];
  const sentAt = {}; // coords -> ts, только реальные отправки (dry-run не пишет)

  for (const t of targets) {
    const status = String(t.status || "").toLowerCase();
    if (["vacation", "banned"].includes(status)) {
      skipped.push({ coords: t.coords, reason: `status:${status}` });
      continue;
    }

    const last = state.spy_sent[t.coords];
    const lastMeta = parseSpySentMeta(last);
    if (lastMeta.permanent) {
      skipped.push({ coords: t.coords, reason: "permanent-invalid" });
      continue;
    }
    if (!ignoreCooldown && lastMeta.ts && now - lastMeta.ts < cooldownMs) {
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
      console.log(
        `🕵️ [spy] Шпионаж → ${t.coords} (${t.player || "?"}) [${dryRun ? "dry-run" : "sent"}]`,
      );
    } else {
      const permanent = shouldStopRetryingSpyError(res.error);
      if (!dryRun) {
        const fresh = dataStore.load();
        fresh.spy_sent = { ...(fresh.spy_sent || {}) };
        fresh.spy_sent[t.coords] = permanent
          ? { ts: now, permanent: true }
          : now;
        dataStore.save(fresh);
      }
      failed.push({
        coords: t.coords,
        error: res.error,
        stage: res.stage,
        permanent,
      });
      console.warn(
        `❌ [spy] Шпионаж → ${t.coords} не удался (стадия ${res.stage}): ${res.error}${permanent ? " [запомнено как обработанное]" : ""}`,
      );
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

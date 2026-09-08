/**
 * test-evac-fix.js — проверка нового кода mission-sender (maxAll + коррекция).
 *
 * Безопасный live-тест: 10 линкоров (из 157 млрд) → луна 1:918:1, mission=4,
 * maxAll + keepUranium. Ожидаем:
 *   попытка 1: оценка по форме (15300) → сервер «Недостаточно места: ~99»
 *   попытка 2: точная вместимость (15200) → УСПЕХ
 * Возврат флота — скриптом return-test-fleet.js.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { sendMission } = require("../app/mission-sender");
const { loadConfig } = require("../app/helpers/config");

const config = loadConfig();
const SESSION_FILE = path.join(__dirname, "..", "session.json");
const TARGET = { galaxy: 1, system: 918, planet: 1, planettype: "3" };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8")));

  console.log("=== sendMission maxAll (10 линкоров → 1:918:1) ===");
  const t0 = Date.now();
  const res = await sendMission(context, {
    fromCp: config.moonCp,
    target: TARGET,
    mission: 4,
    ships: { 207: 10 },
    speedPercent: 10,
    resources: { maxAll: true, keepUranium: 100000000000000 },
  });
  console.log(`\nрезультат (${((Date.now() - t0) / 1000).toFixed(1)}с):`, JSON.stringify(res, null, 2));
  if (!res.ok) {
    console.log("❌ Тест провален — флот не отправлен");
    process.exitCode = 1;
  } else {
    console.log("✅ Флот отправлен");
  }
  await browser.close();
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });

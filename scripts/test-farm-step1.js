/**
 * test-farm-step1.js — офлайн-тест ШАГА 1 автофарма (app/farm.js).
 *
 * Проверяет логику без браузера:
 *   - условие по резерву миссий (farmReserveSlots из bot-controls.json);
 *   - парсинг галактики (реальный снапшот debug/galaxy/galaxy-363-live.html);
 *   - выбор ПЕРВОГО неактивного игрока (без отпуска), исключая наши тела;
 *   - вызов spyTargets строго с одной целью.
 *
 * spyTargets подменяется заглушкой (реальный в dry-run всё равно открывает
 * браузер). Запуск: node scripts/test-farm-step1.js
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SNAPSHOT = path.join(ROOT, "debug", "galaxy", "galaxy-363-live.html");

// --- Пatches ДО загрузки farm.js (он деструктурирует spyTargets при require) ---
const spyModule = require(path.join(ROOT, "app", "spy"));
const spyCalls = [];
spyModule.spyTargets = async (context, config, targets, opts) => {
  spyCalls.push({ targets, opts });
  return {
    sent: targets.map((t) => ({ coords: t.coords, player: t.player, dryRun: true })),
    skipped: [],
    failed: [],
  };
};

const { runFarmCycle } = require(path.join(ROOT, "app", "farm"));
const { loadConfig } = require(path.join(ROOT, "app", "helpers", "config"));

// --- Мок контекста: context.request.get(url) → HTML ---
function mockContext(htmlByMatch) {
  return {
    request: {
      get: async (url) => {
        for (const [match, html] of htmlByMatch) {
          if (url.includes(match)) {
            return { status: () => 200, text: async () => html };
          }
        }
        throw new Error(`Mock: неожиданный URL ${url}`);
      },
    },
  };
}

// Минимальный HTML галактики: одна планета с АКТИВНЫМ игроком (strong)
const ALL_ACTIVE_HTML = `
<html><body>
<input name="galaxy" value="1"><input name="system" value="363">
<a alt="Позиция: 1">
  <span alt="Название планеты: P1"></span>
  <a alt="Игрок: ActiveGuy"><span class="strong">ActiveGuy</span></a>
</a>
</body></html>`;

const galaxyHtml = fs.readFileSync(SNAPSHOT, "utf-8");
const config = loadConfig();
config.farm = { ...config.farm, dryRun: true };

const missionsData = (activeSlots) => ({
  analysis: { activeSlots },
  bodies: [{ coords: "1:363:6" }],
});

let passed = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    console.error(`  ❌ ${name} ${extra}`);
    process.exitCode = 1;
  }
}

(async () => {
  // --- Тест 1: farm выключен → пропуск ---
  console.log("\nТест 1: farm disabled");
  spyCalls.length = 0;
  let r = await runFarmCycle(mockContext([]), { ...config, farm: { ...config.farm, enabled: false } }, missionsData(4));
  ok("skipped=farm disabled", r.skipped === "farm disabled", JSON.stringify(r));
  ok("spy не вызывался", spyCalls.length === 0);

  // --- Тест 2: не хватает миссий (занято >= 25) → пропуск ---
  console.log("\nТест 2: не хватает свободных миссий");
  spyCalls.length = 0;
  r = await runFarmCycle(mockContext([]), config, missionsData(25));
  ok("skipped=not enough free slots", r.skipped === "not enough free slots", JSON.stringify(r));
  ok("spy не вызывался", spyCalls.length === 0);

  r = await runFarmCycle(mockContext([]), config, missionsData(40));
  ok("занято 40 → тоже пропуск", r.skipped === "not enough free slots", JSON.stringify(r));

  // --- Тест 3: есть свободная миссия → шпион на ПЕРВОГО неактивного ---
  console.log("\nТест 3: полная цепочка (занято 4 из 25)");
  spyCalls.length = 0;
  const ctx = mockContext([["galaxy.php?mode=0", galaxyHtml]]);
  r = await runFarmCycle(ctx, config, missionsData(4));
  ok("не пропуск", !r.skipped, JSON.stringify(r));
  ok("система 1:363", r.system === "1:363", JSON.stringify(r));
  ok("цель = 1:363:3 (первый неактивный в снапшоте)", r.target && r.target.coords === "1:363:3", JSON.stringify(r.target));
  ok("spy вызван 1 раз", spyCalls.length === 1);
  ok("spy получил ровно одну цель", spyCalls[0] && spyCalls[0].targets.length === 1, JSON.stringify(spyCalls[0] && spyCalls[0].targets));
  const t = spyCalls[0] && spyCalls[0].targets[0];
  ok("цель: planet=3, system=363, galaxy=1", t && t.planet === 3 && t.system === "363" && t.galaxy === "1", JSON.stringify(t));

  // --- Тест 4: наши тела исключаются (1:363:3 наша → цель 1:363:5) ---
  console.log("\nТест 4: исключение наших тел");
  spyCalls.length = 0;
  const md = missionsData(4);
  md.bodies.push({ coords: "1:363:3" });
  r = await runFarmCycle(mockContext([["galaxy.php?mode=0", galaxyHtml]]), config, md);
  ok("цель = 1:363:5 (3-я наша)", r.target && r.target.coords === "1:363:5", JSON.stringify(r.target));

  // --- Тест 5: нет неактивных → пропуск ---
  console.log("\nТест 5: неактивных нет");
  spyCalls.length = 0;
  r = await runFarmCycle(mockContext([["galaxy.php?mode=0", ALL_ACTIVE_HTML]]), config, missionsData(4));
  ok("skipped=no inactive targets", r.skipped === "no inactive targets", JSON.stringify(r));
  ok("spy не вызывался", spyCalls.length === 0);

  console.log(`\nИтог: ${passed} проверок прошло${process.exitCode ? " (ЕСТЬ ОШИБКИ)" : ""}`);
})();

/**
 * test-resources-live.js — live-тест новой ресурс-логики mission-sender.
 * Проходит fleet.php → floten1 → floten2 → floten3 (без submit!),
 * применяет evaluate-логику из mission-sender.js и печатает результат.
 * НИЧЕГО не отправляет: submit floten3 не нажимается.
 */
const fs = require("fs");
const { chromium } = require("playwright");

const BASE = "https://crazy.xgame-online.com";
const SRC_CP = 31694; // главная луна
const KEEP_URANIUM = 100000000000000;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    locale: "ru-RU",
  });
  await context.addCookies(JSON.parse(fs.readFileSync("session.json", "utf-8")));
  const page = await context.newPage();

  // floten1: 1 корабль типа 210, цель 1:331:12 (как в диагностике)
  const q = new URLSearchParams();
  q.set("galaxy", "1");
  q.set("system", "331");
  q.set("planet", "12");
  q.set("planettype", "3");
  q.set("target_mission", "4");
  q.set("210", "1");
  await page.goto(`${BASE}/fleet.php?cp=${SRC_CP}&${q.toString()}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector('form[name="floten1"]', { timeout: 25000 });
  await page.evaluate(() => {
    const el = document.querySelector('form[name="floten1"] input[name="ship210"]');
    if (el) el.value = "1";
  });
  await page.click('form[name="floten1"] [type="submit"], form[name="floten1"] button[type="submit"]');
  await page.waitForSelector('form[name="floten2"]', { timeout: 25000 });
  await page.click('form[name="floten2"] [type="submit"], form[name="floten2"] button[type="submit"]');
  await page.waitForSelector('form[name="floten3"]', { timeout: 25000 });
  console.log("floten3 открыт (без submit). Применяем новую логику...\n");

  // === Та же логика, что в mission-sender.js (стадия 3, maxAll) ===
  const res = await page.evaluate((keep) => {
    const f = document.querySelector('form[name="floten3"]') || document;
    const num = (v) => parseInt(String(v).replace(/\D/g, ""), 10) || 0;
    const getVal = (n) => {
      const el = f.querySelector(`[name="${n}"]`);
      return el ? num(el.value) : 0;
    };
    const avail = {
      resource1: getVal("thisresource1"),
      resource2: getVal("thisresource2"),
      resource3: getVal("thisresource3"),
    };
    const u3 =
      keep > 0 && avail.resource3 >= keep
        ? avail.resource3 - keep
        : keep > 0 && avail.resource3 > 0
          ? Math.floor(avail.resource3 / 2)
          : avail.resource3;
    const want = { resource1: avail.resource1, resource2: avail.resource2, resource3: u3 };
    let capacity = 0;
    let capacityKnown = false;
    for (const el of f.querySelectorAll("input[name^='capacity']")) {
      const shipId = el.name.replace(/^capacity/, "");
      const shipEl = f.querySelector(`input[name="ship${shipId}"]`);
      const count = shipEl ? num(shipEl.value) : 0;
      const per = num(el.value);
      if (count > 0) {
        capacity += count * per;
        capacityKnown = true;
      }
    }
    const totalWant = want.resource1 + want.resource2 + want.resource3;
    const scale =
      capacityKnown && capacity > 0 && totalWant > capacity ? capacity / totalWant : 1;
    const setVal = (n, v) => {
      const el = f.querySelector(`input[name="${n}"]`);
      if (el) el.value = String(Math.floor(v));
    };
    setVal("resource1", want.resource1 * scale);
    setVal("resource2", want.resource2 * scale);
    setVal("resource3", want.resource3 * scale);
    const read = (n) => {
      const el = f.querySelector(`input[name="${n}"]`);
      return el ? num(el.value) : 0;
    };
    return {
      resource1: read("resource1"),
      resource2: read("resource2"),
      resource3: read("resource3"),
      avail,
      capacity: capacityKnown ? capacity : null,
      scaled: scale < 1,
    };
  }, KEEP_URANIUM);

  console.log("Доступно:  металл=" + res.avail.resource1 + " алмазы=" + res.avail.resource2 + " уран=" + res.avail.resource3);
  console.log("Взять:     металл=" + res.resource1 + " алмазы=" + res.resource2 + " уран=" + res.resource3);
  console.log("Вместимость (1 корабль 210): " + res.capacity + ", scaled=" + res.scaled);
  const total = res.resource1 + res.resource2 + res.resource3;
  console.log("ИТОГО ресурсов: " + total + (total > 0 ? " ✓ (флот НЕ пустой)" : " ✗ ПУСТО!"));
  await browser.close();
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});

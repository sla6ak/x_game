/**
 * inspect-floten1.js — структура floten1: что в raw-HTML, что рендерит JS,
 * и как появляются ship-инпуты (тайминг).
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE = "https://crazy.xgame-online.com";
const SESSION_FILE = path.join(__dirname, "..", "session.json");
const SRC_CP = 31749; // 1:331:12*

function strip(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    locale: "ru-RU",
  });
  await context.addCookies(JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8")));
  const page = await context.newPage();

  const q = new URLSearchParams();
  q.set("galaxy", "1");
  q.set("system", "363");
  q.set("planet", "6");
  q.set("planettype", "3");
  q.set("target_mission", "4");
  const t0 = Date.now();
  await page.goto(`${BASE}/fleet.php?cp=${SRC_CP}&${q.toString()}`, { waitUntil: "domcontentloaded" });
  console.log(`domcontentloaded за ${Date.now() - t0} мс`);

  // raw-HTML формы floten1 (сразу)
  const form1raw = await page.evaluate(() => {
    const f = document.querySelector('form[name="floten1"]');
    return f ? f.outerHTML : "form floten1 НЕТ";
  });
  console.log("\n--- floten1 сразу после DOMContentLoaded (input'ы) ---");
  const inputs0 = form1raw.match(/name="(ship\w+|maxship\w+|usedfleet|gRPdPPPPd|moreFL|mission|target_mission)"/g);
  console.log(inputs0 || "нет ship/maxship-полей");

  // ждём появления ship-инпутов (JS-рендер)
  for (const id of ["210", "207", "203"]) {
    const found = await page
      .waitForSelector(`input[name="ship${id}"]`, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    console.log(`ship${id} появился: ${found} (t=${Date.now() - t0} мс)`);
    if (found) break;
  }

  // какие ship-инпуты есть в итоге?
  const shipInputs = await page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('form[name="floten1"] input[name^="ship"], form[name="floten1"] input[name^="maxship"]')) {
      out[el.name] = el.value;
    }
    return out;
  });
  console.log("\n--- ship-инпуты в итоге ---");
  console.log(JSON.stringify(shipInputs, null, 2));

  // JS, который рендерит инпуты: ищем в inline-скриптах
  const scriptInfo = await page.evaluate(() => {
    const out = [];
    for (const s of document.scripts) {
      const src = s.textContent || "";
      if (/ship\d|maxship|floten/i.test(src)) {
        // вырезаем фрагменты вокруг вхождений ship
        const idxs = [...src.matchAll(/maxship|renderShip|shipRow/gi)].map((m) => m.index);
        out.push({
          len: src.length,
          hasShipRender: /ship/i.test(src),
          snippets: idxs.slice(0, 3).map((i) => src.substring(Math.max(0, i - 200), i + 400)),
        });
      }
    }
    return out;
  });
  console.log("\n--- скрипты, связанные с ship-рендером ---");
  console.log(JSON.stringify(scriptInfo, null, 2).slice(0, 4000));

  await browser.close();
})().catch((e) => {
  console.error("ОШИБКА:", e.message);
  process.exit(1);
});

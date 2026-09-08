/**
 * inspect-floten3.js — разовый инспектор стадии 3 (floten3).
 *
 * Идёт по flow: fleet.php?cp=<moonCp>&...&target_mission=4&207=1 → [Далее] →
 * floten2 → [Далее] → floten3. Дампит HTML стадии 3 в debug/forms/floten3-live.html
 * и ВЫХОДИТ БЕЗ отправки (стадия 4 НЕ submit-ится). Флот = 1 линкор — безопасно.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { BASE } = require("../app/http");
const { loadConfig } = require("../app/helpers/config");

const config = loadConfig();
const SESSION_FILE = path.join(__dirname, "..", "session.json");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  if (fs.existsSync(SESSION_FILE)) {
    await context.addCookies(JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8")));
  }
  const page = await context.newPage();

  // --- Стадия 1 ---
  const moonCp = config.moonCp;
  const target = { galaxy: 1, system: 918, planet: 1, planettype: "3" };
  const q = new URLSearchParams({
    galaxy: target.galaxy, system: target.system, planet: target.planet,
    planettype: target.planettype, target_mission: "4", "207": "1",
  });
  const url1 = `${BASE}/fleet.php?cp=${moonCp}&${q.toString()}`;
  console.log("STAGE1 URL:", url1);
  await page.goto(url1, { waitUntil: "domcontentloaded", timeout: 60000 });
  let form1 = await page.waitForSelector('form[name="floten1"]', { timeout: 30000 }).catch(() => null);
  if (!form1) {
    const html = await page.content();
    fs.writeFileSync(path.join(__dirname, "..", "debug", "forms", "floten1-inspect.html"), html);
    console.log("floten1 НЕ найдена. HTML сохранён в debug/forms/floten1-inspect.html");
    console.log("URL теперь:", page.url());
    await browser.close();
    return;
  }
  // заполняем 1 линкор
  await page.evaluate(() => {
    const el = document.querySelector('input[name="ship207"]');
    if (el) el.value = "1";
    const g = document.querySelector('form[name="floten1"] input[name="gRPdPPPPd"]');
    if (g) g.value = "pGereeeer";
  });
  await page.click('form[name="floten1"] [type="submit"], form[name="floten1"] button[type="submit"]');
  const form2 = await page.waitForSelector('form[name="floten2"]', { timeout: 30000 }).catch(() => null);
  if (!form2) {
    const html = await page.content();
    fs.writeFileSync(path.join(__dirname, "..", "debug", "forms", "floten2-inspect.html"), html);
    console.log("floten2 НЕ найдена. HTML сохранён в debug/forms/floten2-inspect.html");
    await browser.close();
    return;
  }
  // --- Стадия 2 → 3 ---
  await page.click('form[name="floten2"] [type="submit"], form[name="floten2"] button[type="submit"]');
  const form3 = await page.waitForSelector('form[name="floten3"]', { timeout: 30000 }).catch(() => null);
  if (!form3) {
    const html = await page.content();
    fs.writeFileSync(path.join(__dirname, "..", "debug", "forms", "floten3-missing.html"), html);
    console.log("floten3 НЕ найдена. HTML сохранён в debug/forms/floten3-missing.html");
    await browser.close();
    return;
  }
  // Дампим ВСЁ: HTML + список JS-функций, связанных с ресурсами
  const info = await page.evaluate(() => {
    const f = document.querySelector('form[name="floten3"]');
    const fields = {};
    for (const el of f.querySelectorAll("input, select")) {
      fields[el.name || el.id || el.tagName] = { type: el.type, value: el.value, title: el.title || null };
    }
    // все кликабельные элементы вокруг ресурсов
    const clickables = [];
    for (const el of document.querySelectorAll("a, button, input[type=button], span[onclick], td[onclick]")) {
      const txt = (el.textContent || "").trim().slice(0, 60);
      if (txt || el.onclick) clickables.push({ tag: el.tagName, text: txt, onclick: el.getAttribute("onclick"), title: el.getAttribute("title") });
    }
    // глобальные JS-функции
    const fns = ["maxResources", "maxResource", "maxAll", "fillMax", "setResources"].filter((n) => typeof window[n] === "function");
    return { fields, clickables: clickables.slice(0, 80), fns, scripts: Array.from(document.scripts).map((s) => s.src).filter(Boolean) };
  });
  const html = await page.content();
  fs.writeFileSync(path.join(__dirname, "..", "debug", "forms", "floten3-live.html"), html);
  fs.writeFileSync(path.join(__dirname, "..", "debug", "forms", "floten3-info.json"), JSON.stringify(info, null, 2));
  console.log("СТАДИЯ 3 сохранена: debug/forms/floten3-live.html + floten3-info.json");
  console.log(JSON.stringify(info, null, 2).slice(0, 4000));
  await browser.close();
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });

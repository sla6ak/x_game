/**
 * inspect-floten3b.js — стадия 3 из ГЛАВНОЙ луны (cp=31694, там флот есть).
 * Тест: 1 зонд (210) → 1:331:12*, «Оставить». Финальную кнопку НЕ жмём.
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE = "https://crazy.xgame-online.com";
const SESSION_FILE = path.join(__dirname, "..", "session.json");
const SRC_CP = 31694; // главная луна 1:363:6*

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
  q.set("system", "331");
  q.set("planet", "12");
  q.set("planettype", "3");
  q.set("target_mission", "4");
  q.set("210", "1");
  await page.goto(`${BASE}/fleet.php?cp=${SRC_CP}&${q.toString()}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('form[name="floten1"]', { timeout: 25000 });

  const filled = await page.evaluate(() => {
    const el = document.querySelector('form[name="floten1"] input[name="ship210"]');
    if (!el) return { ok: false, existing: [...document.querySelectorAll('form[name="floten1"] input')].map((i) => i.name) };
    el.value = "1";
    return { ok: true };
  });
  console.log("ship210 fill:", JSON.stringify(filled));
  if (!filled.ok) {
    console.log("Доступные input'ы floten1:", filled.existing);
    await browser.close();
    return;
  }
  await page.evaluate(() => {
    const el = document.querySelector('form[name="floten1"] input[name="gRPdPPPPd"]');
    if (el) el.value = "pGereeeer";
  });
  await page.click('form[name="floten1"] [type="submit"], form[name="floten1"] button[type="submit"]');
  await page.waitForSelector('form[name="floten2"]', { timeout: 25000 });
  console.log("floten2 OK");
  await page.click('form[name="floten2"] [type="submit"], form[name="floten2"] button[type="submit"]');
  await page.waitForSelector('form[name="floten3"]', { timeout: 25000 });
  console.log("floten3 OK\n");

  const form3Html = await page.evaluate(() => document.querySelector('form[name="floten3"]').outerHTML);
  console.log("--- HTML формы floten3 ---");
  console.log(form3Html);

  console.log("\n--- Текст стадии 3 ---");
  const page3Text = strip(await page.content());
  const resIdx = page3Text.search(/ресурс|металл|уран|алмаз/i);
  console.log(resIdx >= 0 ? page3Text.substring(Math.max(0, resIdx - 400), resIdx + 900) : "текст не найден");

  // Кнопки «Взять все» и их handlers
  const btnInfo = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('input[title="Взять все"], button[title="Взять все"], input[value*="Взять все"], button[value*="Взять все"]')) {
      out.push({
        tag: el.tagName,
        type: el.type || null,
        name: el.name || null,
        value: el.value || null,
        title: el.title || null,
        onclick: el.getAttribute("onclick"),
        onmousedown: el.getAttribute("onmousedown"),
        parentRow: (el.closest("tr") || el.parentElement)?.outerHTML?.substring(0, 600),
      });
    }
    return out;
  });
  console.log("\n--- Кнопки «Взять все» ---");
  console.log(JSON.stringify(btnInfo, null, 2));

  await browser.close();
  console.log("\nГотово. Миссия НЕ отправлена.");
})().catch((e) => {
  console.error("ОШИБКА:", e.message);
  process.exit(1);
});

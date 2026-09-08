/**
 * inspect-pages.js — диагностика страниц (безопасно, без отправки миссий).
 *
 * 1. Raw-HTML fleet.php?cp=<home moon> — есть ли там активные миссии (fleetback_)?
 * 2. Raw-HTML overview.php — где отображается время сервера/иги?
 * 3. Форма floten3 (стадия 3) — структура полей ресурсов и кнопки «Взять все».
 *    Доходим до стадии 3 тестовой миссией (1 зонд, «Оставить» на главную луну)
 *    и НЕ жмём финальную кнопку.
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE = "https://crazy.xgame-online.com";
const SESSION_FILE = path.join(__dirname, "..", "session.json");
const HOME_MOON_CP = 31694; // 1:363:6*
const DEST_MOON_CP = 31749; // 1:331:12* (где сейчас основной флот)

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
  const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
  await context.addCookies(cookies);

  const page = await context.newPage();

  // ---------- 1. Флот главной луны: активные миссии в raw-HTML? ----------
  const fleetHtml = await (await page.goto(`${BASE}/fleet.php?cp=${HOME_MOON_CP}`, { waitUntil: "domcontentloaded" })).text();
  const fleetbackForms = [...fleetHtml.matchAll(/name="fleetback_(\d+)"/g)].map((m) => m[1]);
  console.log("=== 1. fleet.php?cp=" + HOME_MOON_CP + " (главная луна) ===");
  console.log("fleetback_ формы (активные флоты):", fleetbackForms.length ? fleetbackForms : "НЕТ в raw-HTML");
  // строки с миссиями
  const missionRows = strip(fleetHtml).match(/Ваш флот[^.]*\./g);
  console.log("строки 'Ваш флот...':", missionRows ? missionRows.slice(0, 5) : "НЕТ");
  // доступные корабли
  const shipInputs = [...fleetHtml.matchAll(/name="(ship\d+)"[^>]*alt="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
  console.log("ship-инпуты:", shipInputs.length ? shipInputs : "НЕТ (рендерятся JS?)");
  const maxShips = [...fleetHtml.matchAll(/name="(maxship\d+)" value="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
  console.log("maxship-значения:", maxShips.length ? maxShips : "НЕТ");

  // ---------- 2. Overview: время сервера ----------
  const ovHtml = await (await page.goto(`${BASE}/overview.php`, { waitUntil: "domcontentloaded" })).text();
  console.log("\n=== 2. overview.php: маркеры времени ===");
  const timeMarkers = [
    /serverTime[^>]*>([^<]*)/i,
    /id="clock"[^>]*>([^<]*)/i,
    /Время сервера[^<]*<[^>]+>([^<]*)/i,
    /(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:GMT|UTC|МСК)?/g,
 ];
  for (const re of timeMarkers.slice(0, 3)) {
    const m = ovHtml.match(re);
    if (m) console.log("маркер:", re.toString(), "→", m[1]);
  }
  // все вхождения времени HH:MM:SS в raw-HTML (первые 15)
  const times = [...ovHtml.matchAll(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g)].map((m) => m[1]);
  console.log("все HH:MM(:SS) в overview (первые 15):", times.slice(0, 15));
  // контекст вокруг первого времени
  const firstTime = times[0];
  if (firstTime) {
    const idx = ovHtml.indexOf(firstTime);
    console.log("контекст первого времени:", strip(ovHtml.substring(Math.max(0, idx - 300), idx + 300)).slice(0, 400));
  }
  // входящие атаки в overview
  const atkSection = strip(ovHtml);
  const atkIdx = atkSection.indexOf("Чужой флот");
  console.log("секция 'Чужой флот':", atkIdx >= 0 ? atkSection.substring(atkIdx, atkIdx + 500) : "НЕ НАЙДЕНА");

  // ---------- 3. Форма floten3: ресурсы ----------
  console.log("\n=== 3. floten3 (стадия 3) — тестовая миссия из 1:331:12* (cp=31749) ===");
  const q = new URLSearchParams();
  q.set("galaxy", "1");
  q.set("system", "363");
  q.set("planet", "6");
  q.set("planettype", "3");
  q.set("target_mission", "4");
  q.set("210", "1"); // 1 зонд — минимальный тест
  const stage1Url = `${BASE}/fleet.php?cp=${DEST_MOON_CP}&${q.toString()}`;
  await page.goto(stage1Url, { waitUntil: "domcontentloaded" });
  const form1 = await page.waitForSelector('form[name="floten1"]', { timeout: 20000 }).catch(() => null);
  if (!form1) {
    console.log("floten1 НЕ НАЙДЕН. HTML (конец):", strip(await page.content()).slice(-500));
    await browser.close();
    return;
  }
  const dbg = await page.evaluate(() => {
    const f = document.querySelector('form[name="floten1"]');
    const g = (n) => { const el = f.querySelector(`[name="${n}"]`); return el ? el.value : null; };
    return { target: `${g("galaxy")}:${g("system")}:${g("planet")}`, mission: g("target_mission"), ship210: g("ship210") };
  });
  console.log("floten1:", JSON.stringify(dbg));
  await page.evaluate(() => {
    const el = document.querySelector('form[name="floten1"] input[name="gRPdPPPPd"]');
    if (el) el.value = "pGereeeer";
  });
  await page.click('form[name="floten1"] [type="submit"], form[name="floten1"] button[type="submit"]');
  await page.waitForSelector('form[name="floten2"]', { timeout: 20000 }).catch(() => null);
  await page.click('form[name="floten2"] [type="submit"], form[name="floten2"] button[type="submit"]');
  const form3 = await page.waitForSelector('form[name="floten3"]', { timeout: 20000 }).catch(() => null);
  if (!form3) {
    console.log("floten3 НЕ НАЙДЕН. HTML (конец):", strip(await page.content()).slice(-800));
    await browser.close();
    return;
  }
  const form3Html = await page.evaluate(() => document.querySelector('form[name="floten3"]').outerHTML);
  console.log("\n--- HTML формы floten3 (полностью) ---");
  console.log(form3Html);
  console.log("\n--- Текст страницы стадии 3 (вокруг ресурсов) ---");
  const page3Text = strip(await page.content());
  const resIdx = page3Text.search(/ресурс|металл|урани|алмаз/i);
  console.log(resIdx >= 0 ? page3Text.substring(Math.max(0, resIdx - 200), resIdx + 600) : "текст ресурсов не найден");

  // ВАЖНО: НЕ отправляем — закрываем без submit
  await browser.close();
  console.log("\nГотово. Миссия НЕ отправлена.");
})().catch((e) => {
  console.error("ОШИБКА:", e.message);
  process.exit(1);
});

// analyze-run.js
// Временный скрипт для запуска анализа страниц
const { chromium } = require("playwright");
const { ensureLoggedIn } = require("./app/session-manager");
const { analyzePages } = require("./app/analyze-pages");

async function main() {
  console.log("🔍 Запускаем анализ...");

  const browser = await chromium.launch({ headless: false });

  try {
    const ok = await ensureLoggedIn(browser);
    if (!ok) {
      await browser.close();
      process.exit(1);
    }

    await analyzePages(browser);
  } catch (err) {
    console.error("❌ Ошибка:", err.message);
  } finally {
    await browser.close();
  }
}

main();

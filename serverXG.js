const { chromium } = require("playwright");
const { ensureLoggedIn } = require("./app/session-manager");
const { watchMissions } = require("./app/bot-missions");

async function main() {
  console.log("🚀 [server] Запускаем...");

  const browser = await chromium.launch({ headless: false });

  try {
    // ШАГ 1: Проверяем сессию / логинимся
    // Боты не запустятся пока этот шаг не вернёт true
    const ok = await ensureLoggedIn(browser);

    if (!ok) {
      // Авторизация не удалась — останавливаем всё
      await browser.close();
      process.exit(1);
    }

    // ШАГ 2: Сессия есть — запускаем всех ботов параллельно
    // Promise.all() запускает все функции одновременно, не дожидаясь друг друга
    await Promise.all([
      watchMissions(browser),

      // Сюда добавляем новых ботов по мере необходимости:
      // watchResources(browser),
      // autoBuild(browser),
    ]);
  } catch (err) {
    console.error("❌ [server] Критическая ошибка:", err.message);
    await browser.close();
    process.exit(1);
  }
}

main();

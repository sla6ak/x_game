const SESSION_FILE = "./session.json";
const { startExpedition } = require("./expedition");

// Как часто обновлять миссии
const REFRESH_INTERVAL = 30_000; // 30 секунд

async function watchMissions(browser) {
  console.log("📡 [bot-missions] Запускаем слежку за миссиями...");

  const fs = require("fs");
  const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
  const context = await browser.newContext();
  await context.addCookies(cookies);

  const page = await context.newPage();

  // Открываем frames.php один раз
  await page.goto("https://crazy.xgame-online.com/frames.php", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });

  // Функция получения миссий из фрейма overview.php
  async function getMissions() {
    // ждём появления нужного фрейма
    let missionFrame;
    for (let i = 0; i < 10; i++) {
      missionFrame = page
        .frames()
        .find((f) => f.url().includes("overview.php"));
      if (missionFrame) break;
      await new Promise((r) => setTimeout(r, 3000)); // ждём 1 сек
    }

    if (!missionFrame) {
      return ["⚠️ Фрейм overview.php так и не появился"];
    }

    return await missionFrame.evaluate(() => {
      const result = [];
      const allText = document.body.innerText.split("\n");

      allText.forEach((line) => {
        const text = line.trim();
        if (text.includes("флот") && text.includes("Задание")) {
          result.push(text.replace(/\s+/g, " "));
        }
      });

      return result;
    });
  }

  // Функция красивого вывода в терминал
  function printMissions(missions) {
    const now = new Date().toLocaleTimeString("ru-RU");
    console.log(`\n📡 [${now}] Активные миссии (${missions.length}):`);
    console.log("─".repeat(60));

    if (missions.length === 0) {
      console.log("  Миссий не найдено");
    } else {
      missions.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    }

    console.log("─".repeat(60));
  }

  // Первый запрос сразу
  try {
    const missions = await getMissions();
    printMissions(missions);
  } catch (err) {
    console.error("⚠️  [bot-missions] Ошибка первого запроса:", err.message);
  }

  // Затем повторяем каждые REFRESH_INTERVAL миллисекунд
  setInterval(async () => {
    try {
      const missions = await getMissions();
      printMissions(missions);

      // Проверяем только экспедиции
      const expeditions = missions.filter((m) =>
        m.includes("Экспедиция" && "возвращается"),
      );

      if (expeditions.length < 6) {
        // Нет активных экспедиций → запускаем новую
        await startExpedition(page);
      }
    } catch (err) {
      console.error("⚠️  [bot-missions] Ошибка обновления:", err.message);
    }
  }, REFRESH_INTERVAL);

  console.log(
    `🔄 Обновление каждые ${REFRESH_INTERVAL / 1000} сек. Ctrl+C для остановки.`,
  );
}

module.exports = { watchMissions };

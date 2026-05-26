// bot-missions.js
const SESSION_FILE = "./session.json";
const { startExpedition } = require("./expedition");

// Как часто обновлять миссии
const REFRESH_INTERVAL = 30_000; // 30 секунд

// Структура для хранения миссий
let missionsState = []; // [{type, coords, returnTime, status, fleet, moonId}]

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

  // Получение миссий из overview.php с парсингом типа, координат, времени возврата
  async function getMissions() {
    let missionFrame;
    for (let i = 0; i < 10; i++) {
      missionFrame = page
        .frames()
        .find((f) => f.url().includes("overview.php"));
      if (missionFrame) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!missionFrame) return [];

    return await missionFrame.evaluate(() => {
      // Парсим миссии из DOM
      const missions = [];
      document.querySelectorAll(".fleetMission").forEach((el) => {
        // Пример: "Экспедиция (1:910:5) возвращается в 13:45:12"
        const text = el.innerText.trim();
        const typeMatch = text.match(/(Экспедиция|Атака|Транспорт)/);
        const coordsMatch = text.match(/(\d+:\d+:\d+)/);
        const returnMatch = text.match(/возвращается в (\d{2}:\d{2}:\d{2})/);
        missions.push({
          type: typeMatch ? typeMatch[1] : "Неизвестно",
          coords: coordsMatch ? coordsMatch[1] : "",
          returnTime: returnMatch ? returnMatch[1] : "",
          status: text.includes("возвращается") ? "returning" : "active",
          raw: text,
        });
      });
      return missions;
    });
  }

  // Красивый вывод миссий
  function printMissions(missions) {
    const now = new Date().toLocaleTimeString("ru-RU");
    console.log(`\n📡 [${now}] Активные миссии (${missions.length}):`);
    console.log("─".repeat(60));
    if (missions.length === 0) {
      console.log("  Миссий не найдено");
    } else {
      missions.forEach((m, i) =>
        console.log(
          `  ${i + 1}. ${m.type} ${m.coords} ${m.status} возврат: ${m.returnTime}`,
        ),
      );
    }
    console.log("─".repeat(60));
  }

  // Первый запрос сразу
  try {
    const missions = await getMissions();
    missionsState = missions;
    printMissions(missions);
  } catch (err) {
    console.error("⚠️  [bot-missions] Ошибка первого запроса:", err.message);
  }

  // Основной цикл обновления
  setInterval(async () => {
    try {
      const missions = await getMissions();
      missionsState = missions;
      printMissions(missions);

      // Экспедиции, которые возвращаются
      const returningExpeditions = missions.filter(
        (m) => m.type === "Экспедиция" && m.status === "returning",
      );

      // Перезапуск экспедиций по кругу
      for (const exp of returningExpeditions) {
        // Проверяем задержку (1-5 минут после returnTime)
        const now = new Date();
        const [h, m, s] = exp.returnTime.split(":").map(Number);
        const returnDate = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          h,
          m,
          s,
        );
        const diff = now - returnDate;
        if (diff > 60_000 && diff < 300_000) {
          // TODO: перейти на луну exp.coords и запустить экспедицию
          console.log(
            `⏳ Перезапуск экспедиции с луны ${exp.coords} через startExpedition`,
          );
          await startExpedition(page, exp.coords);
        }
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

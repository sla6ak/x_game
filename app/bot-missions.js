// bot-missions.js
const SESSION_FILE = "./session.json";
const CONFIG_FILE = "./config_one.json";
const { startExpedition } = require("./expedition");

// Как часто обновлять миссии
const REFRESH_INTERVAL = 30_000; // 30 секунд

// Структура для хранения миссий
let missionsState = []; // [{type, coords, returnTime, status, fleet, moonId}]
// Список планет и лун игрока
let userPlanets = []; // [{id, coords, isMoon}]

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

  // Получение списка планет из overview.php
  async function updatePlanets() {
    let overviewFrame;
    for (let i = 0; i < 5; i++) {
      overviewFrame = page
        .frames()
        .find((f) => f.url().includes("overview.php"));
      if (overviewFrame) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!overviewFrame) return;

    userPlanets = await overviewFrame.evaluate(() => {
      const planets = [];
      document.querySelectorAll('a[onclick*="switch_planet"]').forEach((el) => {
        const onclick = el.getAttribute("onclick");
        const idMatch = onclick.match(/switch_planet\((\d+)/);
        const id = idMatch ? idMatch[1] : null;
        const parent = el.closest(".ov-pl-wrapper, .curr-planet-wrapper");
        if (!parent) return;
        const coordsEl = parent.querySelector(".ov-location a");
        const coords = coordsEl ? coordsEl.innerText.trim() : "";
        const isMoon =
          el.classList.contains("mini_moon") || el.innerText.includes("Луна");
        if (id && coords) {
          planets.push({ id, coords, isMoon });
        }
      });
      return planets;
    });
    console.log(`🌍 [bot-missions] Обновлено планет: ${userPlanets.length}`);
  }

  async function getMissions() {
    // Используем проверенный в анализе URL
    await page.goto("https://crazy.xgame-online.com/fleet.php?mode=movement", {
      waitUntil: "domcontentloaded",
    });

    return await page.evaluate(() => {
      const missions = [];
      // В этой версии игры флоты в таблицах без четких классов
      document.querySelectorAll("tr").forEach((tr) => {
        const text = tr.innerText.replace(/\s+/g, " ");
        if (text.includes("Экспедиция")) {
          // Ищем координаты типа [1:260:9]
          const coordsMatches = text.match(/(\d+:\d+:\d+)/g);
          // Ищем время типа 16:24:22
          const timeMatch = text.match(/(\d{2}:\d{2}:\d{2})/);

          if (coordsMatches && coordsMatches.length >= 2) {
            // В XGame в строке движения обычно: [Цель] [Источник]
            // Для экспедиции цель всегда заканчивается на :16
            const targetCoords =
              coordsMatches.find((c) => c.endsWith(":16")) || coordsMatches[0];
            const sourceCoords =
              coordsMatches.find((c) => !c.endsWith(":16")) || coordsMatches[1];

            missions.push({
              type: "Экспедиция",
              coords: sourceCoords,
              target: targetCoords,
              returnTime: timeMatch ? timeMatch[1] : "",
              status:
                text.includes("возврат") || text.includes(">")
                  ? "returning"
                  : "active",
              raw: text,
            });
          }
        }
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

  // Сначала собираем инфо о планетах
  try {
    await updatePlanets();
    const missions = await getMissions();
    missionsState = missions;
    printMissions(missions);
  } catch (err) {
    console.error("⚠️  [bot-missions] Ошибка первого запроса:", err.message);
  }

  // Основной цикл обновления
  setInterval(async () => {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      const targetMoons = config.expeditions || [];

      const missions = await getMissions();
      missionsState = missions;
      printMissions(missions);

      for (const moonCoords of targetMoons) {
        // Ищем, летит ли уже что-то с этой луны
        const activeMission = missions.find(
          (m) => m.type === "Экспедиция" && m.coords === moonCoords,
        );

        if (activeMission) {
          if (activeMission.status === "returning") {
            console.log(
              `⏳ Экспедиция с ${moonCoords} возвращается (${activeMission.returnTime})`,
            );
          } else {
            console.log(`✅ Экспедиция с ${moonCoords} уже в полете`);
          }
          continue;
        }

        // Если миссии нет — ищем ID луны и запускаем
        const moon = userPlanets.find(
          (p) => p.coords === moonCoords && p.isMoon,
        );

        if (moon) {
          console.log(
            `🚀 Запуск недостающей экспедиции с луны ${moonCoords} (ID: ${moon.id})`,
          );
          await startExpedition(page, moonCoords, moon.id);
          await updatePlanets(); // Обновим инфо о планетах (там может измениться флот)
          break; // За раз запускаем одну, чтобы не спамить
        } else {
          console.log(
            `⚠️ Луна ${moonCoords} не найдена в списке планет игрока`,
          );
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

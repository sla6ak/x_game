// bot-missions.js
const SESSION_FILE = "./session.json";
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
            // В XGame в строке движения: [Цель] [Источник]
            // Например: [1:260:16] [1:260:9]*
            const sourceCoords = coordsMatches[1];

            missions.push({
              type: "Экспедиция",
              coords: sourceCoords,
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
      const missions = await getMissions();
      missionsState = missions;
      printMissions(missions);

      // Экспедиции, которые возвращаются
      const returningExpeditions = missions.filter(
        (m) => m.type === "Экспедиция" && m.status === "returning",
      );

      // Перезапуск экспедиций по кругу
      for (const exp of returningExpeditions) {
        const moon = userPlanets.find(
          (p) => p.coords === exp.coords && p.isMoon,
        );
        if (!moon) continue;

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

        if (diff > 60_000) {
          console.log(
            `⏳ Перезапуск экспедиции с луны ${exp.coords} (ID: ${moon.id})`,
          );
          await startExpedition(page, exp.coords, moon.id);
          await updatePlanets();
          break;
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

const { startExpedition } = require("./expedition");

async function watchMissions(browser) {
  // Используем первую открытую страницу или создаем новую
  let context = browser.contexts()[0];
  if (!context) {
    context = await browser.newContext();
  }
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  console.log("👀 [bot-missions] Мониторинг миссий запущен...");

  while (true) {
    try {
      // Обновляем страницу для получения свежих данных (или переходим в "Обзор")
      // Если бот уже на нужной странице, можно просто вызывать page.reload()
      await page.reload();

      // 1. Извлекаем информацию о слотах
      const slots = await page.evaluate(() => {
        const text = document.body.innerText;

        // Регулярки под стандартный интерфейс XGame
        // Ищем "Флоты: X / Y" и "Экспедиции: X / Y"
        const fleetMatch = text.match(/Флоты:\s*(\d+)\s*\/\s*(\d+)/i);
        const expMatch = text.match(/Экспедиции:\s*(\d+)\s*\/\s*(\d+)/i);

        return {
          fleet: fleetMatch
            ? { current: fleetMatch[1], max: fleetMatch[2] }
            : { current: "?", max: "?" },
          expeditions: expMatch
            ? { current: expMatch[1], max: expMatch[2] }
            : { current: "?", max: "?" },
        };
      });

      // 2. Логика сбора активных миссий (примерный парсинг таблицы)
      const missions = await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll("tr.return, tr.flight"),
        );
        return rows.map((row) => {
          const text = row.innerText.toLowerCase();
          let type = "unknown";
          if (text.includes("экспедиция")) type = "expedition";
          else if (text.includes("атака")) type = "attack";
          else if (text.includes("транспорт")) type = "transport";

          // Извлечение времени и координат можно добавить здесь
          return { type, text: row.innerText.trim().split("\n")[0] };
        });
      });

      // 3. Информативный вывод в терминал
      console.clear(); // Очищаем консоль для эффекта "дашборда"
      console.log(`--- [ ${new Date().toLocaleTimeString()} ] ---`);
      console.log(
        `🛸 Слоты флота: [${slots.fleet.current} из ${slots.fleet.max}]`,
      );
      console.log(
        `🧪 Экспедиции: [${slots.expeditions.current} из ${slots.expeditions.max}]`,
      );
      console.log(`---------------------------------`);

      if (missions.length === 0) {
        console.log("📭 Активных миссий нет.");
      } else {
        missions.forEach((m, i) => {
          const icon =
            m.type === "expedition" ? "🚀" : m.type === "attack" ? "⚔️" : "📦";
          console.log(`${i + 1}. ${icon} ${m.text}`);
        });
      }

      // 4. Логика перезапуска экспедиций
      if (
        parseInt(slots.expeditions.current) < parseInt(slots.expeditions.max)
      ) {
        console.log(
          "💡 Есть свободный слот для экспедиции! Проверяем возможность отправки...",
        );
        // Тут будет вызов логики из expedition.js
        await startExpedition(browser);
      }
    } catch (err) {
      console.error("❌ [watchMissions] Ошибка:", err.message);
    }

    await new Promise((r) => setTimeout(r, 30000));
  }
}

module.exports = { watchMissions };

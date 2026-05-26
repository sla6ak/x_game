// expedition.js
// Функция для запуска новой экспедиции

async function startExpedition(page) {
  console.log("🛠 [expedition] Получаем список кораблей...");

  await page.goto("https://crazy.xgame-online.com/floten1.php", {
    waitUntil: "networkidle",
    timeout: 20_000,
  });

  // Ждём появления таблицы
  await page.waitForSelector(
    'form[name="flotenI"] table.th-hover.shadow-hover',
    { timeout: 13405 },
  );

  // Дампим HTML формы для отладки
  const htmlDump = await page.evaluate(() => {
    const form = document.querySelector('form[name="flotenI"]');
    return form ? form.innerHTML : "Форма flotenI не найдена";
  });
  console.log("=== HTML дамп формы flotenI ===");
  console.log(htmlDump);

  // Собираем корабли
  const ships = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll('form[name="flotenI"] table tr').forEach((tr) => {
      const link = tr.querySelector("a");
      const input = tr.querySelector('input[name^="ship"]');
      const cells = tr.querySelectorAll("td, th");
      if (link && input && cells.length > 1) {
        result.push({
          type: link.textContent.trim(),
          name: input.name,
          available: cells[1].textContent.trim(),
          current: input.value,
        });
      }
    });
    return result;
  });
  const forms = await page.evaluate(() =>
    Array.from(document.forms).map((f) => ({ name: f.name, action: f.action })),
  );
  console.log("Формы на странице:", forms);

  console.log("=== Список кораблей ===");
  if (ships.length === 0) {
    console.log("⚠️ Корабли не найдены — смотри дамп выше");
  } else {
    ships.forEach((s) => {
      console.log(
        `${s.type} (${s.name}): выбрано=${s.current}, доступно=${s.available}`,
      );
    });
  }

  return ships;
}

module.exports = { startExpedition };

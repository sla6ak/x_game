// expedition.js
// Функция для запуска новой экспедиции с луны по координатам
async function startExpedition(page, coords, moonId) {
  console.log(
    `🛠 [expedition] Запуск экспедиции с луны ${coords} (ID: ${moonId})`,
  );

  // Переходим на fleet.php с конкретной планеты/луны через cp
  const fleetUrl = moonId
    ? `https://crazy.xgame-online.com/fleet.php?cp=${moonId}`
    : "https://crazy.xgame-online.com/fleet.php";

  await page.goto(fleetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });

  // Проверка на ошибку "долго отсутствовали"
  const errorMsg = await page
    .$eval(".errormessage", (el) => el.innerText)
    .catch(() => null);
  if (errorMsg) {
    console.log(`❌ Ошибка на странице: ${errorMsg}`);
    return;
  }

  // Ждём появления формы floten1
  await page.waitForSelector('form[name="flotenI"], form[action*="floten2"]', {
    timeout: 12000,
  });

  // Выбираем все корабли (ищем ссылку "все корабли" или заполняем max)
  await page.evaluate(() => {
    const allShipsLink = Array.from(document.querySelectorAll("a")).find(
      (a) =>
        a.innerText.includes("Все корабли") ||
        a.innerText.includes("всей флотилии"),
    );
    if (allShipsLink) {
      allShipsLink.click();
    } else {
      document.querySelectorAll('input[name^="ship"]').forEach((inp) => {
        const maxInp = document.querySelector(`input[name="max${inp.name}"]`);
        if (maxInp) inp.value = maxInp.value;
      });
    }
  });

  // Нажимаем "Далее" (ищем любой submit в форме flotenI)
  const submitBtn = await page.$(
    'form[name="flotenI"] input[type="submit"], form[action*="floten2"] input[type="submit"]',
  );
  if (submitBtn) {
    await Promise.all([
      page.waitForNavigation({ timeout: 10000 }).catch(() => {}),
      submitBtn.click(),
    ]);
  } else {
    console.log("⚠️ Кнопка [Далее] не найдена, пробуем Enter");
    await page.keyboard.press("Enter");
    await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
  }

  // Ждём floten2.php
  await new Promise((r) => setTimeout(r, 2000));

  // Вводим координаты экспедиции (например, 1:910:16)
  // TODO: вычислять координаты экспедиции по исходной луне
  const targetCoords = coords.replace(/:\d+$/, ":16"); // 1:910:5 -> 1:910:16

  await page.evaluate((target) => {
    const galaxy = target.split(":")[0];
    const system = target.split(":")[1];
    const planet = target.split(":")[2];
    document.querySelector('input[name="galaxy"]').value = galaxy;
    document.querySelector('input[name="system"]').value = system;
    document.querySelector('input[name="planet"]').value = planet;
    // Выбираем тип миссии "Экспедиция"
    const missionSelect = document.querySelector('select[name="mission"]');
    if (missionSelect) {
      missionSelect.value = "15"; // 15 — экспедиция
      missionSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, targetCoords);

  // Нажимаем "Отправить"
  const sendBtn = await page.$('input[type="submit"][value*="Отправить"]');
  if (sendBtn) {
    await sendBtn.click();
    await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
    console.log(`🚀 Экспедиция отправлена на ${targetCoords}`);
  } else {
    console.log("⚠️ Кнопка [Отправить] не найдена");
  }
}

module.exports = { startExpedition };

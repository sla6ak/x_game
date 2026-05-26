// expedition.js
// Функция для запуска новой экспедиции с луны по координатам
async function startExpedition(page, coords) {
  console.log(`🛠 [expedition] Запуск экспедиции с луны ${coords}`);

  // Переходим на fleet.php с нужной луны
  // TODO: получить cp (ID луны) по координатам, пока просто fleet.php
  await page.goto("https://crazy.xgame-online.com/fleet.php", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });

  // Ждём появления формы
  await page.waitForSelector('form[name="flotenI"]', { timeout: 12000 });

  // Выбираем все корабли
  await page.evaluate(() => {
    document.querySelectorAll('input[name^="ship"]').forEach((inp) => {
      const maxInp = document.querySelector(
        'input[name="max' + inp.name + '"]',
      );
      if (maxInp) inp.value = maxInp.value;
    });
  });

  // Нажимаем "Далее"
  const submitBtn = await page.$('input[type="submit"][value*="Далее"]');
  if (submitBtn) {
    await submitBtn.click();
    await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
  } else {
    console.log("⚠️ Кнопка [Далее] не найдена");
    return;
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

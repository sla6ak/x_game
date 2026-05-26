// test-expedition.js
// Тестовый скрипт для анализа процесса отправки экспедиции
const { chromium } = require("playwright");
const { ensureLoggedIn } = require("./app/session-manager");
const fs = require("fs");

const SESSION_FILE = "./session.json";

async function testExpedition() {
  console.log("🚀 Тестируем отправку экспедиции...");

  const browser = await chromium.launch({ headless: false });

  try {
    const ok = await ensureLoggedIn(browser);
    if (!ok) {
      await browser.close();
      process.exit(1);
    }

    const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    const context = await browser.newContext();
    await context.addCookies(cookies);

    const page = await context.newPage();

    // Открываем frames.php
    await page.goto("https://crazy.xgame-online.com/frames.php", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    await new Promise((r) => setTimeout(r, 2000));

    // Получаем список планет/лун из overview
    const overviewFrame = page
      .frames()
      .find((f) => f.url().includes("overview.php"));

    if (overviewFrame) {
      console.log("\n=== Ищем луны с кораблями ===");

      const planets = await overviewFrame.evaluate(() => {
        const result = [];
        // Ищем все элементы с лунами
        document.querySelectorAll(".mini_moon").forEach((moon) => {
          const onclick = moon.getAttribute("onclick");
          const match = onclick?.match(/switch_planet\((\d+)/);
          if (match) {
            const planetId = match[1];
            // Находим координаты
            const parent = moon.closest(".ov-pl-block, .ov-pl-wrapper");
            const locationEl = parent?.querySelector(".ov-location a");
            const coords = locationEl?.textContent?.trim();
            result.push({
              type: "moon",
              id: planetId,
              coords: coords,
            });
          }
        });
        return result;
      });

      console.log("🌙 Найдены луны:", planets);
    }

    // Переходим на fleet.php и проверяем структуру
    console.log("\n=== Анализируем fleet.php ===");
    await page.goto("https://crazy.xgame-online.com/fleet.php", {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    await new Promise((r) => setTimeout(r, 2000));

    // Ищем список планет для переключения
    const planetList = await page.evaluate(() => {
      const result = [];

      // Ищем все ссылки на планеты/луны
      document.querySelectorAll("a").forEach((a) => {
        const href = a.href || "";
        const onclick = a.getAttribute("onclick") || "";

        // Ищем switch_planet или cp= в href
        if (href.includes("cp=") || onclick.includes("switch_planet")) {
          const text = a.textContent?.trim();
          const title = a.title || a.getAttribute("title") || "";
          result.push({
            text: text,
            title: title,
            href: href,
            onclick: onclick,
          });
        }
      });

      return result;
    });

    console.log("🪐 Планеты/луны для переключения:");
    planetList.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.text || p.title}: ${p.href || p.onclick}`);
    });

    // Пробуем переключиться на первую луну
    console.log("\n=== Пробуем переключиться на луну ===");

    // Ищем луну через cp параметр
    const moonUrl = "https://crazy.xgame-online.com/fleet.php?cp=31694";
    console.log(`Переходим на: ${moonUrl}`);

    await page.goto(moonUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    await new Promise((r) => setTimeout(r, 2000));

    // Проверяем корабли на луне
    const moonShips = await page.evaluate(() => {
      const result = {
        ships: [],
        hiddenInputs: {},
      };

      // Собираем скрытые поля
      document.querySelectorAll('input[type="hidden"]').forEach((inp) => {
        result.hiddenInputs[inp.name] = inp.value;
      });

      // Ищем корабли
      document.querySelectorAll("tr").forEach((tr) => {
        const shipInput = tr.querySelector('input[name^="ship"]');
        const maxInput = tr.querySelector('input[name^="maxship"]');
        if (shipInput && maxInput) {
          const link = tr.querySelector("a");
          result.ships.push({
            name: link?.textContent?.trim() || shipInput.name,
            inputName: shipInput.name,
            available: maxInput.value,
          });
        }
      });

      return result;
    });

    console.log("\n🚀 Корабли на луне:");
    console.log(
      `  Координаты: ${moonShips.hiddenInputs.galaxy}:${moonShips.hiddenInputs.system}:${moonShips.hiddenInputs.planet}`,
    );
    console.log(`  Тип планеты: ${moonShips.hiddenInputs.planet_type}`);
    console.log(`  Макс экспедиций: ${moonShips.hiddenInputs.maxepedition}`);
    console.log(`  Текущих экспедиций: ${moonShips.hiddenInputs.curepedition}`);

    if (moonShips.ships.length > 0) {
      moonShips.ships.forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.name}: ${s.available} шт.`);
      });

      // Пробуем выбрать все корабли и нажать "Далее"
      console.log("\n=== Пробуем отправить экспедицию ===");

      // Выбираем все корабли
      await page.evaluate(() => {
        // Функция maxShips() уже есть на странице
        if (typeof maxShips === "function") {
          maxShips();
        } else {
          // Заполняем вручную
          document.querySelectorAll('input[name^="ship"]').forEach((inp) => {
            const maxInp = document.querySelector(
              'input[name="max' + inp.name + '"]',
            );
            if (maxInp) {
              inp.value = maxInp.value;
            }
          });
        }
      });

      await new Promise((r) => setTimeout(r, 500));

      // Нажимаем кнопку "Далее"
      const submitBtn = await page.$('input[type="submit"][value*="Далее"]');
      if (submitBtn) {
        console.log("Нажимаем кнопку [Далее]...");
        await submitBtn.click();

        // Ждём перехода на floten2.php или floten1.php
        await page.waitForNavigation({ timeout: 10_000 }).catch(() => {});

        await new Promise((r) => setTimeout(r, 2000));

        console.log(`Текущий URL: ${page.url()}`);

        // Сохраняем HTML следующей страницы
        const nextHtml = await page.evaluate(() => document.body.innerHTML);
        fs.writeFileSync("./debug-floten2.html", nextHtml);
        console.log("💾 Сохранён debug-floten2.html");

        // Анализируем страницу floten2
        const floten2Data = await page.evaluate(() => {
          return {
            url: window.location.href,
            forms: Array.from(document.forms).map((f) => ({
              name: f.name,
              action: f.action,
              inputs: Array.from(f.querySelectorAll("input")).map((i) => ({
                name: i.name,
                type: i.type,
                value: i.value,
              })),
            })),
            selects: Array.from(document.querySelectorAll("select")).map(
              (s) => ({
                name: s.name,
                options: Array.from(s.options).map((o) => ({
                  value: o.value,
                  text: o.text,
                })),
              }),
            ),
            bodyText: document.body.innerText.substring(0, 2000),
          };
        });

        console.log("\n📝 Данные страницы floten2:");
        console.log(`URL: ${floten2Data.url}`);
        console.log(
          `Формы: ${floten2Data.forms.map((f) => f.name).join(", ")}`,
        );
        console.log(
          `Селекты: ${floten2Data.selects.map((s) => s.name).join(", ")}`,
        );

        if (floten2Data.selects.length > 0) {
          console.log("\n📋 Опции селектов:");
          floten2Data.selects.forEach((s) => {
            console.log(`  ${s.name}:`);
            s.options.slice(0, 10).forEach((o) => {
              console.log(`    - ${o.value}: ${o.text}`);
            });
          });
        }

        console.log("\n📄 Текст страницы:");
        console.log(floten2Data.bodyText);
      } else {
        console.log("⚠️ Кнопка [Далее] не найдена");
      }
    } else {
      console.log("⚠️ На луне нет кораблей");
    }

    console.log("\n✅ Тест завершён");
    await new Promise((r) => setTimeout(r, 5000));
    await context.close();
  } catch (err) {
    console.error("❌ Ошибка:", err.message);
    console.error(err.stack);
  } finally {
    await browser.close();
  }
}

testExpedition();

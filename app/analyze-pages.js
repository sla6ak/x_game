// analyze-pages.js
// Временный скрипт для анализа HTML-структуры страниц игры
// Запускается один раз для сбора информации о структуре

const fs = require("fs");
const SESSION_FILE = "./session.json";

async function analyzePages(browser) {
  console.log("🔍 [analyze] Начинаем анализ страниц...");

  const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
  const context = await browser.newContext();
  await context.addCookies(cookies);

  const page = await context.newPage();

  // Открываем frames.php
  await page.goto("https://crazy.xgame-online.com/frames.php", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });

  console.log("✅ Открыли frames.php, ищем фреймы...");

  // Ждём загрузки фреймов
  await new Promise((r) => setTimeout(r, 3000));

  const frames = page.frames();
  console.log(
    "📋 Найдено фреймов:",
    frames.map((f) => ({ url: f.url().split("?")[0], name: f.name() })),
  );

  // Ищем фрейм overview.php
  const overviewFrame = frames.find((f) => f.url().includes("overview.php"));
  if (overviewFrame) {
    console.log("\n=== АНАЛИЗ OVERVIEW.PHP (Миссии) ===");

    // Получаем полный HTML body
    const bodyHtml = await overviewFrame.evaluate(
      () => document.body.innerHTML,
    );
    fs.writeFileSync("./debug-overview.html", bodyHtml);
    console.log("💾 Сохранён debug-overview.html");

    // Ищем таблицы с миссиями
    const missionTables = await overviewFrame.evaluate(() => {
      const tables = document.querySelectorAll("table");
      return Array.from(tables).map((t, i) => ({
        index: i,
        className: t.className,
        id: t.id,
        rowsCount: t.rows?.length || 0,
        innerHTML: t.innerHTML.substring(0, 2000),
      }));
    });

    console.log("\n📊 Таблицы на странице:");
    missionTables.forEach((t) => {
      console.log(
        `  Таблица ${t.index}: class="${t.className}", rows=${t.rowsCount}`,
      );
    });

    // Ищем все элементы с классом содержащим "fleet" или "mission"
    const fleetElements = await overviewFrame.evaluate(() => {
      const allElements = document.querySelectorAll("*");
      const result = [];
      allElements.forEach((el) => {
        const classes = el.className || "";
        if (
          typeof classes === "string" &&
          (classes.includes("fleet") ||
            classes.includes("mission") ||
            classes.includes("floten") ||
            classes.includes("movement"))
        ) {
          result.push({
            tag: el.tagName,
            class: classes,
            text: el.textContent?.substring(0, 200),
          });
        }
      });
      return result;
    });

    console.log("\n🚀 Элементы связанные с флотом:");
    fleetElements.forEach((el) => {
      console.log(
        `  <${el.tag} class="${el.class}">: ${el.text?.substring(0, 100)}...`,
      );
    });

    // Получаем весь текст страницы для анализа
    const allText = await overviewFrame.evaluate(() => document.body.innerText);
    console.log("\n📄 Текст страницы (первые 3000 символов):");
    console.log(allText.substring(0, 3000));
  }

  // Анализируем страницу fleet.php (основная страница флота)
  console.log("\n=== АНАЛИЗ FLEET.PHP (Страница флота) ===");
  await page.goto("https://crazy.xgame-online.com/fleet.php", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });

  // Ждём загрузки
  await new Promise((r) => setTimeout(r, 2000));

  const fleetHtml = await page.evaluate(() => document.body.innerHTML);
  fs.writeFileSync("./debug-fleet.html", fleetHtml);
  console.log("💾 Сохранён debug-fleet.html");

  // Детально анализируем корабли на странице
  const fleetDetails = await page.evaluate(() => {
    const result = {
      ships: [],
      hiddenInputs: [],
      allInputs: [],
    };

    // Собираем все input поля
    document.querySelectorAll("input").forEach((inp) => {
      result.allInputs.push({
        name: inp.name,
        type: inp.type,
        value: inp.value,
        id: inp.id,
      });
    });

    // Собираем скрытые поля
    document.querySelectorAll('input[type="hidden"]').forEach((inp) => {
      result.hiddenInputs.push({
        name: inp.name,
        value: inp.value,
      });
    });

    // Ищем корабли - ищем строки с input name^="ship"
    document.querySelectorAll("tr").forEach((tr) => {
      const shipInput = tr.querySelector('input[name^="ship"]');
      const maxInput = tr.querySelector('input[name^="maxship"]');
      if (shipInput) {
        const cells = tr.querySelectorAll("td, th");
        const links = tr.querySelectorAll("a");
        result.ships.push({
          inputName: shipInput.name,
          inputValue: shipInput.value,
          maxValue: maxInput ? maxInput.value : null,
          cellCount: cells.length,
          linkTexts: Array.from(links).map((l) => l.textContent?.trim()),
          rowText: tr.textContent?.trim().substring(0, 200),
        });
      }
    });

    return result;
  });

  console.log("\n🚀 Корабли на странице fleet.php:");
  fleetDetails.ships.forEach((s, i) => {
    console.log(
      `  ${i + 1}. ${s.inputName}: value=${s.inputValue}, max=${s.maxValue}`,
    );
    console.log(`     Links: ${s.linkTexts.join(", ")}`);
  });

  console.log("\n📝 Скрытые поля формы:");
  fleetDetails.hiddenInputs.forEach((inp) => {
    console.log(`  ${inp.name}: ${inp.value}`);
  });

  console.log("\n📋 Все input поля (первые 20):");
  fleetDetails.allInputs.slice(0, 20).forEach((inp) => {
    console.log(`  ${inp.name} (${inp.type}): ${inp.value}`);
  });

  // Ищем информацию о движении флота на этой странице
  const fleetMovement = await page.evaluate(() => {
    const result = {
      forms: [],
      tables: [],
      flyingFleets: [],
    };

    // Собираем формы
    document.querySelectorAll("form").forEach((f) => {
      result.forms.push({
        name: f.name,
        action: f.action,
        id: f.id,
      });
    });

    // Собираем таблицы
    document.querySelectorAll("table").forEach((t, i) => {
      result.tables.push({
        index: i,
        className: t.className,
        rowsCount: t.rows?.length || 0,
        text: t.textContent?.substring(0, 500),
      });
    });

    // Ищем все элементы с текстом о флоте/экспедиции
    const bodyText = document.body.innerText;
    const lines = bodyText.split("\n").filter((l) => l.trim());
    result.flyingFleets = lines.filter(
      (l) =>
        l.includes("флот") ||
        l.includes("Экспедиция") ||
        l.includes("возвращается") ||
        l.includes("прибывает"),
    );

    return result;
  });

  console.log("\n📝 Формы на странице fleet.php:");
  fleetMovement.forms.forEach((f) => {
    console.log(`  ${f.name || "без имени"}: action=${f.action}`);
  });

  console.log("\n📊 Таблицы:");
  fleetMovement.tables.forEach((t) => {
    console.log(
      `  Таблица ${t.index}: class="${t.className}", rows=${t.rowsCount}`,
    );
  });

  console.log("\n🚀 Летящие флоты:");
  fleetMovement.flyingFleets.forEach((f) => {
    console.log(`  ${f}`);
  });

  // Теперь пробуем перейти на floten1.php через fleet.php
  console.log("\n=== АНАЛИЗ FLOTEN1.PHP (Отправка флота) ===");
  await page.goto("https://crazy.xgame-online.com/floten1.php", {
    waitUntil: "networkidle",
    timeout: 20_000,
  });

  const flotenHtml = await page.evaluate(() => document.body.innerHTML);
  fs.writeFileSync("./debug-floten1.html", flotenHtml);
  console.log("💾 Сохранён debug-floten1.html");

  // Собираем информацию о формах
  const forms = await page.evaluate(() => {
    return Array.from(document.forms).map((f) => ({
      name: f.name,
      action: f.action,
      method: f.method,
      inputs: Array.from(f.querySelectorAll("input")).map((i) => ({
        name: i.name,
        type: i.type,
        value: i.value,
      })),
    }));
  });

  console.log("\n📝 Формы на странице floten1.php:");
  forms.forEach((f) => {
    console.log(`  Форма: ${f.name}, action: ${f.action}`);
    f.inputs.slice(0, 10).forEach((i) => {
      console.log(`    - ${i.name} (${i.type}): ${i.value}`);
    });
  });

  // Собираем корабли
  const ships = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll("table tr").forEach((tr) => {
      const link = tr.querySelector("a");
      const input = tr.querySelector('input[name^="ship"]');
      const cells = tr.querySelectorAll("td, th");
      if (link && input && cells.length > 1) {
        result.push({
          type: link.textContent.trim(),
          name: input.name,
          available: cells[1]?.textContent?.trim() || "?",
          id: input.id,
        });
      }
    });
    return result;
  });

  console.log("\n🚀 Корабли доступные на странице:");
  ships.forEach((s) => {
    console.log(`  ${s.type} (${s.name}): доступно=${s.available}`);
  });

  // Проверяем есть ли выбор планеты/луны
  const planetSelect = await page.evaluate(() => {
    const selects = document.querySelectorAll("select");
    return Array.from(selects).map((s) => ({
      name: s.name,
      id: s.id,
      options: Array.from(s.options).map((o) => ({
        value: o.value,
        text: o.text,
      })),
    }));
  });

  console.log("\n🌍 Селекты на странице:");
  planetSelect.forEach((s) => {
    console.log(`  ${s.name || s.id}:`);
    s.options.slice(0, 5).forEach((o) => {
      console.log(`    - ${o.value}: ${o.text}`);
    });
  });

  // Ищем страницу с движением флота
  console.log("\n=== ПОИСК СТРАНИЦЫ С ДВИЖЕНИЕМ ФЛОТА ===");

  // Проверяем возможные URL
  const movementUrls = [
    "movement.php",
    "fleet.php?mode=movement",
    "overview.php?mode=fleet",
  ];

  for (const url of movementUrls) {
    try {
      console.log(`\n🔍 Проверяем: ${url}`);
      await page.goto(`https://crazy.xgame-online.com/${url}`, {
        waitUntil: "networkidle",
        timeout: 15_000,
      });

      const bodyText = await page.evaluate(() => document.body.innerText);
      const html = await page.evaluate(() => document.body.innerHTML);

      // Ищем ключевые слова
      const hasMovement =
        bodyText.includes("возвращается") ||
        bodyText.includes("прибывает") ||
        bodyText.includes("Задание") ||
        bodyText.includes("Экспедиция");

      if (hasMovement) {
        console.log(`  ✅ Найдена информация о движении флота!`);
        fs.writeFileSync("./debug-movement.html", html);
        console.log("  💾 Сохранён debug-movement.html");

        // Парсим информацию о летящих флотах
        const flyingFleets = await page.evaluate(() => {
          const result = [];

          // Ищем все строки с информацией о флоте
          document.querySelectorAll("tr").forEach((tr) => {
            const text = tr.textContent || "";
            if (
              text.includes("возвращается") ||
              text.includes("прибывает") ||
              text.includes("Экспедиция")
            ) {
              result.push({
                html: tr.innerHTML.substring(0, 1000),
                text: text.substring(0, 500),
              });
            }
          });

          return result;
        });

        console.log("\n🚀 Летящие флоты:");
        flyingFleets.forEach((f, i) => {
          console.log(`  Флот ${i + 1}: ${f.text.substring(0, 200)}...`);
        });
      } else {
        console.log(`  ❌ Нет информации о движении флота`);
      }
    } catch (err) {
      console.log(`  ⚠️ Ошибка: ${err.message}`);
    }
  }

  // Проверяем leftmenu.php для поиска ссылок
  console.log("\n=== АНАЛИЗ LEFTMENU.PHP (Меню) ===");
  await page.goto("https://crazy.xgame-online.com/leftmenu.php", {
    waitUntil: "networkidle",
    timeout: 15_000,
  });

  const menuLinks = await page.evaluate(() => {
    const links = document.querySelectorAll("a");
    return Array.from(links).map((a) => ({
      text: a.textContent?.trim(),
      href: a.href,
      onclick: a.getAttribute("onclick"),
    }));
  });

  console.log("\n📋 Ссылки в меню:");
  menuLinks.forEach((l) => {
    if (l.text && l.text.trim()) {
      console.log(`  ${l.text}: ${l.href || l.onclick || ""}`);
    }
  });

  console.log("\n✅ Анализ завершён. Проверьте файлы debug-*.html");
  await context.close();
}

module.exports = { analyzePages };

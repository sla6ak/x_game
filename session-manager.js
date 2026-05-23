const fs = require("fs");
const SESSION_FILE = "./session.json";

// Сколько раз пробовать логин если не получилось
const MAX_RETRIES = 2;
// Пауза между попытками (мс)
const RETRY_DELAY = 4_265;
// Таймаут для всех операций с браузером (мс) — меняй здесь одно значение
const TIMEOUT = 20_000;

// Читаем данные для входа из внешнего файла config.json
const credentials = JSON.parse(fs.readFileSync("./config.json", "utf-8"));

// Блокировщик лишних ресурсов — картинки, шрифты, стили не нужны
function blockResources(page) {
  return page.route("**/*", (route) => {
    const blocked = ["image", "media", "font"];
    blocked.includes(route.request().resourceType())
      ? route.abort()
      : route.continue();
  });
}

// Проверяем авторизованы ли мы уже
// Открываем frames.php — если пустил, сессия жива
async function isLoggedIn(browser) {
  const context = await browser.newContext();

  // Если есть сохранённые cookies — загружаем их
  if (fs.existsSync(SESSION_FILE)) {
    const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    await context.addCookies(cookies);
    console.log("🍪 [session] Найдена сохранённая сессия, проверяем...");
  } else {
    console.log("📭 [session] Файл сессии не найден, нужен логин");
    await context.close();
    return false;
  }

  const page = await context.newPage();
  await blockResources(page);

  await page.goto("https://crazy.xgame-online.com/frames.php", {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });

  const url = page.url();
  await context.close();

  if (url.includes("login.php")) {
    console.log("⚠️  [session] Сессия устарела — нужен логин");
    return false;
  }

  console.log("✅ [session] Сессия активна — логин не нужен");
  return true;
}

// Выполняем логин и сохраняем сессию
async function doLogin(browser) {
  const page = await browser.newPage();
  await blockResources(page);

  await page.goto("https://crazy.xgame-online.com/login.php", {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });

  await page.waitForSelector('input[type="submit"]', { timeout: TIMEOUT });
  await page.waitForTimeout(1000);
  // Заполняем поля напрямую через JavaScript — минуя проверки Playwright
  await page.evaluate(
    ({ nickname, password, universe }) => {
      // Берём все видимые input (не hidden)
      const visible = [...document.querySelectorAll("input")].filter(
        (el) => el.type !== "hidden",
      );

      // Первый видимый — никнейм, второй — пароль
      visible[0].value = nickname;
      visible[1].value = password;

      // Выбираем вселенную — ищем опцию которая содержит название
      const select = document.querySelector('select[name="uni"]');
      const option = [...select.options].find((o) => o.value === universe);
      if (option) select.value = option.value;
    },
    {
      nickname: credentials.nickname,
      password: credentials.password,
      universe: credentials.universe,
    },
  );

  await page.click('input[type="submit"]');
  await page.waitForLoadState("domcontentloaded", { timeout: TIMEOUT });

  if (page.url().includes("login.php")) {
    throw new Error("Неверный никнейм или пароль");
  }

  const cookies = await page.context().cookies();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
  console.log("💾 [session] Сессия сохранена в", SESSION_FILE);

  await page.close();
}
// Главная функция: проверяет сессию и логинится если нужно
// Возвращает true если всё ок, false если не удалось
async function ensureLoggedIn(browser) {
  const alreadyIn = await isLoggedIn(browser);
  if (alreadyIn) return true;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`🔐 [session] Попытка входа ${attempt}/${MAX_RETRIES}...`);

    try {
      await doLogin(browser);
      console.log("✅ [session] Вход выполнен успешно!");
      return true;
    } catch (err) {
      console.error(`❌ [session] Попытка ${attempt} неудачна:`, err.message);

      if (attempt < MAX_RETRIES) {
        console.log(
          `⏳ [session] Следующая попытка через ${RETRY_DELAY / 1000} сек...`,
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      }
    }
  }

  console.error("🚫 [session] Все попытки исчерпаны. Останавливаемся.");
  return false;
}

module.exports = { ensureLoggedIn, SESSION_FILE };

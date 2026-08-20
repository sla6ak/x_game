const fs = require("fs");
const path = require("path");

// Единый файл сессии (cookies)
const SESSION_FILE = path.join(__dirname, "..", "session.json");
const BASE = "https://crazy.xgame-online.com";

const MAX_RETRIES = 3;
const RETRY_DELAY = 1_800;
const TIMEOUT = 15_000;

// Креды из config.json
const credentials = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf-8"),
);

/**
 * Блокировщик лишних ресурсов (картинки, шрифты, стили).
 * Экспортируем для повторного использования в bot-missions / expedition.
 */
function blockResources(page) {
  return page.route("**/*", (route) => {
    const blocked = ["image", "media", "font", "stylesheet"];
    blocked.includes(route.request().resourceType())
      ? route.abort()
      : route.continue();
  });
}

// Ждём появления формы логина в DOM
async function waitForLoginForm(page) {
  await page.waitForFunction(
    () => {
      const forms = Array.from(document.forms || []);
      const form = forms.find((f) => {
        const textInputs = Array.from(f.querySelectorAll("input")).filter(
          (el) => el.type !== "hidden",
        );
        return textInputs.length >= 2;
      });
      if (!form) return false;
      const submitControl = form.querySelector(
        'input[type="submit"], button[type="submit"], button:not([type])',
      );
      return Boolean(submitControl);
    },
    { timeout: TIMEOUT },
  );
}

/**
 * Проверяем, жива ли сессия, через ОБЩИЙ контекст.
 * Если есть session.json — подгружаем cookies в контекст и проверяем frames.php.
 * ВАЖНО: не закрываем переданный контекст — он общий для всего бота.
 * @param {import('playwright').BrowserContext} context
 */
async function isLoggedIn(context) {
  if (fs.existsSync(SESSION_FILE)) {
    const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    await context.addCookies(cookies);
    console.log("🍪 [session] Найдена сохранённая сессия, проверяем...");
  } else {
    console.log("📭 [session] Файл сессии не найден, нужен логин");
  }

  const page = await context.newPage();
  try {
    await blockResources(page);
    await page.goto(BASE + "/frames.php", {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const url = page.url();
    if (url.includes("login.php")) {
      console.log("⚠️  [session] Сессия устарела — нужен логин");
      return false;
    }
    console.log("✅ [session] Сессия активна — логин не нужен");
    return true;
  } finally {
    await page.close();
  }
}

/**
 * Выполняем логин через ОБЩИЙ контекст и сохраняем cookies.
 * @param {import('playwright').BrowserContext} context
 */
async function doLogin(context) {
  const page = await context.newPage();
  try {
    await blockResources(page);
    await page.goto(BASE + "/login.php", {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });

    await waitForLoginForm(page);

    await page.evaluate(
      ({ nickname, password, universe }) => {
        const fireEvents = (el) => {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const forms = Array.from(document.forms || []);
        const form = forms.find((f) => {
          const textInputs = Array.from(f.querySelectorAll("input")).filter(
            (el) => el.type !== "hidden",
          );
          return textInputs.length >= 2;
        });
        if (!form) throw new Error("Форма логина не найдена");
        const textInputs = Array.from(form.querySelectorAll("input")).filter(
          (el) => el.type !== "hidden",
        );
        const loginInput = textInputs[0];
        const passInput = textInputs[1];
        if (!loginInput || !passInput)
          throw new Error("Поля логина/пароля не найдены");
        loginInput.value = nickname;
        passInput.value = password;
        fireEvents(loginInput);
        fireEvents(passInput);
        const uniSelect =
          form.querySelector('select[name="uni"]') ||
          form.querySelector('select[name="universe"]') ||
          form.querySelector("select");
        if (uniSelect) {
          const option = Array.from(uniSelect.options).find(
            (o) =>
              o.value === String(universe) ||
              o.textContent.includes(String(universe)),
          );
          if (option) {
            uniSelect.value = option.value;
            fireEvents(uniSelect);
          }
        }
        const submitControl = form.querySelector(
          'input[type="submit"], button[type="submit"], button:not([type])',
        );
        if (submitControl) submitControl.click();
        else if (typeof form.requestSubmit === "function")
          form.requestSubmit();
        else form.submit();
      },
      {
        nickname: credentials.nickname,
        password: credentials.password,
        universe: credentials.universe,
      },
    );

    await page
      .waitForURL((url) => !url.toString().includes("login.php"), {
        timeout: TIMEOUT,
      })
      .catch(() => null);

    if (page.url().includes("login.php")) {
      throw new Error("Неверный никнейм или пароль");
    }

    // Сохраняем cookies ОБЩЕГО контекста
    const cookies = await context.cookies();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
    console.log("💾 [session] Сессия сохранена в", SESSION_FILE);
  } finally {
    await page.close();
  }
}

/**
 * Главная функция: проверяет сессию и логинится если нужно.
 * Работает с ОБЩИМ контекстом — cookies сохраняются для всех операций бота.
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<boolean>}
 */
async function ensureLoggedIn(context) {
  const alreadyIn = await isLoggedIn(context);
  if (alreadyIn) return true;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`🔐 [session] Попытка входа ${attempt}/${MAX_RETRIES}...`);
    try {
      await doLogin(context);
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

module.exports = { ensureLoggedIn, blockResources, SESSION_FILE, BASE };

const fs = require("fs");
const SESSION_FILE = "./session.json";

// Сколько раз пробовать логин если не получилось
const MAX_RETRIES = 3;
// Пауза между попытками (мс)
const RETRY_DELAY = 1_800;
// Таймаут для всех операций с браузером (мс) — меняй здесь одно значение
const TIMEOUT = 12_000;

// Читаем данные для входа из внешнего файла config.json
const credentials = JSON.parse(fs.readFileSync("./config.json", "utf-8"));

// Блокировщик лишних ресурсов — картинки, шрифты, стили не нужны
function blockResources(page) {
  return page.route("**/*", (route) => {
    const blocked = ["image", "media", "font", "stylesheet"];
    blocked.includes(route.request().resourceType())
      ? route.abort()
      : route.continue();
  });
}

// Ждём, пока форма входа реально появится в DOM
async function waitForLoginForm(page) {
  await page.waitForFunction(
    () => {
      // 1) Ищем форму с полями логина
      const forms = Array.from(document.forms || []);
      const form = forms.find((f) => {
        const textInputs = Array.from(f.querySelectorAll("input")).filter(
          (el) => el.type !== "hidden",
        );
        return textInputs.length >= 2;
      });

      if (!form) return false;

      // 2) Проверяем, что кнопка отправки уже есть в DOM
      const submitControl = form.querySelector(
        'input[type="submit"], button[type="submit"], button:not([type])',
      );

      return Boolean(submitControl);
    },
    { timeout: TIMEOUT },
  );
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

  // 1) Ждём появление формы в DOM, но не ждём её "видимость"
  await waitForLoginForm(page);

  // 2) Вставляем данные напрямую и триггерим input/change
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

      if (!loginInput || !passInput) {
        throw new Error("Поля логина/пароля не найдены");
      }

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

      // 3) Отправляем форму сразу после установки данных
      const submitControl = form.querySelector(
        'input[type="submit"], button[type="submit"], button:not([type])',
      );

      if (submitControl) {
        submitControl.click();
      } else if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.submit();
      }
    },
    {
      nickname: credentials.nickname,
      password: credentials.password,
      universe: credentials.universe,
    },
  );

  // 4) Ждём перехода с login.php, но не зависаем слишком долго
  await page
    .waitForURL((url) => !url.toString().includes("login.php"), {
      timeout: TIMEOUT,
    })
    .catch(() => null);

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

/**
 * serverXG.js — точка входа.
 *
 * Запускает браузер, проверяет/восстанавливает сессию и запускает главный
 * цикл бота (bot-loop): миссии → сейв → фарм → экспедиции.
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { ensureLoggedIn } = require("./app/session-manager");
const { botLoop } = require("./app/bot-loop");

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config.json"), "utf-8")
);

async function main() {
  console.log("🚀 [server] Запускаем...");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    // mobile viewport — raw-HTML в мобильном формате (dropdown-опции тел)
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    locale: "ru-RU",
  });

  let stopped = false;
  const stop = () => {
    stopped = true;
    console.log("👋 [server] Остановка...");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    // ШАГ 1: сессия
    let ok = await ensureLoggedIn(context);
    if (!ok) {
      console.error("🚫 [server] Авторизация не удалась");
      await browser.close();
      process.exit(1);
    }

    // ШАГ 2: главный цикл
    await botLoop(context, config, {
      stop: () => stopped,
      onTick: (tick) => {
        const m = tick.missions || {};
        console.log(
          `📊 [tick] миссий: ${m.total || 0} ` +
            `(${Object.entries(m.byType || {})
              .map(([k, v]) => `${k}:${v}`)
              .join(" ")}), ` +
            `атаки: ${(tick.safety && tick.safety.incoming) || 0}`
        );
      },
    });
  } catch (err) {
    if (err && err.code === "SESSION_EXPIRED") {
      console.warn("⚠️ [server] Сессия истекла — повторяем логин");
      const ok = await ensureLoggedIn(context);
      if (ok) {
        console.log("✅ [server] Сессия восстановлена, продолжаем");
        await botLoop(context, config, {
          stop: () => stopped,
          onTick: () => {},
        });
      }
    } else {
      console.error("❌ [server] Критическая ошибка:", err.message);
      process.exitCode = 1;
    }
  } finally {
    await context.close();
    await browser.close();
    console.log("👋 [server] Завершено");
  }
}

main();

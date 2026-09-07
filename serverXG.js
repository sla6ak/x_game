/**
 * serverXG.js — точка входа.
 *
 * Запускает браузер, проверяет/восстанавливает сессию и запускает главный
 * цикл бота (bot-loop): миссии → сейв → фарм → экспедиции.
 */

const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
const { chromium } = require("playwright");
const { ensureLoggedIn } = require("./app/session-manager");
const { botLoop, isSessionExpired } = require("./app/bot-loop");
const logger = require("./app/logger");
const { loadConfig, loadBotControls } = require("./app/helpers/config");
const { handleControlsRequest } = require("./app/web/controls");
const { ensureLoggedInResilient } = require("./app/helpers/reconnect");

dotenv.config({ path: path.join(__dirname, ".env") });

const config = loadConfig();

// Базовое логирование ошибок: .errors в корне + глобальные обработчики
logger.installGlobalHandlers();

/**
 * Режим headless.
 * - HEADLESS=1/true → headless (Render, CI, серверы без дисплея)
 * - HEADLESS=0/false → с UI (локальная отладка)
 * - не задан → авто: headless, если нет DISPLAY
 */
function resolveHeadless() {
  const raw = process.env.HEADLESS;
  if (raw !== undefined && raw !== "") {
    return ["1", "true", "yes"].includes(String(raw).toLowerCase());
  }
  return !process.env.DISPLAY;
}

/**
 * Минимальный HTTP-сервер для Render (Web Service требует порт $PORT).
 * Отдаёт /health — статус бота. Запускается только если задан PORT.
 */
function startHealthServer(port) {
  let lastTick = null;
  let waitingForGame = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: waitingForGame ? "waiting_for_game" : "ok",
          uptime_s: Math.round(process.uptime()),
          last_tick: lastTick,
          controls: loadBotControls(),
        }),
      );
      return;
    }

    if (req.url === "/controls") {
      handleControlsRequest(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => {
    console.log(`🌐 [server] Health-сервер реально запущен на :${port}`);
    console.log(
      `🌐 [server] Живая страница: http://localhost:${port}/controls`,
    );
  });
  return {
    server,
    setLastTick: (t) => (lastTick = t),
    setWaitingForGame: (v) => (waitingForGame = !!v),
  };
}

async function main() {
  console.log("🚀 [server] Запускаем...");

  const headless = resolveHeadless();
  console.log(`🖥️  [server] Режим браузера: ${headless ? "headless" : "с UI"}`);

  const browser = await chromium.launch({ headless });
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

  // Render Web Service: health-эндпоинт на $PORT
  const port = process.env.PORT ? Number(process.env.PORT) : null;
  if (port) {
    console.log(`🧭 [server] PORT из env: ${port}`);
  } else {
    console.warn(
      "⚠️ [server] PORT не задан — живая страница /controls не запущена",
    );
  }
  const health = port ? startHealthServer(port) : null;

  // Обработчик тика: консоль + health-эндпоинт
  const onTick = (tick) => {
    const m = tick.missions || {};
    const f = tick.farm && tick.farm.conditions;
    const s = tick.safety;
    console.log(
      `📊 [tick] миссий: ${m.total || 0} ` +
        `(${Object.entries(m.byType || {})
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")}), ` +
        `атаки: ${(s && s.incoming) || 0}` +
        (f
          ? ` | farm: слоты=${f.freeSlots ?? "?"}/${f.fleetMax ?? "?"}, линкоры=${f.battleships ?? "?"}${f.ok ? " ✅" : " ❌ " + f.reasons.join("; ")}`
          : ""),
    );
    if (health) health.setLastTick(tick);
  };

  try {
    // ШАГ 1: сессия. Если игра недоступна — ждём и переподключаемся
    // каждые RECONNECT_INTERVAL_MS (по умолчанию 10 мин), а не падаем.
    const ok = await ensureLoggedInResilient(ensureLoggedIn, context, {
      stop: () => stopped,
      onWaiting: (waiting) => {
        if (health) health.setWaitingForGame(waiting);
      },
    });
    if (!ok) {
      // Остановка по SIGINT/SIGTERM — выходим штатно
      console.log("👋 [server] Остановлено — не запускаем цикл");
      return;
    }

    // ШАГ 2: главный цикл
    await botLoop(context, config, { stop: () => stopped, onTick });
  } catch (err) {
    if (isSessionExpired(err)) {
      console.warn("⚠️ [server] Сессия истекла — повторяем логин");
      const ok = await ensureLoggedInResilient(ensureLoggedIn, context, {
        stop: () => stopped,
        onWaiting: (waiting) => {
          if (health) health.setWaitingForGame(waiting);
        },
      });
      if (ok) {
        console.log("✅ [server] Сессия восстановлена, продолжаем");
        await botLoop(context, config, { stop: () => stopped, onTick });
      }
    } else {
      logger.error(`Критическая ошибка: ${err.message}`, err);
      process.exitCode = 1;
    }
  } finally {
    await context.close();
    await browser.close();
    if (health) health.server.close();
    console.log("👋 [server] Завершено");
  }
}

main();

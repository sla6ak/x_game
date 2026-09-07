/**
 * reconnect.js — ожидание, пока игра снова станет доступна.
 *
 * Если сервер игры недоступен (работы, аптайм, сетевая авария), бот НЕ
 * завершается: он ждёт и проверяет доступность каждые RECONNECT_INTERVAL_MS
 * (по умолчанию 10 минут, настраивается переменной окружения
 * RECONNECT_INTERVAL_MS, значение в миллисекундах).
 */

const { BASE } = require("../http");
const { delay } = require("./async");
/** Интервал повторных попыток (мс). По умолчанию 10 минут. */
const RECONNECT_INTERVAL_MS = Number(
  process.env.RECONNECT_INTERVAL_MS || 10 * 60 * 1000,
);

/** Таймаут одной проверки доступности (мс). */
const PROBE_TIMEOUT_MS = Number(process.env.REACH_PROBE_TIMEOUT_MS || 60000);

/** «10 мин» / «30 с» — человекочитаемый интервал. */
function humanMs(ms) {
  return ms >= 60000
    ? `${Math.round(ms / 60000)} мин`
    : `${Math.round(ms / 1000)} с`;
}

/**
 * Похоже ли это на сетевую ошибку (игра недоступна), а не на логику бота.
 * @param {Error} err
 * @returns {boolean}
 */
function isNetworkError(err) {
  if (!err) return false;
  const msg = String((err && err.message) || "");
  return (
    err.name === "TimeoutError" ||
    /timeout \d+ms exceeded/i.test(msg) ||
    /net::ERR_/.test(msg) ||
    /ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE/i.test(
      msg,
    ) ||
    /socket hang up/i.test(msg) ||
    /ERR_INTERNET_DISCONNECTED/i.test(msg) ||
    /failed to fetch|fetch failed/i.test(msg)
  );
}

/**
 * Быстрая проверка: сервер игры отвечает?
 * Любой HTTP-ответ (200/302/503) = доступен. Сетевая ошибка = недоступен.
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<boolean>}
 */
async function isGameReachable(context) {
  try {
    await context.request.get(BASE + "/login.php", {
      timeout: PROBE_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    if (isNetworkError(err)) return false;
    throw err;
  }
}

/**
 * Пауза, которую можно прервать сигналом остановки (SIGINT/SIGTERM).
 * @param {number} ms
 * @param {() => boolean} [stopFn]
 * @returns {Promise<boolean>} false — если остановка запрошена
 */
async function interruptibleSleep(ms, stopFn) {
  const end = Date.now() + ms;
  for (;;) {
    if (stopFn && stopFn()) return false;
    const remain = end - Date.now();
    if (remain <= 0) return true;
    await delay(Math.min(1000, remain));
  }
}

/**
 * Ждём, пока игра станет доступна (проверка каждые intervalMs).
 * Небесконечно не ждём: выходим, если запрошена остановка.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} [opts] — { stop: () => bool, intervalMs: number }
 * @returns {Promise<boolean>} true — игра доступна; false — запрошена остановка
 */
async function waitForGameReachable(context, opts = {}) {
  const stop = opts.stop || (() => false);
  const interval = opts.intervalMs || RECONNECT_INTERVAL_MS;
  let attempt = 0;

  for (;;) {
    if (stop()) return false;
    attempt += 1;

    let reachable = false;
    try {
      reachable = await isGameReachable(context);
    } catch (err) {
      console.warn(
        `🌐 [reconnect] Ошибка проверки доступности: ${err.message}`,
      );
    }

    if (reachable) {
      console.log(
        `✅ [reconnect] Игра снова доступна (проверка №${attempt}) — продолжаем`,
      );
      return true;
    }

    console.warn(
      `🌐 [reconnect] Игра недоступна (проверка №${attempt}) — повтор через ${humanMs(interval)}`,
    );
    const finished = await interruptibleSleep(interval, stop);
    if (!finished) return false;
  }
}

/**
 * ensureLoggedIn с устойчивостью к недоступности игры.
 *
 * - Сетевая ошибка (игра недоступна) → ждём, пока игра снова станет
 *   доступна (проверка каждые RECONNECT_INTERVAL_MS, по умолчанию 10 мин).
 * - Логин не удался (ok=false) → пауза RECONNECT_INTERVAL_MS и повтор.
 * - Сигнал остановки (opts.stop) → выход (return false).
 * - Ошибка не сетевая → пробрасываем дальше (критическая).
 *
 * @param {(context) => Promise<boolean>} loginFn — ensureLoggedIn из session-manager
 * @param {import('playwright').BrowserContext} context
 * @param {Object} [opts] — { stop: () => bool, onWaiting: (bool) => void, intervalMs: number }
 * @returns {Promise<boolean>} true — вошёл; false — запрошена остановка
 */
async function ensureLoggedInResilient(loginFn, context, opts = {}) {
  const stop = opts.stop || (() => false);
  const onWaiting = opts.onWaiting || (() => {});
  const interval = opts.intervalMs || RECONNECT_INTERVAL_MS;

  // Минимальная пауза между попытками логина — защита от «горящего» цикла,
  // если проба доступности проходит, но логин всё равно падает (медленный сервер).
  let lastAttemptAt = 0;

  for (;;) {
    if (stop()) return false;

    if (lastAttemptAt > 0) {
      const wait = lastAttemptAt + interval - Date.now();
      if (wait > 0) {
        const finished = await interruptibleSleep(wait, stop);
        if (!finished) return false;
      }
    }
    lastAttemptAt = Date.now();

    let mode = null; // "network" | "login-failed"
    try {
      const ok = await loginFn(context);
      if (ok) {
        onWaiting(false);
        return true;
      }
      mode = "login-failed";
    } catch (err) {
      if (isNetworkError(err)) {
        mode = "network";
        console.warn(`⚠️ [server] Игра недоступна: ${err.message}`);
      } else {
        throw err;
      }
    }

    if (mode === "network") {
      console.log(
        `🌐 [server] Жду, пока игра станет доступна (проверка каждые ${humanMs(interval)})`,
      );
      onWaiting(true);
      const reachable = await waitForGameReachable(context, {
        stop,
        intervalMs: interval,
      });
      onWaiting(false);
      if (stop()) return false;
      // игра снова доступна → выходим из цикла и повторяем логин
    } else {
      console.log(`⏳ [server] Логин не удался — повторю через ${humanMs(interval)}`);
      const finished = await interruptibleSleep(interval, stop);
      if (!finished) return false;
    }
  }
}

module.exports = {
  RECONNECT_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  humanMs,
  isNetworkError,
  isGameReachable,
  interruptibleSleep,
  waitForGameReachable,
  ensureLoggedInResilient,
};

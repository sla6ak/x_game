/**
 * logger.js — базовое логирование ошибок.
 *
 * - Все ошибки пишутся в корневой файл `.errors` (append) + в консоль.
 * - Формат строки: ISO-время | уровень | сообщение | стек (если есть).
 * - Глобальные обработчики uncaughtException / unhandledRejection
 *   подключаются через installGlobalHandlers().
 */

const fs = require("fs");
const path = require("path");

const ERRORS_FILE = path.join(__dirname, "..", ".errors");

function timestamp() {
  return new Date().toISOString();
}

/**
 * Дописать запись в .errors. Никогда не бросает исключений —
 * логгер не должен ронять сам бота.
 */
function appendToFile(level, message, err) {
  const lines = [`[${timestamp()}] ${level} ${message}`];
  if (err && err.stack) {
    lines.push(err.stack);
  }
  lines.push(""); // пустая строка-разделитель
  try {
    fs.appendFileSync(ERRORS_FILE, lines.join("\n"), "utf-8");
  } catch (e) {
    // Файл недоступен (например, read-only ФС) — только в консоль.
    console.error(`[logger] Не удалось записать в ${ERRORS_FILE}:`, e.message);
  }
}

/** Логирование ошибки: консоль + .errors */
function error(message, err) {
  const detail = err ? ` ${err.message}` : "";
  console.error(`❌ [error] ${message}${detail}`);
  appendToFile("ERROR", `${message}${detail}`, err);
}

/** Предупреждение: только в консоль (не ошибка, не пишем в .errors) */
function warn(message) {
  console.warn(`⚠️ [warn] ${message}`);
}

/**
 * Глобальные обработчики: необработанные исключения и rejection'и
 * фиксируются в .errors. uncaughtException завершает процесс
 * (продолжать работу в неизвестном состоянии нельзя).
 */
function installGlobalHandlers() {
  process.on("uncaughtException", (err) => {
    error("uncaughtException — процесс завершён", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    error("unhandledRejection", err);
  });
  process.on("exit", (code) => {
    appendToFile("EXIT", `Процесс завершён, exit code: ${code}`);
  });
}

module.exports = { error, warn, installGlobalHandlers, ERRORS_FILE };

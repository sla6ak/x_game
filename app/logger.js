/**
 * logger.js — базовое логирование.
 *
 * - Все логи (console.log / warn / error) пишутся в один файл `errors.log`.
 * - В консоль они продолжают идти обычным образом.
 * - Глобальные обработчики uncaughtException / unhandledRejection
 *   подключаются через installGlobalHandlers().
 */

const fs = require("fs");
const path = require("path");

const ERRORS_FILE = path.join(__dirname, "..", "errors.log");
const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function timestamp() {
  return new Date().toISOString();
}

/** Локальное "YYYY-MM-DD HH:MM:SS" для префикса консольных логов. */
function tsLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatValue(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

function formatArgs(args) {
  return args.map(formatValue).join(" ");
}

function appendToFile(filePath, level, message, err) {
  const lines = [`[${timestamp()}] ${level} ${message}`];
  if (err && err.stack) {
    lines.push(err.stack);
  }
  lines.push("");
  try {
    fs.appendFileSync(filePath, lines.join("\n"), "utf-8");
  } catch (e) {
    nativeConsole.error(
      `[logger] Не удалось записать в ${filePath}:`,
      e.message,
    );
  }
}

/** Логирование ошибки: консоль + errors.log */
function error(message, err) {
  const detail = err ? ` ${err.message}` : "";
  nativeConsole.error(`[${tsLocal()}] ❌ [error] ${message}${detail}`);
  appendToFile(ERRORS_FILE, "ERROR", `${message}${detail}`, err);
}

/** Предупреждение: консоль + errors.log */
function warn(message, ...extra) {
  nativeConsole.warn(`[${tsLocal()}] ⚠️ [warn] ${message}`, ...extra);
  appendToFile(ERRORS_FILE, "WARN", formatArgs([message, ...extra]));
}

/** Простой лог: консоль + errors.log */
function log(message, ...extra) {
  nativeConsole.log(`[${tsLocal()}] ${message}`, ...extra);
  appendToFile(ERRORS_FILE, "INFO", formatArgs([message, ...extra]));
}

function installGlobalHandlers() {
  if (installGlobalHandlers.installed) return;
  installGlobalHandlers.installed = true;
  console.log = (...args) => {
    nativeConsole.log(`[${tsLocal()}]`, ...args);
    appendToFile(ERRORS_FILE, "INFO", formatArgs(args));
  };
  console.warn = (...args) => {
    nativeConsole.warn(`[${tsLocal()}]`, ...args);
    appendToFile(ERRORS_FILE, "WARN", formatArgs(args));
  };
  console.error = (...args) => {
    nativeConsole.error(`[${tsLocal()}]`, ...args);
    appendToFile(ERRORS_FILE, "ERROR", formatArgs(args));
  };

  process.on("uncaughtException", (err) => {
    error("uncaughtException — процесс завершён", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    error("unhandledRejection", err);
  });
  process.on("exit", (code) => {
    appendToFile(ERRORS_FILE, "EXIT", `Процесс завершён, exit code: ${code}`);
  });
}

module.exports = { error, warn, log, installGlobalHandlers, ERRORS_FILE };

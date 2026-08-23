/**
 * html.js — хелперы для работы с HTML (теги, сущности).
 *
 * Единая точка очистки HTML: используется парсерами, fleet-safety,
 * mission-sender.
 */

/**
 * Убрать теги и скрипты из HTML, декодировать базовые сущности.
 * @param {string} html
 * @returns {string} текст без тегов
 */
function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { stripHtml };

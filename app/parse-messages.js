/**
 * parse-messages.js — парсинг raw-HTML страницы сообщений (reports).
 *
 * Страница: messages.php?mode=show&messcat=100 (доклады: боевые, шпионаж,
 * доставка, экспедиции и т.д.)
 *
 * Строка сообщения (raw-HTML):
 *   <tr id="number_N">
 *     <input name="showmes<ID>" type="hidden" value="<ID>">
 *     <th><input name="delmes<ID>" type="checkbox"></th>
 *     <th>21.08 - 08:02:25</th>            — дата
 *     <th>Атаковать</th>                    — "От" (тип действия)
 *     <th>Боевой доклад</th>               — "Тема"
 *     <th><a href=#messages.php?mode=write&id=0&subject=...>...</a></th>
 *   </tr>
 *
 * Типы действий ("От"): Атаковать, Шпионаж, Оставить, Экспедиция, Добыча ТМ, ...
 * Шпионские доклады — action='Шпионаж' (или тема содержит 'шпион').
 */

/**
 * Парсинг списка сообщений.
 * @param {string} html — raw-HTML messages.php
 * @returns {Array<{id:string, date:string, action:string, theme:string}>}
 */
function parseMessages(html) {
  const messages = [];
  const rowRegex =
    /<tr id="number_\d+">[\s\S]*?<input name="showmes(\d+)" type="hidden" value="\1">[\s\S]*?<th>([\d.]+\s*-\s*[\d:]+)<\/th>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<th[^>]*>([\s\S]*?)<\/th>/g;
  let m;
  const seen = new Set();
  while ((m = rowRegex.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const date = m[2].replace(/\s+/g, " ").trim();
    const action = m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const theme = m[4].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    // Координаты цели (для шпионских докладов в "От": "Имя [g:s:p]")
    const coordM = action.match(/\[(\d+):(\d+):(\d+(?::\d+)?)\]/);
    const coords = coordM ? `${coordM[1]}:${coordM[2]}:${coordM[3]}` : null;
    messages.push({ id, date, action, theme, coords });
  }
  return messages;
}

/**
 * Фильтр шпионских докладов.
 * @param {Array} messages
 * @returns {Array} сообщения-шпионаж
 */
function filterSpyReports(messages) {
  return messages.filter(
    (msg) =>
      /шпион/i.test(msg.action) ||
      /шпион/i.test(msg.theme) ||
      /разведк/i.test(msg.theme),
  );
}

/**
 * Определить, является ли сообщение шпионским докладом.
 */
function isSpyReport(message) {
  return (
    /шпион/i.test(message.action) ||
    /шпион/i.test(message.theme) ||
    /разведк/i.test(message.theme)
  );
}

module.exports = { parseMessages, filterSpyReports, isSpyReport };

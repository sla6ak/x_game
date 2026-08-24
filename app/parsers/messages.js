/**
 * messages.js — парсинг raw-HTML страницы сообщений (reports).
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
    const action = m[3]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const theme = m[4]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();

    let coords = null;
    const coordCandidates = [
      action.match(/\[(\d+):(\d+):(\d+)\]/),
      theme.match(/\[(\d+):(\d+):(\d+)\]/),
      action.match(/\[(\d+):(\d+):(\d+):\d+\]/),
      theme.match(/\[(\d+):(\d+):(\d+):\d+\]/),
    ].filter(Boolean);
    if (coordCandidates.length) {
      const a = coordCandidates[0];
      coords = `${a[1]}:${a[2]}:${a[3]}`;
    }

    messages.push({ id, date, action, theme, coords });
  }
  return messages;
}

function extractReportCoordsFromHtml(html) {
  const matches = [...html.matchAll(/\[(\d+):(\d+):(\d+)\]/g)];
  if (!matches.length) return null;
  const [, g, s, p] = matches[0];
  return `${g}:${s}:${p}`;
}

/**
 * Фильтр шпионских докладов.
 * @param {Array} messages
 * @param {Object} opts — { galaxy?: number|string, system?: number|string }
 * @returns {Array} сообщения-шпионаж
 */
function filterSpyReports(messages, opts = {}) {
  const targetGalaxy = opts.galaxy != null ? String(opts.galaxy) : null;
  const targetSystem = opts.system != null ? String(opts.system) : null;

  return messages.filter((msg) => {
    const isSpy =
      /шпион/i.test(msg.action) ||
      /шпион/i.test(msg.theme) ||
      /разведк/i.test(msg.theme);
    if (!isSpy) return false;

    const coords =
      msg.coords ||
      extractReportCoordsFromHtml(`${msg.action || ""} ${msg.theme || ""}`);
    if (!coords) return targetSystem == null && targetGalaxy == null;

    const [galaxy, system] = coords.split(":").map((v) => v.trim());
    if (targetGalaxy != null && String(galaxy) !== String(targetGalaxy)) {
      return false;
    }
    if (targetSystem != null && String(system) !== String(targetSystem)) {
      return false;
    }
    return true;
  });
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

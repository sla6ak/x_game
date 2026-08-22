/**
 * parse-form.js — универсальный парсер форм из raw-HTML.
 *
 * Извлекает поля формы по её name: input (все типы), select, button.
 * Для radio-кнопок сохраняет checked-вариант. Для select — value.
 */

/**
 * Парсить форму из raw-HTML.
 * @param {string} html — raw-HTML страницы
 * @param {string} formName — name формы (например "floten1")
 * @returns {Object|null} { fieldName: { type, value, checked } } или null если форма не найдена
 */
function parseForm(html, formName) {
  const i = html.indexOf(`name="${formName}"`);
  if (i < 0) return null;
  const seg = html.substring(i, html.indexOf("</form>", i));
  const fields = {};
  const re = /<(input|select|button)[^>]*>/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    const tag = m[0];
    const nameM = tag.match(/name="([^"]+)"/);
    if (!nameM) continue;
    const name = nameM[1];
    const typeM = tag.match(/type="([^"]+)"/);
    const type = typeM ? typeM[1] : m[1] === "select" ? "select-one" : null;
    const valM = tag.match(/ value="([^"]*)"/);
    const val = valM ? valM[1] : null;
    const checked = /checked/.test(tag);
    if (fields[name] === undefined || (type === "radio" && checked)) {
      fields[name] = { type, value: val, checked };
    } else if (type === "radio" && checked) {
      fields[name] = { type, value: val, checked: true };
    }
  }
  return fields;
}

/**
 * Извлечь текст из HTML (без тегов/скриптов).
 * @param {string} html
 */
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Найти ошибку в ответе (модалка с классом errormessage или текст «Ошибка»).
 * Модалка сервера: <div id="modal_header_center">Заголовок</div> ...
 *   <th class="errormessage">Текст ошибки</th>
 * Примеры: «Игрок находится в режиме отпуска!», «Ошибка, планета уничтожена!».
 * @param {string} html — raw-HTML ответа
 * @returns {string|null} текст ошибки или null если успех
 */
function extractError(html) {
  // модалка: класс errormessage — основной текст ошибки
  const em = html.match(/class="errormessage"[^>]*>([^<]+)</);
  if (em) {
    const titleM = html.match(/id="modal_header_center">([^<]+)</);
    const title = titleM ? titleM[1].trim() : "";
    const msg = em[1].trim();
    return title ? `${title}: ${msg}` : msg;
  }
  const text = stripHtml(html);
  const errM = text.match(/Ошибка[^!]{0,120}/);
  if (errM) return errM[0].trim();
  if (/Ошибка/.test(text)) return text.substring(0, 200);
  return null;
}

/**
 * Проверить, что ответ — успех-перезагрузка фрейма (ajax_reload).
 * @param {string} html
 */
function isAjaxReload(html) {
  return /ajax_reload\s*\(/.test(html);
}

module.exports = { parseForm, stripHtml, extractError, isAjaxReload };

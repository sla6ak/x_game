/**
 * http.js — надёжное получение RAW-HTML страниц игры.
 *
 * Ключевой момент: страницы overview.php / fleet.php при рендере в браузере
 * уходят в about:blank (они рассчитаны на frames-интерфейс). Поэтому бот
 * НЕ рендерит их, а запрашивает сырой HTML через context.request (с cookies
 * сессии). Это стабильно и не зависит от JS-переходов.
 */

const BASE = "https://crazy.xgame-online.com";

/**
 * Запросить raw-HTML страницы через контекст (с cookies сессии).
 * @param {import('playwright').BrowserContext} context
 * @param {string} urlPath — путь вида "/overview.php" или "/fleet.php?cp=31694"
 * @returns {Promise<string>} raw-HTML
 */
async function fetchHtml(context, urlPath) {
  const url = urlPath.startsWith("http") ? urlPath : BASE + urlPath;
  const res = await context.request.get(url, { timeout: 20000 });
  const status = res.status();
  const html = await res.text();
  if (status !== 200) {
    throw new Error(`HTTP ${status} для ${url}`);
  }
  // Если вернулась страница логина — сессия протухла
  if (html.includes("login.php") && html.includes('name="aAt"')) {
    throw new Error("SESSION_EXPIRED: страница вернула форму логина");
  }
  return html;
}

/**
 * POST-запрос (для отправки флотов).
 *
 * ВАЖНО (проверено вживую): сервер принимает ТОЛЬКО
 * application/x-www-form-urlencoded + заголовок Referer = страница-источник.
 * Multipart (formData) и отсутствие Referer → «Вы долго отсутствовали».
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} urlPath — путь вида "/floten1.php"
 * @param {Object} form — объект полей формы { key: value }
 * @param {Object} [opts] — { referer: string } (URL страницы-источника)
 */
async function postForm(context, urlPath, form, opts = {}) {
  const url = urlPath.startsWith("http") ? urlPath : BASE + urlPath;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) params.append(k, v == null ? "" : String(v));
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (opts.referer) headers["referer"] = opts.referer;
  const res = await context.request.post(url, {
    timeout: 20000,
    data: params.toString(),
    headers,
  });
  return { status: res.status(), html: await res.text() };
}

module.exports = { fetchHtml, postForm, BASE };

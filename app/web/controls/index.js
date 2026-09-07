/**
 * controls — живая страница управления ботом (GET /controls).
 *
 * Блоки:
 *   АВТОФАРМ:  чекбокс farm, "не занимать последние миссии" (farmReserveSlots),
 *              тип корабля (farmShipName: Линкор/Авианосец/Большой танкер).
 *   ЭКСПЕДИЦИИ: чекбокс expedition, СПИСОК типов кораблей (expeditionShips:
 *              [{name, count}]) — можно несколько типов, у каждого своё
 *              количество (шаг 1 000 000 000). Бот отправит их одним
 *              смешанным флотом.
 *   СЕЙФ:      чекбокс safety.
 *
 * Значения читаются из bot-controls.json (loadBotControls) и сохраняются
 * обратно (saveBotControls) — бот подхватывает их на каждом тике.
 */

const { loadBotControls, saveBotControls, FARM_SHIP_NAMES, EXPEDITION_SHIP_NAMES } = require("../../helpers/config");

const FARM_SHIP_OPTIONS = FARM_SHIP_NAMES; // Линкор, Авианосец, Большой танкер
const EXPEDITION_SHIP_OPTIONS = EXPEDITION_SHIP_NAMES; // 6 боевых типов
const SHIP_COUNT_STEP = 1000000000; // шаг количества — 1 млрд кораблей

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shipSelect(name, options, selected) {
  const opts = options
    .map((o) => `<option value="${esc(o)}"${o === selected ? " selected" : ""}>${esc(o)}</option>`)
    .join("");
  return `<select name="${name}">${opts}</select>`;
}

/**
 * Строка «тип кораблей + количество» для блока экспедиций.
 * Поля повторяются (expeditionShipsName / expeditionShipsCount) —
 * на сервере парсятся через params.getAll() по индексу.
 */
function expeditionShipRow(name, count) {
  const opts = EXPEDITION_SHIP_OPTIONS
    .map((o) => `<option value="${esc(o)}"${o === name ? " selected" : ""}>${esc(o)}</option>`)
    .join("");
  return `<div class="exp-row" style="display: flex; gap: 8px; margin: 6px 0; align-items: center;">
          <select name="expeditionShipsName" style="flex: 1;">${opts}</select>
          <input type="number" name="expeditionShipsCount" value="${esc(count)}" min="0" step="${SHIP_COUNT_STEP}" style="width: 170px;" title="Шаг — 1 000 000 000">
          <button type="button" class="exp-del" title="Убрать этот тип" style="background: #7a2d2d; color: #fff; border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer;">✕</button>
        </div>`;
}

/** JS для добавления/удаления строк типов кораблей. */
const EXPEDITION_ROWS_JS = `
<script>
(function () {
  var NAMES = ${JSON.stringify(EXPEDITION_SHIP_OPTIONS)};
  var STEP = ${SHIP_COUNT_STEP};
  function makeRow(name, count) {
    var div = document.createElement("div");
    div.className = "exp-row";
    div.style.display = "flex";
    div.style.gap = "8px";
    div.style.margin = "6px 0";
    div.style.alignItems = "center";
    var sel = document.createElement("select");
    sel.name = "expeditionShipsName";
    sel.style.flex = "1";
    NAMES.forEach(function (n) {
      var opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      if (n === name) opt.selected = true;
      sel.appendChild(opt);
    });
    var num = document.createElement("input");
    num.type = "number";
    num.name = "expeditionShipsCount";
    num.min = "0";
    num.step = String(STEP);
    num.style.width = "170px";
    num.title = "Шаг — 1 000 000 000";
    if (count != null && count !== "") num.value = String(count);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "exp-del";
    btn.title = "Убрать этот тип";
    btn.textContent = "✕";
    btn.style.background = "#7a2d2d";
    btn.style.color = "#fff";
    btn.style.border = "0";
    btn.style.borderRadius = "4px";
    btn.style.padding = "4px 10px";
    btn.style.cursor = "pointer";
    btn.addEventListener("click", function () { div.remove(); });
    div.appendChild(sel);
    div.appendChild(num);
    div.appendChild(btn);
    return div;
  }
  window.__expMakeRow = makeRow;
  document.querySelectorAll(".exp-del").forEach(function (btn) {
    btn.addEventListener("click", function () {
      btn.closest(".exp-row").remove();
    });
  });
  var addBtn = document.getElementById("exp-add");
  if (addBtn) {
    addBtn.addEventListener("click", function () {
      var used = new Set(Array.from(document.querySelectorAll('select[name="expeditionShipsName"]')).map(function (s) { return s.value; }));
      var free = NAMES.find(function (n) { return !used.has(n); });
      document.getElementById("exp-rows").appendChild(makeRow(free || NAMES[0], ""));
    });
  }
})();
</script>`;

function pageBody(controls) {
  const ships =
    controls.expeditionShips && controls.expeditionShips.length
      ? controls.expeditionShips
      : [{ name: "Линкор", count: 500000000000 }];
  const rows = ships
    .map((s) => expeditionShipRow(s.name, s.count))
    .join("");
  return `
    <h1>Управление ботом</h1>
    <p class="hint">Изменения применяются на следующем тике бота (файл bot-controls.json).</p>

    <form method="POST" action="/controls" style="max-width: 640px;">

      <fieldset style="border: 1px solid #888; margin: 12px 0; padding: 10px 14px;">
        <legend><b>Автофарм</b></legend>
        <label style="display: block; margin: 6px 0;">
          <input type="checkbox" name="farm" ${controls.farm ? "checked" : ""}> Автофарм ресурсов
        </label>
        <label style="display: block; margin: 6px 0;">
          Не занимать последние миссии:
          <input type="number" name="farmReserveSlots" value="${esc(controls.farmReserveSlots)}" min="0" max="42" style="width: 70px;">
        </label>
        <label style="display: block; margin: 6px 0;">
          Корабли для автофарма:
          ${shipSelect("farmShipName", FARM_SHIP_OPTIONS, controls.farmShipName || "Линкор")}
        </label>
        <p class="hint" style="margin: 4px 0;">Вместимость: Линкор 1500, Авианосец 153000, Большой танкер 25000.
        Танкеры не отправляются стандартной формой миссий — если поле ship203 отсутствует, отправка будет пропущена с ошибкой.</p>
      </fieldset>

      <fieldset style="border: 1px solid #888; margin: 12px 0; padding: 10px 14px;">
        <legend><b>Экспедиции</b></legend>
        <label style="display: block; margin: 6px 0;">
          <input type="checkbox" name="expedition" ${controls.expedition ? "checked" : ""}> Автоэкспедиции
        </label>
        <p class="hint" style="margin: 4px 0;">Можно несколько типов кораблей — бот отправит их <b>одним смешанным флотом</b>
        (например, линкоры и авианосцы разного количества). Количество каждого типа ограничивается числом кораблей, реально стоящих на луне.</p>
        <div id="exp-rows">${rows}</div>
        <button type="button" id="exp-add" style="background: #2d6cdf; color: #fff; border: 0; border-radius: 6px; padding: 6px 14px; cursor: pointer; margin-top: 4px;">+ Добавить тип кораблей</button>
        <p class="hint" style="margin: 4px 0;">Шаг количества — 1 000 000 000 (стрелки в поле). Пустое количество = тип не отправляется.</p>
      </fieldset>

      <fieldset style="border: 1px solid #888; margin: 12px 0; padding: 10px 14px;">
        <legend><b>Сейф</b></legend>
        <label style="display: block; margin: 6px 0;">
          <input type="checkbox" name="safety" ${controls.safety ? "checked" : ""}> Автосейф флота
        </label>
      </fieldset>

      <p><button type="submit">Сохранить</button></p>
    </form>
    ${EXPEDITION_ROWS_JS}
  `;
}

/**
 * HTML живой страницы.
 * @returns {string}
 */
function renderControlsPage() {
  const controls = loadBotControls();
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Управление ботом</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #101418; color: #e6e6e6; margin: 0; padding: 24px; }
    h1 { font-size: 22px; }
    label { cursor: pointer; }
    input[type="checkbox"] { width: 16px; height: 16px; }
    input[type="number"] { background: #1c232b; color: #e6e6e6; border: 1px solid #444; border-radius: 4px; padding: 4px 6px; }
    select { background: #1c232b; color: #e6e6e6; border: 1px solid #444; border-radius: 4px; padding: 4px 6px; }
    button { background: #2d6cdf; color: #fff; border: 0; border-radius: 6px; padding: 8px 18px; cursor: pointer; }
    button:hover { background: #3d7cef; }
    .hint { color: #9aa4b2; font-size: 12px; }
    fieldset { background: #161c22; border-radius: 8px; }
    legend { padding: 0 8px; color: #7fb3ff; }
  </style>
</head>
<body>
${pageBody(controls)}
</body>
</html>`;
}

/**
 * Разобрать тело POST в объект controls.
 * @param {string} body
 * @returns {Object}
 */
function resolveControlsFromBody(body) {
  const params = new URLSearchParams(body || "");
  const out = {};
  for (const key of ["farm", "expedition", "safety"]) {
    out[key] = params.get(key) === "on";
  }
  const reserve = Number(params.get("farmReserveSlots"));
  if (Number.isFinite(reserve) && reserve >= 0) out.farmReserveSlots = reserve;
  const farmShip = params.get("farmShipName");
  if (farmShip && FARM_SHIP_OPTIONS.includes(farmShip)) out.farmShipName = farmShip;
  // Новый формат: список типов кораблей (повторяющиеся поля, парим по индексу)
  const names = params.getAll("expeditionShipsName");
  const counts = params.getAll("expeditionShipsCount");
  const ships = [];
  const seen = new Set();
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!EXPEDITION_SHIP_OPTIONS.includes(name)) continue;
    const count = Number(counts[i]);
    if (!Number.isFinite(count) || count <= 0) continue; // пустое/некорректное = не отправлять
    if (seen.has(name)) continue; // дубликат типа — первая запись
    seen.add(name);
    ships.push({ name, count: Math.round(count) });
  }
  if (ships.length) out.expeditionShips = ships;
  return out;
}

/**
 * Обработчик HTTP-запроса /controls: GET — страница, POST — сохранение.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function handleControlsRequest(req, res) {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const nextState = saveBotControls(resolveControlsFromBody(body));
      console.log(`🎛 [controls] Сохранено: ${JSON.stringify(nextState)}`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderControlsPage(nextState));
    });
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderControlsPage());
}

module.exports = { renderControlsPage, resolveControlsFromBody, handleControlsRequest };

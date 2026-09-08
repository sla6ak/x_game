/**
 * mission-sender.js — универсальная отправка миссий через браузер (3 стадии).
 *
 * Почему браузер, а не raw-HTTP:
 *   Серверная страница флота содержит JS, который на submit формы подменяет
 *   значения полей (consumption 1→3, mission 5→6, resource1 ''→0, gRPdPPPPd→
 *   'pGereeeer', добавляет holdingtime). Воспроизвести это raw-HTTP-запросом
 *   хрупко. Поэтому весь flow делаем в реальном браузере: goto + fill + click
 *   по кнопкам [Далее] — все JS-обработчики срабатывают корректно.
 *
 * Подтверждённый flow (тестировался вживую):
 *   Стадия 1: GET  fleet.php?galaxy=G&system=S&planet=P&planettype=T&target_mission=M[&shipID=count]
 *             — это тот же URL, что у кнопки «Шпионаж» на странице галактики
 *             (цель и миссия подставляются сервером из параметров URL).
 *             Если задан fromCp — сначала пробуем fleet.php?cp=<fromCp>&<те же параметры>
 *             (тело-источник, например луна); если форма не появилась — дублируем
 *             ссылку игры как есть (источник = главная планета).
 *             → страница с формой floten1. Заполняем ship<ID>, жмём [Далее].
 *   Стадия 2: страница с формой floten2 (hidden usedfleet — токен флота).
 *             Если поля цели (galaxy/system/planet/planet_type) есть — заполняем
 *             координаты цели (на случай, если сервер их не подставил из URL);
 *             если их нет — цель уже подставлена из URL, просто жмём кнопку.
 *   Стадия 3: страница с формой floten3 (mission, resource1/2/3, holdingtime).
 *             Заполняем ресурсы (если нужно), жмём кнопку.
 *   Стадия 4: ajax_reload / новая страница. Успех: без модалки «Ошибка ...».
 *
 * Коды миссий (target_mission): 1=Атака, 3=Транспорт, 4=Оставить,
 *   5=Защита, 6=Шпионаж
 * «Оставить» (4): флот НЕ возвращается после прибытия — остаётся на цели.
 * Используется для сейва: эвакуация на безопасную луну и возврат домой.
 * Коды кораблей (ship<ID>): 203 Большой танкер, 206 Крейсер, 207 Линкор,
 *   208 Колонизатор, 209 Переработчик, 210 Шпионский зонд, 211 Броненосец,
 *   215 Линейный крейсер, 216 Эсминец, 217 Авианосец
 *
 * Ресурсы (стадия 3, окно выбора ресурсов):
 *   resources: { r1, r2, r3 } — точные значения (как раньше), ИЛИ
 *   resources: { maxAll: true, keepUranium: N } — поведение кнопки «max»:
 *   заполнить флот ВСЕМ доступным (алмазы, уран − несгораемый keep, металл),
 *   ограничивая вместимостью флота.
 *
 * ВАЖНО (проверено вживую): ссылки «max»/«Взять все ресурсы» на стадии 3
 *   НЕ РАБОТАЮТ — JS-функции maxResource()/maxResources() в HTML страницы
 *   НЕ ОПРЕДЕЛЕНЫ (страница содержит только getStorageFaktor). Поэтому
 *   «max» воспроизводим сами из hidden-полей thisresource1/2/3.
 *
 * ВАЖНО (проверено вживую): реальная вместимость флота, которую проверяет
 *   СЕРВЕР, МЕНЬШЕ суммы ship<ID> × capacity<ID> из формы (напр. 10 линкоров:
 *   в форме 10×1530=15300, сервер принимает 15201). Избыток отклоняется
 *   ошибкой «Недостаточно места для погрузки: N», где N — точный избыток
 *   (вместимость = отправлено − N). Поэтому для maxAll есть цикл коррекции:
 *   1) пробуем отправить, рассчитав ресурсы по оценке вместимости;
 *   2) если сервер ответил «Недостаточно места: N» — вычисляем точную
 *      вместимость (отправлено − N − 1) и повторяем стадии 1–3 с ней.
 *   Флот ВСЕГДА улетает (главное — спасти флот, ресурсы — второстепенно):
 *   неудачных эвакуаций из-за вместимости быть не должно.
 *
 * @param {number} [opts.speedPercent] — скорость флота на стадии 2 (10 = 10%)
 */

const { BASE, postForm } = require("./http");
const { extractError, isAjaxReload } = require("./parsers/forms");
const { stripHtml } = require("./helpers/html");
const fs = require("fs");
const path = require("path");

/**
 * Из ошибки стадии 4 «Недостаточно места для погрузки: N» извлечь точный
 * избыток N (число может содержать &nbsp;/пробелы/запятые-разделители).
 * @param {string} error — текст ошибки из extractError
 * @returns {number|null} избыток (насколько отправлено больше вместимости)
 */
function parseCapacityShortage(error) {
  const m = String(error || "").match(
    /недостаточно места для погрузки[:\s]*([0-9][0-9&nbsp;\s,]*)/i,
  );
  if (!m) return null;
  const num = m[1].replace(/[^0-9]/g, "");
  return num ? Number(num) : null;
}

/** Число для логов: 1147349745 → "1 147 349 745" */
function fmt(n) {
  return Number(n || 0).toLocaleString("ru-RU");
}

/**
 * Одна попытка: стадии 1→2→3 + submit стадии 3.
 * @param {import('playwright').Page} page
 * @param {Object} a — { fromCp, target, mission, ships, resources, holdingtime,
 *   moreFL, speedPercent, dryRun, serverCap, urls }
 * @returns {Promise<Object>} { ok, ... } — см. sendMission
 */
async function attemptMission(page, a) {
  const {
    fromCp, target, mission, ships, resources, holdingtime, moreFL,
    speedPercent, dryRun, serverCap, urls,
  } = a;

  // --- Стадия 1: страница флота (тело-источник → home) ---
  let form1 = null;
  for (const url of urls) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    form1 = await page
      .waitForSelector('form[name="floten1"]', { timeout: 25000 })
      .catch(() => null);
    if (form1) break;
  }
  if (!form1) {
    const html = await page.content();
    const err = extractError(html);
    return { ok: false, stage: 1, error: err || "Форма floten1 не найдена" };
  }

  // Логим цель (hidden-поля подставлены сервером из URL) и доступные корабли
  // (список кораблей = флот тела-источника, у луны ~90М зондов)
  const dbg = await page
    .evaluate(() => {
      const f = document.querySelector('form[name="floten1"]');
      if (!f) return null;
      const g = (n) => { const el = f.querySelector(`[name="${n}"]`); return el ? el.value : null; };
      const max = (n) => { const el = document.querySelector(`input[name="maxship${n}"]`); return el ? el.value : null; };
      return {
        target: `${g("galaxy")}:${g("system")}:${g("planet")}`,
        target_mission: g("target_mission"),
        maxShips: { 203: max(203), 207: max(207), 210: max(210) },
      };
    })
    .catch(() => null);
  if (dbg) console.log(`📍 [mission] Цель: ${dbg.target} (mission=${dbg.target_mission}), корабли источника: ${JSON.stringify(dbg.maxShips)}`);

  // заполняем корабли. Если поля корабля НЕТ в форме (например, танкеры не
  // доступны для этой миссии/тела) — ПРОПУСКАЕМ этот тип (флот, который может
  // летать, должен улететь: спасение флота важнее, чем полный состав). Ошибка
  // только если в форме нет НИ ОДНОГО запрошенного типа (пустой флот).
  const missingShips = [];
  const sentShips = {};
  for (const [id, count] of Object.entries(ships)) {
    const filled = await page
      .evaluate(
        ([id, count]) => {
          const el = document.querySelector(`input[name="ship${id}"]`);
          if (el) {
            el.value = String(count);
            return true;
          }
          return false;
        },
        [id, count]
      )
      .catch(() => false);
    if (filled) sentShips[id] = count;
    else missingShips.push(id);
  }
  if (!Object.keys(sentShips).length) {
    return {
      ok: false,
      stage: 1,
      error: `Поля кораблей не найдены в форме: ${missingShips.join(", ")} — ни один тип недоступен для этой миссии/тела`,
    };
  }
  if (missingShips.length) {
    console.warn(
      `⚠️ [mission] Типы не в форме — пропускаем: ${missingShips.join(", ")} (отправляем ${JSON.stringify(sentShips)})`,
    );
  }
  if (moreFL != null) {
    await page
      .evaluate((v) => {
        const el = document.querySelector('select[name="moreFL"]');
        if (el) el.value = String(v);
      }, moreFL)
      .catch(() => {});
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      plan: {
        from: fromCp ? `cp=${fromCp}` : "home",
        target: `${target.galaxy}:${target.system}:${target.planet}`,
        mission,
        ships,
      },
    };
  }

  // --- Стадия 2: жмём [Далее] на floten1 ---
  // Токен gRPdPPPPd обычно ставится onmousedown кнопки — дублируем явно,
  // чтобы submit гарантированно прошёл.
  await page
    .evaluate(() => {
      const el = document.querySelector('form[name="floten1"] input[name="gRPdPPPPd"]');
      if (el) el.value = "pGereeeer";
    })
    .catch(() => {});
  await page.click('form[name="floten1"] [type="submit"], form[name="floten1"] button[type="submit"]');
  const form2 = await page
    .waitForSelector('form[name="floten2"]', { timeout: 25000 })
    .catch(() => null);
  if (!form2) {
    const html = await page.content();
    const err = extractError(html);
    return { ok: false, stage: 2, error: err || "Форма floten2 не найдена" };
  }

  // --- Стадия 2: координаты цели ---
  // Цель обычно подставлена сервером из URL стадии 1. Если на странице есть
  // поля galaxy/system/planet — дожимаем их значениями цели (idempotent).
  // Если полей нет — цель уже в токене, просто идём дальше.
  const filled = await page
    .evaluate((t) => {
      const f = document.querySelector('form[name="floten2"]');
      if (!f) return null;
      const out = {};
      const set = (name, val) => {
        const el = f.querySelector(`[name="${name}"]`);
        if (!el) return null;
        el.value = String(val);
        return el.value;
      };
      out.galaxy = set("galaxy", t.galaxy);
      out.system = set("system", t.system);
      out.planet = set("planet", t.planet);
      out.planet_type = set("planet_type", t.planettype || "1");
      if (out.planet_type == null) out.planet_type = set("planettype", t.planettype || "1");
      return out;
    }, target)
    .catch(() => null);
  if (filled) {
    console.log(`🎯 [mission] Цель (стадия 2): ${JSON.stringify(filled)}`);
  } else {
    console.warn("⚠️ [mission] Поля цели на стадии 2 не найдены — полагаемся на подстановку из URL");
  }

  // Скорость флота (PLAN: 10% при эвакуации)
  if (speedPercent != null) {
    const set = await page
      .evaluate((pct) => {
        const form = document.querySelector('form[name="floten2"]');
        if (!form) return false;
        for (const name of ["speed", "consumption"]) {
          const sel = form.querySelector(`select[name="${name}"]`);
          if (!sel) continue;
          for (const opt of sel.options) {
            const label = opt.textContent || "";
            if (
              label.includes(`${pct}%`) ||
              opt.value === String(pct) ||
              (pct === 10 && opt.value === "1")
            ) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
          }
        }
        return false;
      }, speedPercent)
      .catch(() => false);
    if (set) console.log(`🐢 [mission] Скорость флота: ${speedPercent}%`);
  }

  // --- Стадия 3: жмём кнопку floten2 ---
  await page.click('form[name="floten2"] [type="submit"], form[name="floten2"] button[type="submit"]');
  const form3 = await page
    .waitForSelector('form[name="floten3"]', { timeout: 25000 })
    .catch(() => null);
  if (!form3) {
    const html = await page.content();
    const err = extractError(html);
    return { ok: false, stage: 3, error: err || "Форма floten3 не найдена" };
  }

  // заполняем ресурсы (стадия 3)
  let resourcesTaken = null;
  if (resources) {
    if (resources.maxAll) {
      // Поведение кнопки «max» (которая на сервере НЕ РАБОТАЕТ — см. docstring):
      // заполнить флот ВСЕМ доступным: алмазы, уран − несгораемый keep, металл.
      // Если всего больше вместимости — пропорционально ужать до вместимости
      // («заберём только то, что влезло» — улететь важнее).
      // serverCap != null — ТОЧНАЯ вместимость из ответа сервера
      // («Недостаточно места: N» → вместимость = отправлено − N − 1);
      // иначе оценка по полям формы ship<ID> × capacity<ID>.
      const keepUranium = resources.keepUranium || 0;
      const res = await page
        .evaluate(({ keep, cap }) => {
          const f = document.querySelector('form[name="floten3"]') || document;
          const num = (v) => parseInt(String(v).replace(/\D/g, ""), 10) || 0;
          const getVal = (n) => {
            const el = f.querySelector(`[name="${n}"]`);
            return el ? num(el.value) : 0;
          };
          const avail = {
            resource1: getVal("thisresource1"),
            resource2: getVal("thisresource2"),
            resource3: getVal("thisresource3"),
          };
          // «max» + несгораемый уран: уран берём за вычетом keep (если урана
          // меньше keep — оставляем весь, берём 0).
          const want = {
            resource1: avail.resource1,
            resource2: avail.resource2,
            resource3: Math.max(0, avail.resource3 - keep),
          };
          // Вместимость флота: точная (из feedback сервера) либо оценка
          // Σ ship<ID> × capacity<ID> по полям формы.
          let capacity = null;
          if (cap != null) {
            capacity = cap;
          } else {
            let capKnown = false;
            for (const el of f.querySelectorAll("input[name^='capacity']")) {
              const shipId = el.name.replace(/^capacity/, "");
              const shipEl = f.querySelector(`input[name="ship${shipId}"]`);
              const count = shipEl ? num(shipEl.value) : 0;
              const per = num(el.value);
              if (count > 0) {
                capacity = (capacity || 0) + count * per;
                capKnown = true;
              }
            }
            if (!capKnown) capacity = null;
          }
          const totalWant =
            want.resource1 + want.resource2 + want.resource3;
          const scale =
            capacity != null && capacity > 0 && totalWant > capacity
              ? capacity / totalWant
              : 1;
          const setVal = (n, v) => {
            const el = f.querySelector(`input[name="${n}"]`);
            if (el) el.value = String(Math.floor(v));
          };
          setVal("resource1", want.resource1 * scale);
          setVal("resource2", want.resource2 * scale);
          setVal("resource3", want.resource3 * scale);
          const read = (n) => {
            const el = f.querySelector(`input[name="${n}"]`);
            return el ? num(el.value) : 0;
          };
          const r1 = read("resource1");
          const r2 = read("resource2");
          const r3 = read("resource3");
          return {
            resource1: r1,
            resource2: r2,
            resource3: r3,
            total: r1 + r2 + r3,
            avail,
            capacity: capacity,
            exact: cap != null,
            scaled: scale < 1,
          };
        }, { keep: keepUranium, cap: serverCap })
        .catch(() => null);
      resourcesTaken = res;
      console.log(
        `📦 [mission] Ресурсы (уран −${keepUranium}, ${
          serverCap != null ? `вместимость точная ${fmt(serverCap)}` : "оценка по форме"
        }): ${JSON.stringify(
          res && {
            r1: res.resource1,
            r2: res.resource2,
            r3: res.resource3,
            total: res.total,
            avail: res.avail,
            cap: res.capacity,
            scaled: res.scaled,
          },
        )}`,
      );
    } else {
      const setRes = async (name, val) => {
        if (val == null) return;
        await page
          .evaluate(([n, v]) => {
            const el = document.querySelector(`input[name="${n}"]`);
            if (el) el.value = String(v);
          }, [name, val])
          .catch(() => {});
      };
      await setRes("resource1", resources.r1);
      await setRes("resource2", resources.r2);
      await setRes("resource3", resources.r3);
      resourcesTaken = {
        resource1: Number(resources.r1) || 0,
        resource2: Number(resources.r2) || 0,
        resource3: Number(resources.r3) || 0,
        total:
          (Number(resources.r1) || 0) +
          (Number(resources.r2) || 0) +
          (Number(resources.r3) || 0),
      };
    }
  }
  if (holdingtime != null) {
    await page
      .evaluate((v) => {
        const el = document.querySelector('input[name="holdingtime"], select[name="holdingtime"]');
        if (el) el.value = String(v);
      }, holdingtime)
      .catch(() => {});
  }

  // --- Стадия 4: жмём кнопку floten3 ---
  // Сервер отвечает модалкой (успех/ошибка) + ajax_reload. Страница после
  // этого пустая (floten3.php?fleet=0), поэтому результат читаем из ТЕЛА
  // ответа, а не из контента страницы.
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("floten3.php"), { timeout: 30000 }),
    page.click('form[name="floten3"] [type="submit"], form[name="floten3"] button[type="submit"]'),
  ]);
  const body = await resp.text();
  const err = extractError(body);
  if (err) {
    const out = { ok: false, stage: 4, error: err };
    const shortage = parseCapacityShortage(err);
    if (shortage != null) out.shortage = shortage;
    if (resourcesTaken) out.total = resourcesTaken.total;
    return out;
  }

  // Успех: нет модалки-ошибки. Подтверждение — ajax_reload или текст.
  const confirmed = isAjaxReload(body) || /успешно|отправлен|в пол[её]те|вылетел/i.test(stripHtml(body));
  return {
    ok: true,
    stage: 4,
    confirmed,
    resources: resourcesTaken,
    note: confirmed ? undefined : "Без явного подтверждения — проверьте миссии в overview",
  };
}

/**
 * Отправить миссию.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} opts
 * @param {string} [opts.fromCp] — cp тела отправителя (fleet.php?cp=<cp>). Без cp — home.
 * @param {Object} opts.target — { galaxy, system, planet, planettype } (1=планета, 3=луна)
 * @param {number} opts.mission — код миссии (1/3/5/6)
 * @param {Object} opts.ships — { [shipId]: count }, например { 210: 5000 }
 * @param {Object} [opts.resources] — { r1, r2, r3 } (стадия 3) ИЛИ
 *   { maxAll: true, keepUranium: N } — поведение кнопки «max»: заполнить
 *   флот всем доступным (за вычетом несгораемого урана), уместив во вместимость.
 *   При «Недостаточно места: N» от сервера — точная коррекция вместимости
 *   и повтор (до 3 попыток). Флот гарантированно улетает.
 * @param {number} [opts.holdingtime] — время у цели (1..9)
 * @param {number} [opts.moreFL] — запасной флот % (стадия 1)
 * @param {boolean} [opts.dryRun] — только план, без отправки
 * @param {import('playwright').Page} [opts.page] — переиспользуемая страница
 * @returns {Promise<Object>} { ok, dryRun, error?, stage?, confirmed?, resources? }
 */
async function sendMission(context, opts) {
  const {
    fromCp = null,
    target,
    mission,
    ships,
    resources = null,
    holdingtime = null,
    moreFL = null,
    speedPercent = null,
    dryRun = false,
    page: myPage = null,
  } = opts;

  if (!target || !mission || !ships || !Object.keys(ships).length) {
    return { ok: false, error: "Неполные параметры: нужен target, mission, ships" };
  }

  // --- URL стадии 1 ---
  // Формат ссылки «Шпионаж» со страницы галактики: цель + миссия + корабли
  // подставляются сервером из параметров URL. ВАЖНО: нужен mode=3 (режим
  // «Отправить флот» — как в собственных ссылках игры): без него на чужом
  // теле (fromCp) форма floten1 может не содержать полей ship<ID> (проверено:
  // луна 1:918:1 без mode=3 → пустая форма, с mode=3 → поля есть).
  // Если задан fromCp (тело-источник, например луна) — сначала пробуем с cp;
  // не сработает — как есть (источник = home).
  const q = new URLSearchParams();
  q.set("mode", "3");
  q.set("galaxy", target.galaxy);
  q.set("system", target.system);
  q.set("planet", target.planet);
  q.set("planettype", target.planettype || "1");
  q.set("target_mission", mission);
  for (const [id, count] of Object.entries(ships)) q.set(String(id), String(count));
  const targetQ = q.toString();
  const urls = [];
  if (fromCp != null) urls.push(`${BASE}/fleet.php?cp=${fromCp}&${targetQ}`);
  urls.push(`${BASE}/fleet.php?${targetQ}`);

  const page = myPage || (await context.newPage());
  const owned = !myPage;

  // maxAll: до 3 попыток. Если сервер ответил «Недостаточно места для
  // погрузки: N» — N это точный избыток (вместимость = отправлено − N),
  // повторяем стадии 1–3 с точной вместимостью (отправлено − N − 1).
  // Флот ВСЕГДА улетает — спасение флота важнее ресурсов.
  const maxAttempts = !dryRun && resources && resources.maxAll ? 3 : 1;
  let serverCap = null;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await attemptMission(page, {
        fromCp, target, mission, ships, resources, holdingtime, moreFL,
        speedPercent, dryRun, serverCap, urls,
      });
      if (res.ok) return res;
      // Коррекция по вместимости: сервер сказал точный избыток.
      if (
        res.stage === 4 &&
        res.shortage != null &&
        res.total > 0 &&
        attempt < maxAttempts
      ) {
        serverCap = Math.max(0, res.total - res.shortage - 1);
        console.log(
          `📦 [mission] Недостаточно места (избыток ${fmt(res.shortage)}) → точная вместимость ${fmt(serverCap)} — повторяю (попытка ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }
      return res;
    }
    return {
      ok: false,
      stage: 4,
      error: "Коррекция вместимости не сошлась (3 попытки)",
    };
  } finally {
    if (owned) await page.close().catch(() => {});
  }
}

/**
 * Отозвать активную миссию (флот возвращается на тело-источник).
 * Форма на fleet.php: <form name="fleetback_<id>" action="fleetback.php">
 *   <input name="fleetid" value="<id>"> + [Отозвать]
 * @param {import('playwright').BrowserContext} context
 * @param {string|number} fleetId — id флота (из parseActiveMissions)
 * @param {Object} [opts] — { dryRun }
 * @returns {Promise<Object>} { ok, error? }
 */
async function recallMission(context, fleetId, opts = {}) {
  const { dryRun = false } = opts;
  if (dryRun) return { ok: true, dryRun: true };
  const res = await postForm(context, "/fleetback.php", { fleetid: String(fleetId) }, {
    referer: `${BASE}/fleet.php`,
  });
  if (res.status !== 200) return { ok: false, error: `HTTP ${res.status}` };
  const err = extractError(res.html);
  if (err) return { ok: false, error: err };
  return { ok: true };
}

module.exports = { sendMission, recallMission, parseCapacityShortage };

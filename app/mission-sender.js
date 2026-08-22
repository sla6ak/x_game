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
 *             → страница с формой floten1. Заполняем ship<ID>, жмём [Далее].
 *   Стадия 2: страница с формой floten2 (hidden usedfleet — токен флота). Жмём кнопку.
 *   Стадия 3: страница с формой floten3 (mission, resource1/2/3, holdingtime).
 *             Заполняем ресурсы (если нужно), жмём кнопку.
 *   Стадия 4: ajax_reload / новая страница. Успех: без модалки «Ошибка ...».
 *
 * Коды миссий (target_mission): 1=Атака, 3=Транспорт, 5=Защита, 6=Шпионаж
 * Коды кораблей (ship<ID>): 203 Танкер, 208 Колонизатор, 206 Крейсер,
 *   207 Линкор, 210 Шпионский зонд
 */

const { BASE } = require("./http");
const { extractError, isAjaxReload, stripHtml } = require("./parse-form");

/**
 * Отправить миссию.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} opts
 * @param {string} [opts.fromCp] — cp тела отправителя (fleet.php?cp=<cp>). Без cp — home.
 * @param {Object} opts.target — { galaxy, system, planet, planettype } (1=планета, 3=луна)
 * @param {number} opts.mission — код миссии (1/3/5/6)
 * @param {Object} opts.ships — { [shipId]: count }, например { 210: 5000 }
 * @param {Object} [opts.resources] — { r1, r2, r3 } (стадия 3, для транспорта/атаки)
 * @param {number} [opts.holdingtime] — время у цели (1..9)
 * @param {number} [opts.moreFL] — запасной флот % (стадия 1)
 * @param {boolean} [opts.dryRun] — только план, без отправки
 * @param {import('playwright').Page} [opts.page] — переиспользуемая страница
 * @returns {Promise<Object>} { ok, dryRun, error?, stage?, confirmed? }
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
    dryRun = false,
    page: myPage = null,
  } = opts;

  if (!target || !mission || !ships || !Object.keys(ships).length) {
    return { ok: false, error: "Неполные параметры: нужен target, mission, ships" };
  }

  // --- URL стадии 1 ---
  const q = new URLSearchParams();
  q.set("galaxy", target.galaxy);
  q.set("system", target.system);
  q.set("planet", target.planet);
  q.set("planettype", target.planettype || "1");
  q.set("target_mission", mission);
  for (const [id, count] of Object.entries(ships)) q.set(String(id), String(count));
  const url = `${BASE}/fleet.php?${q.toString()}`;

  const page = myPage || (await context.newPage());
  const owned = !myPage;
  try {
    // --- Стадия 1: страница флота ---
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    let form1 = await page
      .waitForSelector('form[name="floten1"]', { timeout: 25000 })
      .catch(() => null);
    if (!form1) {
      const html = await page.content();
      const err = extractError(html);
      return { ok: false, stage: 1, error: err || "Форма floten1 не найдена" };
    }

    // заполняем корабли
    for (const [id, count] of Object.entries(ships)) {
      await page.evaluate(
        ([id, count]) => {
          const el = document.querySelector(`input[name="ship${id}"]`);
          if (el) el.value = String(count);
        },
        [id, count]
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
    await page.click('form[name="floten1"] [type="submit"], form[name="floten1"] button[type="submit"]');
    const form2 = await page
      .waitForSelector('form[name="floten2"]', { timeout: 25000 })
      .catch(() => null);
    if (!form2) {
      const html = await page.content();
      const err = extractError(html);
      return { ok: false, stage: 2, error: err || "Форма floten2 не найдена" };
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

    // заполняем ресурсы (стадия 3) — только если заданы
    if (resources) {
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
    if (err) return { ok: false, stage: 4, error: err };

    // Успех: нет модалки-ошибки. Подтверждение — ajax_reload или текст.
    const confirmed = isAjaxReload(body) || /успешно|отправлен|в пол[её]те|вылетел/i.test(stripHtml(body));
    return {
      ok: true,
      stage: 4,
      confirmed,
      note: confirmed ? undefined : "Без явного подтверждения — проверьте миссии в overview",
    };
  } finally {
    if (owned) await page.close().catch(() => {});
  }
}

module.exports = { sendMission };

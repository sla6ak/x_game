/**
 * expedition.js — запуск экспедиций из 1-й луны планеты 1:363:6.
 *
 * Архитектура:
 *  - getExpeditionPlan(): надёжный план по raw-HTML (слоты, корабли дока).
 *  - launchExpeditions(): выполняет план. dryRun=true → только лог (без отправки).
 *  - doRealLaunch(): реальная отправка через браузер (формы floten1 → цель).
 *
 * ВАЖНО: по умолчанию dryRun=true — бот НИЧЕГО не отправляет, только логирует.
 * Включать реальную отправку только после проверки плана.
 */

const { fetchHtml } = require("./http");
const { parseFleet } = require("./parse-fleet");
const { blockResources, BASE } = require("./session-manager");

/**
 * Построить план экспедиции по raw-HTML флот-страницы луны.
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 */
async function getExpeditionPlan(context, config) {
  const moonCp = config.expedition.fromMoonCp;
  const html = await fetchHtml(context, `/fleet.php?cp=${moonCp}`);
  const fleet = parseFleet(html);

  const shipName = config.expedition.shipName;
  const shipId = config.shipIds ? config.shipIds[shipName] || null : null;
  const dockShip = (fleet.dockShips || []).find(
    (s) => s.name === shipName,
  );

  return {
    fromMoonCp: moonCp,
    fromCoords: fleet.coords,
    maxSlots: fleet.maxepedition,
    usedSlots: fleet.curepedition,
    freeSlots: fleet.freeSlots || 0,
    target: config.expedition.targets[0],
    shipName,
    shipId,
    shipCount: config.expedition.shipCount,
    availableShips: dockShip ? dockShip.available : 0,
    dryRun: config.expedition.dryRun,
  };
}

/**
 * Запустить экспедиции (dry-run или реальная отправка).
 * @param {import('playwright').BrowserContext} context
 * @param {Object} config
 * @returns {Promise<Object|null>} план или null если слоты заняты
 */
async function launchExpeditions(context, config) {
  const plan = await getExpeditionPlan(context, config);

  if (plan.freeSlots <= 0) {
    console.log(
      `🧪 [expedition] Слоты заняты (${plan.usedSlots}/${plan.maxSlots}) — ждём.`,
    );
    return null;
  }

  console.log(`🚀 [expedition] Свободных слотов: ${plan.freeSlots}. План:`);
  console.log(`   Откуда: ${plan.fromCoords} (cp=${plan.fromMoonCp})`);
  console.log(`   Куда:     ${plan.target}`);
  console.log(
    `   Корабль:  ${plan.shipName} (id=${plan.shipId}), кол-во=${plan.shipCount}, в доке=${plan.availableShips}`,
  );

  if (plan.dryRun) {
    console.log(`🏃 [expedition] DRY-RUN: отправка НЕ выполняется.`);
    return plan;
  }

  // Реальная отправка (браузер)
  await doRealLaunch(context, config, plan);
  return plan;
}

/**
 * Реальная отправка экспедиции через браузер.
 * Этап 1: fleet.php?cp=<moon> → форма floten1 (корабли + moreFL) → "Далее"
 * Этап 2: страница выбора цели (координаты + тип миссии = Экспедиция) → подтверждение
 *
 * ВНИМАНИЕ: многошаговый flow, структура страницы цели может отличаться.
 * Функция best-effort: логит каждый шаг, не бросает исключение на неудачу.
 */
async function doRealLaunch(context, config, plan) {
  const page = await context.newPage();
  try {
    await blockResources(page);

    // --- Этап 1: флот-страница луны ---
    console.log(`📄 [expedition] Открываю fleet.php?cp=${plan.fromMoonCp}`);
    await page.goto(`${BASE}/fleet.php?cp=${plan.fromMoonCp}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    // Ждём появления ship-инпутов (они рендерятся JS)
    const shipId = plan.shipId;
    if (!shipId) {
      console.error(
        `❌ [expedition] Неизвестный shipId для "${plan.shipName}" — добавьте в config.shipIds.`,
      );
      return;
    }

    // Заполняем количество кораблей (ship<id>)
    const filled = await page
      .evaluate(
        ({ shipId, count }) => {
          const input = document.querySelector(`input[name="ship${shipId}"]`);
          if (!input) return false;
          const maxEl = document.getElementById(`maxship${shipId}`);
          const max = maxEl ? parseInt(maxEl.value, 10) : 0;
          const val = count === "all" ? max : Math.min(parseInt(count, 10), max);
          input.value = String(val || 0);
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        },
        { shipId, count: plan.shipCount },
      )
      .catch(() => false);

    if (!filled) {
      console.error(
        `❌ [expedition] Не найден ship-инпут ship${shipId} (корабли рендерятся JS, страница могла уйти в about:blank).`,
      );
      return;
    }
    console.log(`✅ [expedition] Заполнено ship${shipId} (count=${plan.shipCount}).`);

    // moreFL = 0 (без дополнительных флотов)
    await page
      .evaluate(() => {
        const sel = document.querySelector('select[name="moreFL"]');
        if (sel) {
          sel.value = "0";
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      })
      .catch(() => {});

    // Нажимаем "Далее" (submit floten1)
    console.log(`📤 [expedition] Отправляю форму floten1 (Далее)...`);
    await page
      .evaluate(() => {
        const form = document.querySelector('form[name="floten1"]');
        if (!form) throw new Error("Форма floten1 не найдена");
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      })
      .catch((e) => {
        console.error(`❌ [expedition] Не удалось отправить форму: ${e.message}`);
        return;
      });

    // Ждём страницу выбора цели
    await page
      .waitForLoadState("domcontentloaded", { timeout: 15000 })
      .catch(() => {});

    console.log(`📄 [expedition] Текущий URL после "Далее": ${page.url()}`);

    // --- Этап 2: выбор цели (best-effort) ---
    // Структура страницы цели не подтверждена — логим что есть.
    const targetInfo = await page
      .evaluate(() => {
        const galaxy = document.querySelector('input[name="galaxy"]');
        const system = document.querySelector('input[name="system"]');
        const planet = document.querySelector('input[name="planet"]');
        const mission = document.querySelector('select[name="mission"]');
        return {
          hasGalaxy: !!galaxy,
          hasSystem: !!system,
          hasPlanet: !!planet,
          hasMissionSelect: !!mission,
          missionOptions: mission
            ? [...mission.options].map((o) => ({ v: o.value, t: o.text }))
            : [],
        };
      })
      .catch(() => null);

    if (targetInfo) {
      console.log(
        `🔎 [expedition] Страница цели: galaxy=${targetInfo.hasGalaxy} system=${targetInfo.hasSystem} planet=${targetInfo.hasPlanet} missionSelect=${targetInfo.hasMissionSelect}`,
      );
      if (targetInfo.missionOptions.length) {
        console.log(
          `   Миссии: ${targetInfo.missionOptions
            .map((o) => `${o.v}=${o.t}`)
            .join(", ")}`,
        );
      }
    }

    console.log(
      `⚠️ [expedition] Этап 2 (выбор цели) — best-effort. Проверьте вручную и доработайте doRealLaunch под реальную структуру.`,
    );
  } catch (err) {
    console.error(`❌ [expedition] Ошибка реальной отправки:`, err.message);
  } finally {
    await page.close();
  }
}

module.exports = { launchExpeditions, getExpeditionPlan };

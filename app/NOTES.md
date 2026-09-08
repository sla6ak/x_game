# АВТОФАРМ xgame-online (crazy) — наработки

URL: https://crazy.xgame-online.com/index.php?col_fleets=1
Игрок: Slabak (id=4600), база [1:363:6], текущая система галактики: 1:363

## ЗАДАЧА (от пользователя)
1. Парсить текущую систему, собрать неактивных игроков в массив, лог системы+списка.
2. Шпионить по одному неактивному (через галактику), координаты → current_goal.
3. Ждать 2 мин, открыть сообщения, найти доклад по current_goal, залогировать.
   Линкоры = ceil((Металл+Алмаз+Уран) / 1500). Жать [Атаковать] в сообщении.
4. В меню: проверить что линкоров хватает, поставить расчётное кол-во, [Далее],
   проверить координаты = current_goal, [Далее], проверить цель, отправить.
   Лог: "флот отправлен, координаты, кол-во линкоров".
5. Следующий неактивный в системе; если закончились — следующая система.
ВАЖНО: миссии отправлять с ГЛАВНОЙ ЛУНЫ. Только неактивные планеты. Только линкоры.

## КЛЮЧЕВОЕ: проблема about:blank
- Выбранная страница chrome-devtools ПЕРИОДИЧЕСКИ сбрасывается в about:blank МЕЖДУ вызовами.
- Во ВРЕМЯ вызова evaluate_script страница стабильна (проверено поллом 24 сек).
- Навигация в странице (location.href=...) УБИВАЕТ execution context → ошибка
  "Execution context was destroyed". Hash-навигация (location.hash=...) context НЕ убивает.
- СТРАТЕГИЯ: navigate_page перед каждым шагом; весь шаг = один evaluate_script.
  Внутри шага: fetch (без навигации) + location.hash (SPA) — context живёт.
- ПОЛНАЯ навигация (POST формы) убивает context — но мы POSTим через fetch(),
  поэтому context НЕ умирает. Весь цикл можно гонять без пересоздания контекста.

## DOM Галактики (#galaxy.php?mode=0)
- Таблица внутри #modal-content, заголовок строки содержит "Альянс".
- Строка: cells[0]=позиция, a[href*="user.php?id=PID"] = имя игрока.
- НЕАКТИВНЫЕ: span с классом `lolonginactive` (долгосрочные, туп "Неактивен: 257д")
  или `i_inactive` (короткосрочные). Внутри ссылки user.php.
- Быстрые кнопки: a[title="Шпионаж планеты"] onclick="doit(6, G, S, P, 1, 5000001, 0)"
  a[title="Шпионаж луны"] planettype=3.
  НО: у части неактивных (btrhtr, Fractal33) ссылки шпионажа НЕТ — их пропускать.
- Навигация по системам: hash `galaxy.php?mode=1&galaxyGO=<G>&systemGO=<S±N>`
  (ссылки -100/-10/-1/+1/+10/+100 в форме "Скачать").
- 1:363 неактивные с планетой: Aeon[3], fenixS48[5], Quasar[7], (btrhtr[8] без кнопки),
  Golileo45[10], (Fractal33[14] без кнопки). i_inactive: Trust[11], alexalsp[15].

## doIt() из main.js (быстрые действия)
POST flotenajax.php?action=send, Content-Type: application/x-www-form-urlencoded:
  mission=6 (шпионаж) | galaxy=G&system=S&planet=P&planettype=1|3
  &ship210=<зонды>&ship209=0&myOtherPlanet=<опц>&rndval=<ts>
Ответ JSON: {message, target:{g,s,p,type}, ...}. Ошибка: {code, message}.
mission=1 = атака. Значение 5000001 у ship210 = БУКВАЛЬНО 5 000 001 зонд (дефолт кнопки).

## ФОРМА ФЛОТА stage1 (#fleet.php?galaxy=G&system=S&planet=P&planettype=1&target_mission=1|6&210=N)
- action=floten1.php, method=POST.
- Скрытые: galaxy, system, planet, planet_type, mission, target_mission,
  gYsDssDsDsY (ТОКЕН сессии — ДАВЕТСЯ: "Вы долго отсутствовали на предыдущей странице!"
  если форма пролежала >несколько минут — ТОКЕН ПРОСРОЧИВАЕТСЯ, надо открывать форму заново),
  maxship207 (доступно линкоров, было 534 178 268), capacity207=1530 (ВМЕСТИМОСТЬ ЛИНКОРА),
  consumption207=1000, speed207=1100, art_207, col_lvl207=5,
  ship207 (линкор/liner), ship210 (зонд, capacity 40), ship209 (рециклер),
  ship206 (крейсер), ship211/216/217 (прочие).
- Кнопки: [Далее] (submit), [Обнулить все корабли], [Отменить].
- URL-параметр 210=1000 НЕ заполнял поле (value=0) — значение надо ставить в input сами.
- Ссылка [Атаковать] из сообщения: #fleet.php?galaxy=G&system=S&planet=P&planettype=1&s=1&target_mission=1&202=<playerId>&203=<planetId>
  (s=1 = источник по умолчанию; 202/203 = id игрока/планеты цели).

## STAGE2 (ответ POST floten1.php) — УТОЧНЕНО по mission-sender.js
Реальный flow (подтверждён тестами, см. docstring mission-sender.js):
  Стадия 1: GET fleet.php?cp=<fromCp>&mode=3&galaxy=...&target_mission=M → форма floten1
            (fromCp = тело-источник, например главная луна cp=31694; без cp = home)
            ВАЖНО: mode=3 ОБЯЗАТЕЛЕН — без него на теле-источнике (fromCp) форма
            floten1 может не содержать полей ship<ID> (проверено: луна 1:918:1 cp=31750
            без mode=3 → пусто, с mode=3 → ship/maxship/capacity есть). Home-луна
            работает и без mode=3, но с ним — тоже.
  Стадия 2: форма floten2 (hidden usedfleet — токен флота) → [Далее]
  Стадия 3: форма floten3 (mission, resource1/2/3, holdingtime) → [Отправить]
  Успех: без модалки «Ошибка».
  ВАЖНО: JS на submit подменяет поля (consumption, mission 5→6, gRPdPPPPd→pGereeeer,
  holdingtime) — поэтому sendMission идёт через реальный браузер (goto+fill+click),
  не raw-HTTP. Токен формы живёт недолго — стадии идут подряд без пауз.

## СТЫК «max» И ВМЕСТИМОСТЬ (стадия 3, проверено вживую 2026-09-08)
- Ссылки «max»/«Взять все ресурсы» (maxResource(1/2/3), maxResources()) на стадии 3
  НЕ РАБОТАЮТ: JS-функции в HTML НЕ ОПРЕДЕЛЕНЫ (страница содержит только
  getStorageFaktor). «max» воспроизводим сами из hidden-полей thisresource1/2/3
  (доступные ресурсы тела).
- Реальная вместимость, которую проверяет СЕРВЕР, МЕНЬШЕ суммы ship<ID>×capacity<ID>
  из формы: 10 линкоров — форма 15300, сервер 15201; 20 — 30600/30403;
  100 — 153000/152019 (≈ −0.65%). Избыток отклоняется ошибкой
  «Недостаточно места для погрузки: N», где N = отправлено − вместимость (ТОЧНО).
  Число в ошибке может содержать &nbsp;-разделители (1&nbsp;147&nbsp;349&nbsp;745).
- Исправление в mission-sender.js (maxAll): первая попытка по оценке вместимости;
  при «Недостаточно места: N» — стадии 1–3 повторяются с точной вместимостью
  (отправлено − N − 1), до 3 попыток. Флот всегда улетает.
- Миссия «Транспорт» (3) требует загрузить ресурсы («При миссии транспорт
  необходимо загрузить в трюмы какие-либо ресурсы!»). Вернуть флот с ПУСТОЙ луны
  — mission=4 («Оставить») на главную луну (флот прибудёт и останется там).
- Луна 1:918:1: planet cp=26308, moon cp=31750 (из overview: switch_planet в блоке
  moon-pl). cp луны из overview: desktop-формат, блок тела → div.moon-pl →
  switch_planet(<cp>); mobile-формат — <option value="?cp=<cp>&...">[координаты]</option>.

## СООБЩЕНИЯ
- Ссылки: #messages.php?mode=show&messcat=100&rand=931 (категория messcat=100 = ?)
- Формат доклада (пример пользователя):
  "Шпионский доклад «malmol» с планеты [1:400:15]
     Металл 67 812 031 448 745 Алмаз 13 612 131 505 090
     Уран 13 484 235 130 303"
  Числа с пробелами-разделителями. farm.js пробует URL:
  messages.php?category=spy | ?category=3 | ?messcat=3 | messages.php
  ПРОВЕРИТЬ: какой URL реально отдаёт шпионские доклады.
- В докладе есть ссылка/кнопка [Атаковать] (a[href*="target_mission=1"] с galaxy/system/planet).

## РЕСУРСЫ ИГРОКА (на момент разведки)
Металл 39 484 910 586, Алмаз 54 875 732 633, Уран 17 980 803 547
Корабли: линкоры 534 178 268, зонды 164 060 847, рециклеры 8 936 528, кр. 1 733 869
Флотов в пути: 609 (много "Ишкофарм" в 918:4)

## РЕАЛИЗАЦИЯ (итог): app/farm.js — модуль бота (Playwright)
Всё в app/ (корневой farm.js удалён — не дублировать).
app/farm.js = полный цикл, вызывается из bot-loop: runFarmCycle(context, config, missionsData).
Состояние: dataStore.state.farm {queue[], current_goal, pendingReport, scanSystem, attacked{}, failed{}}
— переживает рестарты (data/bot-state.json), не блокирует луп (отчёт ждём по тикам).

Цикл:
1. Свободные слоты резерва (farmReserveSlots из bot-controls.json).
2. Скан системы: home.system → +1..systemRange (циклично), getSystem/switchSystem,
   findInactiveTargets (неактивные планеты, без наших тел/занятых координат/кулдауна farmCooldownMs),
   лог системы + списка неактивных.
3. current_goal = queue[0] → spyTargets (шпионы, только неактивные планеты),
   pendingReport = {coords, spiedAt}.
4. Через reportGraceMs (120с) — findSpyReport: messages.php?mode=show&messcat=100 →
   parseMessages → первый шпионский отчёт по координатам → тело
   (messages.php?mode=show&messcat=100&rand=<id> или ?id=<id>) →
   parseReportResources: Металл/Алмаз/Уран → линкоры = ceil((M+A+U)/1500).
5. Атака: sendMission(mission=1, ships={207: N}, fromCp=config.farm.fromMoonCp=31694)
   — СТРОГО с главной луны, только линкоры. Лог: "ФЛОТ ОТПРАВЛЕН: [coords], линкоров: N".
6. finishTarget: цель из queue, attacked[coords]=ts (кулдаун 12ч), save.

Конфиг config.json → farm: {fromMoonCp:31694 (главная луна), probeCount:5000,
typeFL:207, reportGraceMs:120000, maxSystemWaitMs:1200000, systemRange:30,
minBattleships, farmCooldownMs:43200000, dryRun:false, includeVacation:false}
bot-controls.json: farm=false (СЕЙЧАС ВЫКЛЮЧЕН — включить: farm=true), farmReserveSlots:25.

Экспорт: { runFarmCycle, findSpyReport, parseReportResources, LINER_CAPACITY }

## ЧТО ПРОВЕРИТЬ ПЕРВЫМ ДЕЛОМ (следующая сессия)
1. bot-controls.json → farm=true; запуск node serverXG.js; логи [farm].
2. ПРОВЕРИТЬ: URL тела сообщения (rand=<id> vs id=<id>) — какой реально отдаёт
   шпионский отчёт (findSpyReport пробует оба).
3. ПРОВЕРИТЬ: parseReportResources на реальном докладе (формат чисел с пробелами).
4. ПРОВЕРИТЬ: что sendMission с fromCp=31694 реально отправляет с главной луны
   (стадия 2 = выбор источника? у sendMission flow 3 стадии — проверить что
   fromCp подставляется как тело-источник, а не как цель).
5. Точность доклада: 5000 зондов (probeCount) — если ≈, увеличить probeCount.
6. dryRun: farm.dryRun=false уже стоит — реально отправит.

## РИСКИ
- Точность доклада: 5000 зондов (probeCount) — если ≈, увеличить.
- fromCp=31694: проверить что это именно главная луна (config: moonCp=31694 ✓).
- Двойная атака при рестарте: protected attacked[] кулдауном farmCooldownMs (12ч).
- URL тела сообщения (rand= vs id=) — не подтверждено, findSpyReport пробует оба.

## КАРТА КОРАБЛЕЙ (проверено вживую, форма fleet.php?cp=31694)
Вместимости — из overlib-тултипов формы (Вместимость: N), вместимость танкера —
со страницы строительства buildings.php?mode=fleet&gid=203 («Вместимость трюмов: 25 500»,
базовая 25000).

| ID  | Название            | Вместимость |
|-----|---------------------|-------------|
| 203 | Большой танкер      | 25000       |
| 206 | Крейсер             | 816         |
| 207 | Линкор              | 1530 (формула фарма: 1500) |
| 208 | Колонизатор         | 10200       |
| 209 | Переработчик        | 20400       |
| 210 | Шпионский зонд      | 5           |
| 211 | Броненосец          | 612         |
| 215 | Линейный крейсер    | 765         |
| 216 | Эсминец             | 1020        |
| 217 | Авианосец           | 153000      |

Важно: ship203 (танкер) НЕТ ни в одной миссионной форме (target_mission=1..6,15 —
только 206/207/208/209/210/211/215/216/217), ни с cp=31694, ни с home. Танкеры
есть в доке (154 млрд), но стандартной формой не отправляются. Поэтому в
mission-sender.js guard: если поле ship<ID> не найдено в форме — ошибка
«Поля кораблей не найдены в форме», а не тихая отправка пустого флота.

## ВЫБОР ТИПА КОРАБЛЯ (живая страница /controls)
Блоки: АВТОФАРМ (farm, farmReserveSlots, farmShipName), ЭКСПЕДИЦИИ
(expedition, expeditionShipName, expeditionShipCount), СЕЙФ (safety).
- farmShipName: Линкор | Авианосец | Большой танкер (FARM_SHIP_NAMES).
- expeditionShipName: Линкор | Броненосец | Эсминец | Авианосец | Крейсер | Линейный крейсер
  (EXPEDITION_SHIP_NAMES).
- bot-controls.json: farmShipName, expeditionShipName — валидируются списками
  в helpers/config.js (loadBotControls/saveBotControls), невалидный → «Линкор».
- bot-loop.js мержит в config.farm.shipName / config.expedition.shipName.
- farm.js: shipId = config.shipIds[shipName] (fallback fc.typeFL||207),
  capacity = config.shipCapacities[shipName] (fallback 1500), count = ceil(total/capacity).
- expedition.js: shipId = config.shipIds[shipName] (уже было), config.shipIds
  дополнен всеми 9 типами.
- config.json: shipIds (9 кораблей) + shipCapacities (9 кораблей).
- app/web/controls/index.js: renderControlsPage (fieldset'ы), resolveControlsFromBody
  (парсит farmShipName/expeditionShipName), handleControlsRequest (GET/POST).

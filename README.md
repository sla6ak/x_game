# serverXG

Серверный бот на Node.js + Playwright для веб-игры (crazy.xgame-online.com).
Автоматизирует: сбор и анализ миссий, безопасность флота (сейв/эвакуация),
автофарм ресурсов (шпионаж → «Ишкофарм»), автоэкспедиции.

## Архитектура

```
serverXG.js — точка входа: браузер → сессия → bot-loop (+ health-сервер для Render)

app/
  bot-loop.js       главный цикл: миссии → сейв → фарм → экспедиции
  missions.js       сбор/хранение/анализ миссий (overview.php, read-only)
  fleet-safety.js   безопасность флота: эвакуация под атаку, возврат домой
  farm.js           автофарм: условия → ротация систем → шпионаж → Ишкофарм
  expedition.js     автоэкспедиции (dry-run по умолчанию)
  spy.js            отправка шпионских зондов на неактивные цели
  galaxy.js         галактика: обзор системы, смена системы, поиск целей
  mission-sender.js универсальная отправка миссий через браузер (floten1→3)
  fleet-state.js    положение основного флота (home-moon / safe-moon)
  bodies.js         реестр наших тел (планеты/луны с cp)
  session-manager.js логин, восстановление сессии (session.json)
  data-store.js     состояние бота (data/bot-state.json)
  http.js           raw-HTML запросы (fetchHtml/postForm, cookies сессии)
  logger.js         логирование ошибок (.errors)

  parsers/          парсинг raw-HTML страниц
    overview.js     overview.php: home, миссии, атаки
    fleet.js        fleet.php: слоты, корабли, активные флоты
    galaxy.js       galaxy.php: планеты системы, статусы, действия
    messages.js     messages.php: доклады, шпионские отчёты
    forms.js        универсальный парсер форм + разбор ошибок в ответах

  helpers/          переиспользуемые функции
    html.js         stripHtml
    coords.js       normalizeCoords / splitCoords
    config.js       loadConfig (config.json)
    async.js        delay
    browser.js      blockResources (Playwright)

scripts/            dev-утилиты (не часть бота)
  analyze-pages.js  анализ HTML-структуры страниц → debug/
  test-expedition.js ручной тест отправки экспедиции

debug/              снапшоты страниц для отладки парсеров (см. debug/README.md)
data/bot-state.json состояние бота (миссии, атаки, farm, safety, mainFleet)
session.json        cookies сессии
```

Ключевые принципы:

- Страницы overview.php / fleet.php рендерятся в `about:blank` (frames-интерфейс),
  поэтому бот читает **raw-HTML через `context.request`** (cookies сессии), а не DOM.
- Отправка миссий — только через реальный браузер (серверная JS-магия на submit),
  см. `mission-sender.js`.
- `dryRun` по умолчанию: safety/expedition ничего не отправляют, только логируют.

## Запуск

```bash
npm install        # postinstall автоматически установит chromium
npm start          # = node serverXG.js
```

Переменные окружения:

| Переменная | Значение | Описание |
|---|---|---|
| `HEADLESS` | `1`/`0` | Режим браузера. Не задан → авто (headless, если нет `DISPLAY`) |
| `PORT` | число | Если задан — поднимается health-сервер на `/health` (нужно для Render) |

Ошибки пишутся в консоль и в корневой файл `.errors` (см. `app/logger.js`).

## Конфигурация

Все настройки — в `config.json` (тестовые креды, секреты намеренно не скрываются):

- `home`, `planetCp`, `moonCp` — база и cp-идентификаторы
- `farm` — автофарм: слоты/линкоры-пороги, кулдауны, окно систем (`systemRange`)
- `safety` — сейв: `warnBeforeMs`, `keepUranium`, `dryRun`
- `expedition` — экспедиции: цель, корабль, `dryRun`
- `shipIds` — id кораблей (203 Танкер, 206 Крейсер, 207 Линкор, 208 Колонизатор, 210 Зонд)

## Деплой на Render.com

1. Запушьте репозиторий на GitHub.
2. На Render: **New → Blueprint** → выберите репозиторий (берёт `render.yaml`).
3. Готово: сборка (`npm install` + зависимости chromium) и запуск (`npm start`, `HEADLESS=1`).

Особенности:

- **Браузер headless** — на Render нет дисплея.
- **Health-эндпоинт** — Render Web Service требует открытый порт; бот слушает `$PORT`
  и отвечает на `/health` (статус + последний тик).
- **Файловая система эфемерная** — `session.json` и `data/bot-state.json`
  сбрасываются при редеплое; бот перелогинивается по креденшелам из `config.json`.
- Бесплатный тариф спинаунит web-сервис после ~15 минут без трафика —
  для 24/7 бота нужен платный инстанс (Starter, $7/мес).

## Лицензия

MIT.

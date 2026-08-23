# debug/ — снапшоты страниц игры

Эталонные образцы raw-HTML страниц crazy.xgame-online.com для разработки и
отладки парсеров (`app/parsers/`). Файлы `*-raw.json` — сырые захваты
(JSON-обёртка), `*.html` — тот же HTML в читаемом виде.

Генерация/обновление: `node scripts/analyze-pages.js`
(пишет `overview/overview.html`, `fleet/fleet.html`, `forms/floten1.html`,
`movement/movement.html`).

## Структура

| Каталог | Страница | Файлы |
|---|---|---|
| `overview/` | overview.php (миссии, тела) | `overview.html` (21.08), `overview-live.html` (23.08, свежий), `overview-raw.json` |
| `fleet/` | fleet.php?cp=… (флот тела) | `fleet.html` — планета (21.08), `fleet-moon.html` — луна (21.08), `fleet-live.html` (23.08, свежий), `fleet-home-live.html` (21.08 20:32), `fleet-raw.json`, `fleet-moon-raw.json`, `fleet-home-planet.png` (скриншот) |
| `galaxy/` | galaxy.php (обзор системы) | `galaxy.html` — mode=0 (21.08), `galaxy-switch.html` — mode=1 смена системы (21.08), `galaxy-363-live.html`/`.json` (21.08 15:48), `galaxy-raw.json`, `galaxy-switch-raw.json` |
| `messages/` | messages.php (доклады) | `messages.html` (21.08), `messages-live.html` (22.08), `messages-desktop.html` (23.08, desktop-формат), `messages-post-pm0.html` (23.08, POST pageMess=0 — полная панель со 100 докладами и «Ишкофарм»), `messages-raw.json` |
| `forms/` | формы отправки флота | `floten1-error.html` — образец модалки «Ошибка» (на который опирается `extractError`) |
| `movement/` | движение флота | `movement.html` — устаревший образец (30.05), подход movement.php больше не используется (миссии читаются из overview.php) |

## Примечания

- `mission-sender.js` при неудачной отправке сохраняет страницу стадии 2 в
  `debug/forms/floten2-debug-<g>-<s>-<p>.html`.
- Каталог `decoded/` удалён: содержал полные дубликаты `debug-*.html`
  (md5 совпадают).

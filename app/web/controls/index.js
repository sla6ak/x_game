/**
 * Live controls page for the bot.
 *
 * Purpose:
 *   - switch farm/expedition/safety on and off at runtime
 *   - persist state in bot-controls.json
 *   - avoid editing config.json manually during a live session
 *
 * Local access:
 *   http://localhost:<PORT>/controls
 *
 * Future extension ideas:
 *   - pause all toggles, dry-run toggle, cycle override, per-mode timers,
 *     manual target list, JSON API /controls/status
 */
const { saveBotControls, loadBotControls } = require("../../helpers/config");

const CONTROL_FIELDS = [
  { key: "farm", label: "Автофарм ресурсов" },
  { key: "expedition", label: "Автоэкспедиции" },
  { key: "safety", label: "Автосейф флота" },
];

function resolveControlsFromBody(body = "") {
  const params = new URLSearchParams(body);
  return {
    farm: params.has("farm"),
    expedition: params.has("expedition"),
    safety: params.has("safety"),
  };
}

function renderControlsPage(state = loadBotControls()) {
  const rows = CONTROL_FIELDS.map(
    ({ key, label }) => `
      <label class="row">
        <input type="checkbox" name="${key}" ${state[key] ? "checked" : ""}>
        <span>${label}</span>
      </label>
    `,
  ).join("");

  return `<!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8" />
        <title>Bot controls</title>
        <style>
          body { font-family: sans-serif; max-width: 480px; margin: 40px auto; background: #101827; color: #eef2ff; }
          .card { background: #1f2937; border-radius: 14px; padding: 24px; box-shadow: 0 12px 32px rgba(0,0,0,.25); }
          h1 { margin-top: 0; font-size: 28px; }
          .row { display: flex; align-items: center; gap: 12px; margin: 16px 0; font-size: 18px; }
          input[type="checkbox"] { width: 22px; height: 22px; }
          button { margin-top: 12px; width: 100%; padding: 12px; border: none; border-radius: 10px; background: #4f46e5; color: white; font-size: 16px; cursor: pointer; }
          .note { margin-top: 18px; color: #cbd5e1; font-size: 13px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Управление ботом</h1>
          <form method="POST" action="/controls">
            ${rows}
            <button type="submit">Сохранить</button>
          </form>
          <div class="note">Флаги сохраняются в bot-controls.json и читаются ботом на каждом тике.</div>
          <div class="note">Локально: http://localhost:&lt;PORT&gt;/controls</div>
        </div>
      </body>
    </html>`;
}

function handleControlsRequest(req, res) {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const nextState = saveBotControls(resolveControlsFromBody(body));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderControlsPage(nextState));
    });
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderControlsPage());
}

module.exports = {
  CONTROL_FIELDS,
  renderControlsPage,
  resolveControlsFromBody,
  handleControlsRequest,
};

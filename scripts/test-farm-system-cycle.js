const assert = require("assert");
const fs = require("fs");
const farm = require("../app/farm");
const { parseGalaxy, filterInactive } = require("../app/parsers/galaxy");
const { filterSpyReports } = require("../app/parsers/messages");

const galaxyHtml = fs.readFileSync(
  "./debug/galaxy/galaxy-363-live.html",
  "utf8",
);
const galaxy = parseGalaxy(galaxyHtml);
const switched = parseGalaxy(
  fs.readFileSync("./debug/galaxy/galaxy-switch.html", "utf8"),
);
assert.strictEqual(
  switched.system,
  "364",
  "the active system must come from the page being switched to, not from earlier navigation links",
);
assert.ok(
  galaxy.planets.some((p) =>
    ["inactive", "i_inactive", "longinactive", "lolonginactive"].includes(
      p.status,
    ),
  ),
  "the snapshot must still contain at least one real inactive target",
);
assert.ok(
  !filterInactive(galaxy.planets, { includeVacation: false }).some(
    (p) => p.player === "Fractal33",
  ),
  "players in vacation mode must be excluded from autofarm targets",
);
assert.ok(
  !filterInactive(galaxy.planets, { includeVacation: false }).some(
    (p) => p.player === "reader",
  ),
  "pure vacation players must remain excluded from autofarm targets",
);
assert.ok(
  !galaxy.planets.some((p) => p.player === "reader"),
  "vacation players must not enter the parsed galaxy target list at all",
);
assert.ok(
  !galaxy.planets.some((p) => p.player === "Fractal33"),
  "inactive+vacation players must also be excluded from the parsed list",
);

const systems = farm.getSystemWindow(363, 30);
assert.strictEqual(systems[0], 333, "ring must start at home-30");
assert.strictEqual(systems[1], 334, "ring must advance from start to +1");
assert.strictEqual(
  systems[30],
  363,
  "the home system must be in the middle of the ring",
);
assert.strictEqual(systems[31], 364, "after home, sequence continues to +1");
assert.strictEqual(
  systems[60],
  393,
  "the last system in the ring should be home+30",
);
assert.strictEqual(
  systems.length,
  61,
  "window length should be 1 + 30 + 30 = 61",
);
assert.strictEqual(
  new Set(systems).size,
  systems.length,
  "window must not contain duplicates",
);

const pendingTargets = farm.filterPendingSpyTargets(
  [
    { coords: "1:363:3", player: "one" },
    { coords: "1:363:4", player: "two" },
    { coords: "1:363:5", player: "three" },
  ],
  {
    "1:363:3": { ts: Date.now(), permanent: false },
    "1:363:4": { ts: Date.now(), permanent: true },
  },
);
assert.deepStrictEqual(
  pendingTargets.map((t) => t.coords),
  ["1:363:5"],
  "targets already sent or permanently invalid must be excluded from repeated scans",
);

const retryTargets = farm.filterPendingSpyTargets(
  [
    { coords: "1:363:3", player: "one" },
    { coords: "1:363:6", player: "six" },
  ],
  {
    "1:363:3": { ts: Date.now() - 10 * 60 * 60 * 1000, permanent: false },
  },
  { ignoreCooldown: true },
);
assert.deepStrictEqual(
  retryTargets.map((t) => t.coords),
  ["1:363:3", "1:363:6"],
  "old cooldown markers should not block real retry when the farm loop explicitly re-sends spies",
);
assert.deepStrictEqual(
  farm
    .filterPendingSpyTargets([{ coords: "1:363:44", player: "fresh" }], {
      "1:363:44": { ts: Date.now(), permanent: false },
    })
    .map((t) => t.coords),
  [],
  "normal scan must respect the recent spy cooldown and not re-send the same target on the next tick",
);
assert.strictEqual(
  farm.shouldIgnoreSpyCooldownForSystem(
    { cursor: 366, cursorSince: Date.now() },
    366,
    Date.now(),
  ),
  false,
  "an active farm system must not ignore its own recent spy cooldown while still waiting for reports",
);

assert.strictEqual(
  farm.normalizeFleetMetricValue(null),
  0,
  "missing live fleet count is not valid capacity and must be treated as zero",
);
assert.strictEqual(
  farm.normalizeFleetMetricValue(""),
  0,
  "empty fleet count is not valid capacity and must be treated as zero",
);
assert.strictEqual(
  farm.normalizeFleetMetricValue("12345"),
  12345,
  "valid live fleet count must be preserved as-is",
);
assert.strictEqual(
  farm.resolveBattleshipsFromFleet(
    {
      ships: [{ id: "207", name: "Линкор", available: null }],
      dockShips: [{ id: null, name: "Линкор", available: 286184724921 }],
    },
    "Линкор",
  ),
  0,
  "missing live raw ship counts must not be replaced by a dock tooltip value",
);
assert.strictEqual(
  farm.hasPendingIshkoFarmReports(
    [
      { id: "1", coords: "1:366:3" },
      { id: "2", coords: "1:366:4" },
    ],
    { farmed: {}, sent: {} },
    Date.now(),
    12 * 60 * 60 * 1000,
  ),
  false,
  "raw spy reports must not block the first Ishkofarm send before any farm state exists",
);
assert.deepStrictEqual(
  farm.hasPendingIshkoFarmReports(
    [
      { id: "1", coords: "1:366:3" },
      { id: "2", coords: "1:366:4" },
    ],
    {
      farmed: { "1:366:4": Date.now() - 10 * 60 * 1000 },
      sent: { "1:366:3": { at: Date.now() } },
    },
    Date.now(),
    12 * 60 * 60 * 1000,
  ),
  true,
  "already sent or recently farmed targets must keep the system in strict wait state",
);
assert.strictEqual(
  farm.hasPendingIshkoFarmReports(
    [
      { id: "1", coords: "1:366:3" },
      { id: "2", coords: "1:366:4" },
    ],
    {
      farmed: {
        "1:366:3": Date.now() - 25 * 60 * 60 * 1000,
        "1:366:4": Date.now() - 25 * 60 * 60 * 1000,
      },
      sent: {},
    },
    Date.now(),
    12 * 60 * 60 * 1000,
  ),
  false,
  "old farmed reports with expired cooldown must not keep the system in strict wait",
);

const allDone = farm.isSystemWindowComplete(
  {
    363: true,
    364: true,
    365: true,
    366: true,
    367: true,
    368: true,
    369: true,
    370: true,
    371: true,
    372: true,
    373: true,
    374: true,
    375: true,
    376: true,
    377: true,
    378: true,
    379: true,
    380: true,
    381: true,
    382: true,
    383: true,
    384: true,
    385: true,
    386: true,
    387: true,
    388: true,
    389: true,
    390: true,
    391: true,
    392: true,
    393: true,
    332: true,
    333: true,
    334: true,
    335: true,
    336: true,
    337: true,
    338: true,
    339: true,
    340: true,
    341: true,
    342: true,
    343: true,
    344: true,
    345: true,
    346: true,
    347: true,
    348: true,
    349: true,
    350: true,
    351: true,
    352: true,
    353: true,
    354: true,
    355: true,
    356: true,
    357: true,
    358: true,
    359: true,
    360: true,
    361: true,
    362: true,
  },
  363,
  30,
);
assert.strictEqual(allDone, true, "full ring should be detected as complete");

const mixedReports = [
  {
    id: "1",
    action: "Шпионский доклад",
    theme: "Шпионский доклад",
    coords: "1:363:7",
  },
  {
    id: "2",
    action: "Шпионский доклад",
    theme: "Шпионский доклад",
    coords: "1:392:9",
  },
  {
    id: "3",
    action: "Шпионский доклад",
    theme: "Шпионский доклад",
    coords: "1:363:10",
  },
  {
    id: "4",
    action: "Боевой доклад",
    theme: "Боевой доклад",
    coords: "1:363:8",
  },
];
const currentSystemReports = filterSpyReports(mixedReports, { system: 363 });
assert.deepStrictEqual(
  currentSystemReports.map((m) => m.id),
  ["1", "3"],
  "current-system filter must exclude spy reports from other systems",
);

console.log("farm system cycle test: ok");

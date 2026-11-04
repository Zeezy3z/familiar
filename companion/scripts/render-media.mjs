// Renders the README/release media from the real built renderers (dist/overlay.*, dist/control.*)
// and the synthetic preview bridge (preview-fixtures.js). No Electron, WoW, agents, saved sessions
// or network; the model data below is invented. Run `npm run build` first, then:
//
//   FAMILIAR_QA_MODULE=<path to playwright/index.mjs> node scripts/render-media.mjs [--out <dir>] [--gif]
//   (npm run media -- --gif)
//
// Output (default ../docs/media): quest-log.png working.png approval.png complete.png control.png
// at device scale 2, and with --gif familiar.gif (needs ffmpeg on PATH; skipped with a notice otherwise).
// Every frame carries a visible "PREVIEW" label: these are not live game footage.
// The window frame, buttons and backdrop are simple stand-ins drawn here in CSS (no Blizzard art);
// the panes, cards, tracker, toasts and the control panel are the real renderers.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.FAMILIAR_QA_MODULE) throw new Error("FAMILIAR_QA_MODULE must point to a Playwright installation (…/playwright/index.mjs).");
const { chromium } = await import(pathToFileURL(process.env.FAMILIAR_QA_MODULE).href);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const outDir = resolve(arg("--out") ?? process.env.FAMILIAR_MEDIA_OUT ?? join(root, "..", "docs", "media"));
const wantGif = process.argv.includes("--gif");
const origin = `http://127.0.0.1:${Number(process.env.FAMILIAR_PREVIEW_PORT) || 47812}`; // the spawned preview server inherits the same variable
const BUDGET = 6 * 1024 * 1024; // docs/media total (round 4 §3.5)
mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, ["scripts/preview.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (c) => (serverLog += c));
server.stderr.on("data", (c) => (serverLog += c));

// ---- geometry: the real 720x440 window (UI.lua / Layout.lua), scaled by PX physical px per UI unit ----
const PX = 1.15;
const U = (v) => Math.round(v * PX);
const MARGIN = 30, WIN_W = 720, WIN_H = 440, TRACKER_W = 240, TRACKER_H = 150, GAP = 22;
const W = MARGIN + U(WIN_W) + GAP + U(TRACKER_W) + MARGIN; // stage width in CSS px
const LABEL_H = 44;

function geometry(top) {
  const fx = MARGIN, fy = top;
  const r = (x, y, w, h) => [fx + U(x), fy + U(y), U(w), U(h)];
  const tx = fx + U(WIN_W) + GAP, ty = fy + U(40);
  return {
    frame: [fx, fy, U(WIN_W), U(WIN_H)],
    H: fy + U(WIN_H) + 26 + LABEL_H,
    layout: {
      scr: [W, fy + U(WIN_H) + 26 + LABEL_H], px: PX, panel: true, native: false, drag: false, combat: false, ui: true,
      rowH: Math.round(16 * PX * 100) / 100,
      list: r(19, 59, 220, 336), detail: r(255, 59, 446, 260), status: r(148, 404, 198, 22),
      keys: { approve: r(354, 404, 72, 22), stop: r(566, 404, 56, 22), mode: r(564, 28, 64, 22) },
      tracker: [tx + U(6), ty + U(20), U(TRACKER_W - 12), U(TRACKER_H - 26)],
    },
    trackerFrame: [tx, ty, U(TRACKER_W), U(TRACKER_H)],
    r, // UI-unit rect -> stage px, for the stand-in chrome
  };
}

// ---- stand-in chrome: window frame, buttons, composer, tracker frame, backdrop, PREVIEW label ----
const BUTTONS = [ // [text, x, y, w, key]  (UI.lua anchors, UI units from the window's top-left)
  ["+ Claude", 16, 28, 80], ["+ Codex", 100, 28, 80], ["+ Chat", 184, 28, 64], ["Back", 252, 28, 60],
  ["Model", 496, 28, 64], ["Mode", 564, 28, 64, "mode"], ["Text", 632, 28, 54],
  ["Log", 14, 404, 62], ["Focus", 80, 404, 62],
  ["Approve", 354, 404, 72, "approve"], ["Deny", 430, 404, 56, "approve"], ["Always", 490, 404, 64, "approve"], ["Stop", 566, 404, 56, "stop"], ["Send", 626, 404, 64],
];
const CSS = `
#media-stage { position:absolute; inset:0; z-index:0; overflow:hidden;
  background: repeating-linear-gradient(0deg, rgba(255,236,200,.02) 0 1px, transparent 1px 4px), #14111a; }
#media-stage .m-frame { position:absolute; box-sizing:border-box; border-radius:8px; background:#0b0a0c; border:2px solid #6e5731;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.8), inset 0 0 22px rgba(0,0,0,.65), 0 14px 38px rgba(0,0,0,.6); }
#media-stage .m-title { position:absolute; transform:translateX(-50%); box-sizing:border-box; text-align:center; font-family:var(--display);
  color:var(--gold); text-shadow:1px 1px 0 #000; background:linear-gradient(#2a2118,#14100b); border:2px solid #6e5731; border-radius:6px; }
#media-stage .m-box { position:absolute; box-sizing:border-box; background:#000; border:1px solid #99804d; border-radius:3px; }
#media-stage .m-hint { position:absolute; color:var(--muted); font-family:var(--sans); }
#media-stage .m-btn { position:absolute; box-sizing:border-box; display:flex; align-items:center; justify-content:center; font-family:var(--display);
  color:var(--gold); border:1px solid #8a6d1f; background:linear-gradient(180deg,#5a1010,#2a0505); border-radius:3px; text-shadow:1px 1px 0 #000; }
#media-stage .m-btn.off { opacity:.45; }
#media-stage .m-x { position:absolute; box-sizing:border-box; display:flex; align-items:center; justify-content:center; color:var(--gold-dim);
  border:1px solid #8a6d1f; background:linear-gradient(180deg,#3a1a10,#1d0b06); border-radius:3px; font-family:var(--sans); }
#media-stage .m-label { position:absolute; display:flex; align-items:center; gap:10px; color:#d9cfb9; font:600 13px var(--sans); letter-spacing:.01em; }
#media-stage .m-label b { font-family:var(--display); font-weight:400; color:#1a1208; background:var(--gold); padding:3px 9px; border-radius:3px; letter-spacing:.14em; }
#media-stage .m-label span { color:#bfb6a4; font-weight:400; }
#media-stage .m-card { position:absolute; border-radius:8px; overflow:hidden; background:#0b0a0c; border:2px solid #6e5731; box-shadow:0 14px 38px rgba(0,0,0,.6); }
#media-stage iframe { display:block; border:0; background:#0b0a0c; }
`;
const label = (what) => `<b>PREVIEW</b><span>Familiar's real ${what}, rendered from sample data. Not live game footage.</span>`;

function stageHtml(g, { composer = "", disabledKeys = [], tracker = true }) {
  const [fx, fy, fw, fh] = g.frame;
  const px = (n) => `${n}px`;
  const box = (cls, [x, y, w, h], extra = "") => `<div class="${cls}" style="left:${px(x)};top:${px(y)};width:${px(w)};height:${px(h)};${extra}"></div>`;
  const fs = px(Math.round(11.5 * PX));
  const buttons = BUTTONS.map(([text, x, y, w, key]) => {
    const [bx, by, bw, bh] = g.r(x, y, w, 22);
    const off = key && disabledKeys.includes(key);
    return `<div class="m-btn${off ? " off" : ""}" data-key="${key ?? ""}" style="left:${px(bx)};top:${px(by)};width:${px(bw)};height:${px(bh)};font-size:${fs}">${text}</div>`;
  }).join("");
  const [cx, cy, cw, ch] = g.r(250, 330, 456, 70);
  const [lx, ly, lw, lh] = g.r(14, 54, 230, 346);
  const [dx, dy, dw, dh] = g.r(250, 54, 456, 270);
  const [closeX, closeY, closeW, closeH] = g.r(692, 6, 20, 20);
  const titleW = U(190), titleH = U(30);
  const trk = tracker ? (() => { const [tx, ty, tw, th] = g.trackerFrame;
    return `<div class="m-frame" style="left:${px(tx)};top:${px(ty)};width:${px(tw)};height:${px(th)};border-width:1px;border-color:rgba(130,104,56,.8)"></div>
      <div class="m-hint" style="left:${px(tx + U(8))};top:${px(ty + U(3))};font:${fs} var(--display);color:var(--gold-dim)">Familiars</div>` })() : "";
  return `<div id="media-stage">
    <div class="m-frame" style="left:${px(fx)};top:${px(fy)};width:${px(fw)};height:${px(fh)}"></div>
    <div class="m-title" style="left:${px(fx + fw / 2)};top:${px(fy - U(12))};width:${px(titleW)};height:${px(titleH)};line-height:${px(titleH - 4)};font-size:${px(Math.round(15 * PX))}">Familiar</div>
    <div class="m-x" style="left:${px(closeX)};top:${px(closeY)};width:${px(closeW)};height:${px(closeH)};font-size:${fs}">×</div>
    ${box("m-box", [lx, ly, lw, lh], "background:rgba(5,5,8,.9);border-color:rgba(140,112,64,.9)")}
    ${box("m-box", [dx, dy, dw, dh], "background:rgba(5,5,8,.9);border-color:rgba(140,112,64,.9)")}
    <div class="m-box" style="left:${px(cx)};top:${px(cy)};width:${px(cw)};height:${px(ch)}"></div>
    <div class="m-hint" id="m-composer" style="left:${px(cx + U(10))};top:${px(cy + U(8))};font-size:${px(Math.round(11.5 * PX))};${composer ? "color:var(--text)" : ""}">${composer || "Message your familiar — Enter sends, Shift+Enter adds a line"}</div>
    ${buttons}${trk}
    <div class="m-label" style="left:${px(fx)};top:${px(fy + fh + 18)}">${label("overlay")}</div>
  </div>`;
}

// ---- synthetic model data (invented project, quests and files) ----
const CWD = "C:\\sample\\garden-planner";
const sel = (id) => ({ type: "select", id });
const listRows = (selected, { waterStatus = "idle", datesStatus = "idle", unread } = {}) => [
  { kind: "zone", key: "chats", text: "Chats", count: 1 },
  { kind: "thread", key: "c1", text: "Best route for herbs?", agent: "codex", status: "idle", act: sel("c1") },
  { kind: "zone", key: "garden", text: "Garden planner", count: 2 },
  { kind: "thread", key: "garden-water", text: "Watering schedule", agent: "claude", status: waterStatus, selected: selected === "garden-water", unread: unread === "garden-water", act: sel("garden-water") },
  { kind: "thread", key: "garden-dates", text: "Fix date parsing", agent: "codex", status: datesStatus, selected: selected === "garden-dates", act: sel("garden-dates") },
  { kind: "zone", key: "recipes", text: "Recipe notes", count: 1 },
  { kind: "ext", key: "ext1", text: "Tidy the README", agent: "claude", sub: "2d", act: { type: "select", id: "ext1" } },
];
const USER = { id: "u1", kind: "user", text: "Add a watering schedule: each plant needs a number of days between waterings, and the list should show what is due today." };
const READ = { id: "t1", kind: "tool", name: "Read", text: "src/plants.json", status: "ok" };
const GREP = { id: "t2", kind: "tool", name: "Grep", text: "dueToday", status: "ok" };
const thread = (over) => ({ kind: "thread", id: "garden-water", external: false, title: "Watering schedule", agent: "claude", project: "Garden planner", cwd: CWD, mode: "Ask first", model: "sonnet", todos: [], entries: [], ...over });
const target = { text: "Claude · Watering schedule · Garden planner" };
const status = { text: "Linked · Claude ✓ · Codex ✓", level: "ok" };

const SCENES = {
  "quest-log": {
    scenario: "welcome", top: 50, disabledKeys: ["approve", "stop"],
    patch: {
      list: { title: "Quest Log", rows: listRows(undefined, { waterStatus: "running", datesStatus: "approval", unread: "garden-water" }) },
      target: { text: "Nothing selected - choose Chat, a project quest, or a conversation on the left", warn: true },
      status, toasts: [], keys: { approve: false, stop: false, mode: undefined },
      tracker: [
        { id: "garden-water", agent: "claude", title: "Watering schedule", project: "Garden planner", status: "running", activity: "Editing src/plants.json", progress: "2/3", cost: "$0.12" },
        { id: "garden-dates", agent: "codex", title: "Fix date parsing", project: "Garden planner", status: "approval", activity: "Waiting: Run npm test", cost: "6.1k tokens" },
      ],
    },
    detail: { counts: { total: 3, running: 1, approval: 1 }, zones: 3 },
  },
  working: {
    scenario: "running", top: 50, disabledKeys: ["approve"],
    patch: {
      list: { title: "Quest Log", rows: listRows("garden-water", { waterStatus: "running" }) }, target, status, toasts: [],
      keys: { approve: false, stop: true, mode: "Ask first" },
      tracker: [
        { id: "garden-water", agent: "claude", title: "Watering schedule", project: "Garden planner", status: "running", activity: "Editing src/plants.json", progress: "2/3", cost: "$0.12" },
        { id: "c1", agent: "codex", title: "Best route for herbs?", project: "Chats", status: "idle", activity: "Finished — reply ready", cost: "8.2k tokens" },
      ],
    },
    detail: thread({ status: "running", usage: "12.3k in · 4.1k out · $0.12",
      todos: [{ text: "Show what is due today in the list", status: "in_progress" }],
      entries: [READ, GREP,
        { id: "a1", kind: "assistant", streaming: true, text: "No watering data yet, so I'll add a `wateringDays` field and a helper:\n\n```ts\nexport const dueToday = (p: Plant, today: Date) =>\n  daysSince(p.lastWatered, today) >= p.wateringDays;\n```" }] }),
  },
  approval: {
    scenario: "approval-always", top: 50,
    patch: {
      list: { title: "Quest Log", rows: listRows("garden-water", { waterStatus: "approval" }) }, target, status, toasts: [],
      keys: { approve: true, stop: true, mode: "Ask first" },
      tracker: [
        { id: "garden-water", agent: "claude", title: "Watering schedule", project: "Garden planner", status: "approval", activity: "Waiting: Edit src/plants.json", progress: "2/3", cost: "$0.14" },
        { id: "c1", agent: "codex", title: "Best route for herbs?", project: "Chats", status: "idle", activity: "Finished — reply ready", cost: "8.2k tokens" },
      ],
    },
    detail: thread({ status: "approval",
      todos: [],
      entries: [
        { id: "p1", kind: "approval", title: "Edit src/plants.json", approval: "pending", requestId: "media", canAlways: true,
          text: "  { \"name\": \"Basil\", \"lastWatered\": \"2026-10-30\",\n-   \"sun\": \"full\" }\n+   \"sun\": \"full\", \"wateringDays\": 2 }" }] }),
  },
  complete: {
    scenario: "quest-complete", top: 190, disabledKeys: ["approve", "stop"],
    patch: {
      list: { title: "Quest Log", rows: listRows("garden-water", { waterStatus: "idle" }) }, target, status, raidWarnings: true,
      toasts: [{ kind: "done", text: "Quest Complete · Watering schedule", at: 1 }],
      keys: { approve: false, stop: false, mode: "Ask first" },
      tracker: [
        { id: "garden-water", agent: "claude", title: "Watering schedule", project: "Garden planner", status: "idle", activity: "Finished — reply ready", progress: "3/3", cost: "$0.21" },
        { id: "c1", agent: "codex", title: "Best route for herbs?", project: "Chats", status: "idle", activity: "Finished — reply ready", cost: "8.2k tokens" },
      ],
    },
    detail: thread({ status: "idle", usage: "18.4k in · 5.2k out · $0.21",
      todos: [{ text: "Add a wateringDays field", status: "completed" }, { text: "Show what is due today in the list", status: "completed" }, { text: "Cover it with a test", status: "completed" }],
      entries: [READ,
        { id: "a1", kind: "assistant", text: "Done. Every plant now has a `wateringDays` value, and the list shows a **Due today** badge. All 12 tests pass." }] }),
  },
};

// ---- browser helpers ----
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function glassScene(page, name, top) {
  const s = SCENES[name];
  const g = geometry(top ?? s.top);
  await page.setViewportSize({ width: W, height: g.H });
  await page.goto(`${origin}/overlay.html?scenario=${s.scenario}`);
  await page.waitForFunction(() => window.preview && !document.body.classList.contains("hidden"));
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: CSS });
  await page.evaluate(({ html, layout, patch, detail }) => {
    document.body.style.background = "#0d0c11";
    document.querySelector("body > p")?.remove();      // the fixture's own "Synthetic Glass preview" caption
    document.querySelector("body > div:not([id])")?.remove(); // its debug button row, when a scenario has one
    document.body.insertAdjacentHTML("afterbegin", html);
    const p = window.preview;
    Object.assign(p.model, patch);
    p.model.detail = { ...p.model.detail, ...detail };
    p.emit("layout", layout);
    p.emit("model", { ...p.model });
  }, { html: stageHtml(g, s), layout: g.layout, patch: s.patch, detail: s.detail });
  await settle(page);
  await page.waitForTimeout(700); // toast entrance (0.35 s) and the 120 ms layout settle
  await settle(page);
  return g;
}

async function controlScene(page) {
  const paneW = 760;
  const probe = await page.context().newPage();
  await probe.setViewportSize({ width: paneW, height: 1000 });
  await probe.goto(`${origin}/control.html?scenario=linked`);
  await probe.waitForFunction(() => window.preview && document.getElementById("journey-title")?.textContent);
  await probe.evaluate(() => document.fonts.ready);
  await probe.waitForTimeout(300);
  const contentH = Math.ceil(await probe.evaluate(() => document.getElementById("advanced").getBoundingClientRect().bottom + window.scrollY)) + 28;
  await probe.close();
  const M = 40, W2 = paneW + M * 2, H2 = contentH + M * 2 + LABEL_H - 10;
  await page.setViewportSize({ width: W2, height: H2 });
  const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="overlay.css"><style>${CSS}</style>
    <body style="margin:0;overflow:hidden;background:#0d0c11"><div id="media-stage">
      <div class="m-card" style="left:${M}px;top:${M}px;width:${paneW}px;height:${contentH}px">
        <iframe src="control.html?scenario=linked" style="width:${paneW}px;height:${contentH}px"></iframe></div>
      <div class="m-label" style="left:${M}px;top:${M + contentH + 16}px">${label("control panel")}</div></div>`;
  await page.route(`${origin}/__media.html`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${origin}/__media.html`);
  const frame = page.frames().find((f) => f.url().includes("control.html") && f !== page.mainFrame());
  await frame.waitForFunction(() => window.preview && document.getElementById("journey-title")?.textContent);
  await frame.evaluate(() => document.fonts.ready);
  // The fixture's version string says 0.1.0; show what this release is, still marked as sample data.
  await frame.evaluate(() => { window.preview.state.version = "0.2.0 · sample data"; window.preview.emit("status", window.preview.state); });
  await frame.waitForFunction(() => document.body.textContent.includes("0.2.0 · sample data"), null, { timeout: 5000 });
  await page.waitForTimeout(600);
  return { W: W2, H: H2 };
}

// ---- familiar.gif: one scripted 20-second take through the same synthetic bridge ----
// welcome -> type a request -> working (objectives, tool line, streaming reply) -> approval card ->
// Approve (through the Glass's own click path, as the preview does) -> Quest Complete.
async function recordGif(browser) {
  const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (ff.error || ff.status !== 0) { console.log("familiar.gif skipped: ffmpeg not found on PATH."); return; }
  const dir = mkdtempSync(join(tmpdir(), "familiar-media-"));
  const top = 190, g = geometry(top);
  const context = await browser.newContext({ viewport: { width: W, height: g.H }, deviceScaleFactor: 1, reducedMotion: "reduce", bypassCSP: true,
    recordVideo: { dir, size: { width: W, height: g.H } } });
  const t0 = Date.now();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await glassScene(page, "quest-log", top);
    const t1 = Date.now();
    const wait = (ms) => page.waitForTimeout(ms);
    const push = async (fn, arg) => {
      await page.evaluate(({ src, arg }) => { const p = window.preview; (0, eval)(`(${src})`)(p, arg); p.emit("model", { ...p.model }); }, { src: fn.toString(), arg });
      await settle(page);
    };
    await page.evaluate(() => { window.preview.model.raidWarnings = true; }); // toasts centred above the window, as in complete.png
    const keys = (approve, stop) => page.evaluate(({ approve, stop }) => {
      document.querySelectorAll("#media-stage .m-btn[data-key]").forEach((b) => { const k = b.dataset.key; b.classList.toggle("off", (k === "approve" && !approve) || (k === "stop" && !stop)); });
    }, { approve, stop });
    await keys(false, false);
    await wait(2600);
    // Pick the quest and type the request.
    await push((p) => {
      p.model.list.rows.forEach((r) => { r.selected = r.key === "garden-water"; if (r.key === "garden-dates") r.status = "idle"; });
      p.model.detail = { kind: "thread", id: "garden-water", external: false, title: "Watering schedule", agent: "claude", project: "Garden planner", cwd: "C:\\sample\\garden-planner", status: "idle", mode: "Ask first", model: "sonnet", todos: [], entries: [] };
      p.model.target = { text: "Claude · Watering schedule · Garden planner" };
      p.model.keys = { approve: false, stop: false, mode: "Ask first" };
    });
    const request = "Add a watering schedule: each plant needs days between waterings.";
    for (let i = 1; i <= request.length; i += 2) {
      await page.evaluate((t) => { const c = document.getElementById("m-composer"); c.style.color = "var(--text)"; c.textContent = t; }, request.slice(0, i));
      await wait(45);
    }
    await wait(500);
    await page.evaluate(() => { const c = document.getElementById("m-composer"); c.style.color = ""; c.textContent = "Message your familiar — Enter sends, Shift+Enter adds a line"; });
    await keys(false, true);
    await push((p, text) => {
      const w = p.model.list.rows.find((r) => r.key === "garden-water"); w.status = "running";
      p.model.detail.status = "running"; p.model.detail.entries = [{ id: "u1", kind: "user", text }];
      p.model.keys = { approve: false, stop: true, mode: "Ask first" };
      p.model.tracker = [{ id: "garden-water", agent: "claude", title: "Watering schedule", project: "Garden planner", status: "running", activity: "Reading src/plants.json", progress: "0/2" }];
    }, request);
    await wait(1100);
    await push((p) => {
      p.model.detail.entries.push({ id: "t1", kind: "tool", name: "Read", text: "src/plants.json", status: "ok" });
      p.model.tracker[0].activity = "Planning the change"; p.model.tracker[0].progress = "0/2";
    });
    await wait(900);
    const reply = "I'll add a `wateringDays` field to every plant, then a small helper that says what is due today.";
    const words = reply.split(" ");
    await push((p) => { p.model.detail.entries.push({ id: "a1", kind: "assistant", text: "", streaming: true }); });
    for (let i = 1; i <= words.length; i++) {
      await push((p, text) => { p.model.detail.entries.find((e) => e.id === "a1").text = text; }, words.slice(0, i).join(" "));
      await wait(110);
    }
    await wait(600);
    // The request: Approve glows, the orange toast and tracker line say it needs you.
    await keys(true, true);
    await push((p) => {
      p.model.detail.entries.find((e) => e.id === "a1").streaming = false;
      p.model.detail.entries.push({ id: "p1", kind: "approval", title: "Edit src/plants.json", approval: "pending", requestId: "gif", canAlways: true,
        text: "  { \"name\": \"Basil\", \"lastWatered\": \"2026-10-30\",\n-   \"sun\": \"full\" }\n+   \"sun\": \"full\", \"wateringDays\": 2 }" });
      p.model.detail.status = "approval"; p.model.list.rows.find((r) => r.key === "garden-water").status = "approval";
      p.model.keys = { approve: true, stop: true, mode: "Ask first" };
      p.model.toasts = [{ kind: "approval", text: "Needs approval · Watering schedule", at: 2 }];
      p.model.tracker[0].status = "approval"; p.model.tracker[0].activity = "Waiting: Edit src/plants.json";
    });
    await wait(2700);
    await push((p) => { p.model.toasts = []; });
    await wait(1200);
    // Approve through the Glass's click path.
    await page.evaluate(() => {
      const d = document.getElementById("detail").getBoundingClientRect(), b = document.querySelector(".btn.ok").getBoundingClientRect();
      window.preview.emit("input", { t: "click", r: "detail", x: (b.left + b.width / 2 - d.left) / d.width, y: (b.top + b.height / 2 - d.top) / d.height, b: "L" });
    });
    await settle(page);
    await keys(false, true);
    await wait(1100);
    await push((p) => {
      p.model.list.rows.find((r) => r.key === "garden-water").status = "running"; p.model.detail.status = "running";
      p.model.keys = { approve: false, stop: true, mode: "Ask first" };
      p.model.tracker[0].status = "running"; p.model.tracker[0].activity = "Running the tests"; p.model.tracker[0].progress = "1/2";
    });
    await wait(1700);
    await keys(false, false);
    await push((p) => {
      p.model.list.rows.find((r) => r.key === "garden-water").status = "idle"; p.model.detail.status = "idle";
      p.model.keys = { approve: false, stop: false, mode: "Ask first" };
      p.model.detail.todos = p.model.detail.todos.map((t) => ({ ...t, status: "completed" }));
      p.model.detail.entries.push({ id: "a2", kind: "assistant", text: "Done. Every plant now has a `wateringDays` value, and the list shows a **Due today** badge." });
      p.model.toasts = [{ kind: "done", text: "Quest Complete · Watering schedule", at: 3 }];
      p.model.tracker[0].status = "idle"; p.model.tracker[0].activity = "Finished — reply ready"; p.model.tracker[0].progress = "2/2"; p.model.tracker[0].cost = "$0.21";
    });
    await wait(3400);
    const lead = (t1 - t0) / 1000;
    if (errors.length) throw new Error(`Renderer errors: ${JSON.stringify(errors)}`);
    await page.close();
    const webm = await page.video().path();
    const gif = join(outDir, "familiar.gif");
    // 12 fps, 800 px wide, adaptive palette; tighten if it comes out over the 4 MB cap.
    for (const [fps, colors, width] of [[12, 96, 800], [12, 80, 720], [10, 64, 720], [10, 48, 640]]) {
      const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
      const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", String(lead + 0.1), "-i", webm, "-vf", filter, "-loop", "0", gif], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
      if (statSync(gif).size <= 4 * 1024 * 1024) break;
    }
    if (statSync(gif).size > 4 * 1024 * 1024) throw new Error("familiar.gif is over the 4 MB cap.");
    made.push(gif);
  } finally {
    await context.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const made = [];

let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Preview server stopped: ${serverLog}`);
    try { if ((await fetch(`${origin}/overlay.html`)).ok) break; } catch {}
    if (i === 99) throw new Error("Preview server did not become ready");
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: W, height: 700 }, deviceScaleFactor: 2, reducedMotion: "reduce", bypassCSP: true });
  const external = [];
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin === origin || u.protocol === "data:") return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  for (const name of Object.keys(SCENES)) {
    await glassScene(page, name);
    const file = join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    made.push(file);
  }
  await controlScene(page);
  const controlFile = join(outDir, "control.png");
  await page.screenshot({ path: controlFile });
  made.push(controlFile);
  if (errors.length || external.length) throw new Error(`Renderer errors: ${JSON.stringify({ errors, external })}`);
  await context.close();
  if (wantGif) await recordGif(browser);
} finally {
  if (browser) await browser.close();
  server.kill();
}

for (const f of made) {
  // Magic bytes after the first one: PNG (89 50 4E 47) or GIF (47 49 46 38).
  if (!existsSync(f) || readFileSync(f).subarray(1, 4).toString() !== (f.endsWith(".gif") ? "IF8" : "PNG")) throw new Error(`Not produced: ${f}`);
  console.log(`${f.split(/[\\/]/).pop().padEnd(16)} ${kb(statSync(f).size).padStart(8)}  sha256:${sha(f)}`);
}
const total = readdirSync(outDir).reduce((n, f) => n + statSync(join(outDir, f)).size, 0);
console.log(`docs/media total ${kb(total)} (budget ${kb(BUDGET)})`);
if (total > BUDGET) throw new Error("Media exceeds the 6 MB budget.");

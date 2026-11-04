// FakeWoW: a stand-in game window for end-to-end tests without the real client. It behaves like
// the addon: renders the Runestrip (same codec + scheduling as Link.lua), draws a mock Familiar
// panel, and turns clicks / wheel / typing on that panel into the same messages the addon sends.
import { chunkMessage, encodeFrameCells, finderRgb, FLAG_IDLE, FLAG_REPEAT, Palette, symbolToRgb } from "../link/codec";

const COLS = 64,
  ROWS = 4,
  CELL = 4,
  HOLD = 70;
const enc = new TextEncoder();
let palette: Palette = "vivid";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const dpr = window.devicePixelRatio;

interface Q {
  cols: number;
  rows: number;
  flags: number;
  msgId: number;
  chunkIdx: number;
  chunkCount: number;
  payload: Uint8Array;
  key?: string;
}
const queue: Q[] = [];
let msgId = Math.floor(Math.random() * 65535);
let seq = Math.floor(Math.random() * 65535);
let current: Q | null = null;
let shownAt = 0;
let lastIdle = 0;

function send(msg: any, reliable = false, key?: string) {
  msg.v = 1;
  const payload = enc.encode(JSON.stringify(msg));
  if (key) for (let i = queue.length - 1; i >= 0; i--) if (queue[i].key === key) queue.splice(i, 1);
  msgId = (msgId + 1) % 65536;
  const push = (flags: number) => {
    for (const c of chunkMessage(payload, msgId, COLS, ROWS)) queue.push({ ...c, flags, key });
  };
  push(0);
  if (reliable) push(FLAG_REPEAT);
}

// ---- mock panel geometry (physical px of this window's client area) ---------------------------
const W = () => canvas.width,
  H = () => canvas.height;
const panel = () => {
  const w = Math.round(W() * 0.5),
    h = Math.round(H() * 0.6);
  const x = Math.round(W() * 0.25),
    y = Math.round(H() * 0.2);
  return { x, y, w, h };
};
const regions = () => {
  const p = panel();
  const list = { x: p.x + 16, y: p.y + 60, w: Math.round(p.w * 0.32), h: p.h - 140 };
  const detail = { x: list.x + list.w + 8, y: list.y, w: p.x + p.w - 16 - (list.x + list.w + 8), h: p.h - 140 - 80 };
  const status = { x: p.x + 16, y: p.y + p.h - 44, w: Math.round(p.w * 0.45), h: 28 };
  const composer = { x: detail.x, y: detail.y + detail.h + 8, w: detail.w, h: 70 };
  const tracker = { x: W() - 340, y: 80, w: 300, h: 180 };
  // The buttons whose rects the addon sends in layout.keys (Layout.lua): the Glass glows / labels
  // them, and the companion matches a press on them to the real mouse (physical.ts). The addon
  // sends a rect only while its button is shown; FakeWoW always shows all four.
  const bx = status.x + status.w + 8,
    bw = Math.floor((p.x + p.w - 16 - bx - 3 * 6) / 4);
  const keys = Object.fromEntries(KEY_BUTTONS.map((k, i) => [k, { x: bx + i * (bw + 6), y: status.y, w: bw, h: status.h }]));
  return { list, detail, status, composer, tracker, keys };
};
const KEY_BUTTONS = ["approve", "always", "mode", "stop"] as const;
const R = (r: { x: number; y: number; w: number; h: number }) => [r.x, r.y, r.w, r.h];

let panelShown = true;
function sendLayout() {
  const r = regions();
  send(
    {
      t: "layout",
      scr: [W(), H()],
      px: 1.2,
      fpx: 1.2,
      panel: panelShown,
      native: false,
      drag: false,
      combat: false,
      ui: true,
      win: R(panel()),
      list: R(r.list),
      rowH: 19.2,
      detail: R(r.detail),
      status: R(r.status),
      keys: Object.fromEntries(KEY_BUTTONS.map((k) => [k, R(r.keys[k])])),
      tracker: R(r.tracker),
    },
    false,
    "layout",
  );
}

// ---- input: clicks / wheel / typing --------------------------------------------------------------
// A key message as the addon sends it (UI.Key): src says how ("button", "bind", "slash") and view
// the window's context, so approve / always / mode reach the same checks as in the game.
function key(k: string, src: "button" | "bind" | "slash" = "button") {
  send({ t: "key", k, src, view: "full" }, true);
}
let typed = "";
const inside = (g: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= g.x && y >= g.y && x < g.x + g.w && y < g.y + g.h;
function hit(e: MouseEvent) {
  const x = e.offsetX * dpr,
    y = e.offsetY * dpr;
  const r = regions();
  for (const name of ["list", "detail", "tracker", "status"] as const) {
    const g = r[name];
    if (inside(g, x, y)) return { name, rx: (x - g.x) / g.w, ry: (y - g.y) / g.h };
  }
  return null;
}
canvas.addEventListener("mouseup", (e) => {
  const x = e.offsetX * dpr,
    y = e.offsetY * dpr;
  const button = panelShown && e.button === 0 ? KEY_BUTTONS.find((k) => inside(regions().keys[k], x, y)) : undefined;
  if (button) return key(button);
  const h = hit(e);
  if (h) send({ t: "click", r: h.name, x: +h.rx.toFixed(4), y: +h.ry.toFixed(4), b: e.button === 2 ? "R" : "L" }, true);
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("wheel", (e) => {
  const h = hit(e as any);
  if (h) send({ t: "wheel", r: h.name, d: e.deltaY > 0 ? -1 : 1 });
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    if (typed.trim()) send({ t: "prompt", text: typed.trim() }, true);
    typed = "";
  } else if (e.key === "Backspace") typed = typed.slice(0, -1);
  else if (e.key === "F1") key("newClaude", "bind");
  else if (e.key === "F2") key("newCodex", "bind");
  else if (e.key === "F3") key("approve", "bind");
  else if (e.key === "F4") key("deny", "bind");
  else if (e.key === "F5") key("back", "bind");
  else if (e.key === "F6") {
    panelShown = !panelShown;
    sendLayout();
  } else if (e.key.length === 1) typed += e.key;
});

// Test hooks for automation (driven from the main process via executeJavaScript).
(window as any).fake = { send, key, sendLayout, regions, panel, queueDepth: () => queue.length, setPalette: (p: Palette) => (palette = p) };

// ---- drawing ---------------------------------------------------------------------------------
function drawStrip(cells: ArrayLike<number>, cols: number, rows: number) {
  for (let i = 0; i < cols * rows; i++) {
    const v = cells[i];
    const rgb = v < 0 ? finderRgb(-v - 1, palette) : symbolToRgb(v, palette);
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect((i % cols) * CELL, Math.floor(i / cols) * CELL, CELL, CELL);
  }
}

let stripCells: { cells: Int16Array; cols: number; rows: number } | null = null;
function step(now: number) {
  if (current && now - shownAt < HOLD) return;
  const next = queue.shift();
  if (next) {
    seq = (seq + 1) % 65536;
    current = next;
    shownAt = now;
    stripCells = { cells: encodeFrameCells({ ...next, seq }), cols: next.cols, rows: next.rows };
  } else if (!current || current.flags !== FLAG_IDLE || now - lastIdle > 1000) {
    lastIdle = now;
    seq = (seq + 1) % 65536;
    current = { cols: 32, rows: 1, flags: FLAG_IDLE, msgId: 0, chunkIdx: 0, chunkCount: 1, payload: new Uint8Array(0) };
    shownAt = now;
    stripCells = { cells: encodeFrameCells({ ...current, seq }), cols: 32, rows: 1 };
  }
}

function draw(now: number) {
  step(now);
  // "Game world"
  const g = ctx.createLinearGradient(0, 0, 0, H());
  g.addColorStop(0, "#1d3550");
  g.addColorStop(1, "#2c4a22");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W(), H());
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  for (let i = 0; i < 30; i++) ctx.fillRect((i * 137 + now / 30) % W(), (i * 71) % H(), 40, 3);
  // Mock Familiar panel chrome
  if (panelShown) {
    const p = panel();
    const r = regions();
    ctx.fillStyle = "rgba(10,10,12,0.85)";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = "#b8963a";
    ctx.lineWidth = 3;
    ctx.strokeRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = "#ffd100";
    ctx.font = `${16 * dpr}px Georgia`;
    ctx.fillText("Familiar (FakeWoW)", p.x + 20, p.y + 30);
    for (const k of ["list", "detail", "composer", "status"] as const) {
      const q = r[k];
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(q.x, q.y, q.w, q.h);
      ctx.strokeStyle = "#5a4a22";
      ctx.lineWidth = 1;
      ctx.strokeRect(q.x, q.y, q.w, q.h);
    }
    ctx.font = `${12 * dpr}px Segoe UI`;
    for (const k of KEY_BUTTONS) {
      const b = r.keys[k];
      ctx.fillStyle = "#5a1010";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = "#ffd100";
      ctx.fillText(k, b.x + 8, b.y + b.h - 8);
    }
    ctx.fillStyle = "#ddd";
    ctx.fillText(`> ${typed}▍`, r.composer.x + 8, r.composer.y + 24);
    ctx.fillStyle = "#888";
    ctx.fillText("F1 +Claude · F2 +Codex · F3 approve · F4 deny · F5 back · F6 toggle panel · type + Enter", r.composer.x + 8, r.composer.y + 52);
  }
  const t = regions().tracker;
  ctx.strokeStyle = "rgba(184,150,58,0.5)";
  ctx.strokeRect(t.x, t.y, t.w, t.h);
  if (stripCells) drawStrip(stripCells.cells, stripCells.cols, stripCells.rows);
  requestAnimationFrame(draw);
}

function resize() {
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  sendLayout();
}
window.addEventListener("resize", resize);
resize();
// As Core.lua: hello at login and every 20 s (a companion started later still learns who is here).
const hello = () => send({ t: "hello", addon: "fakewow", viewKeys: 1, build: "0.0.0", iface: 16001, char: "Testy", realm: "FakeRealm", locale: "enUS", syncAt: 0 }, false, "hello");
hello();
setInterval(hello, 20_000);
setInterval(sendLayout, 4000);
requestAnimationFrame(draw);

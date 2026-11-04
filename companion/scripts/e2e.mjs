// End-to-end checks against a running FakeWoW + companion (scripts/dev-restart.sh --fake).
// Every interaction goes through FakeWoW -> Runestrip pixels -> WGC capture -> decoder -> Hub.
// Usage: node scripts/e2e.mjs [--agents]   (--agents also runs live Claude turns)
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
const C = "http://127.0.0.1:47810";
const F = "http://127.0.0.1:47811/eval";
// Each dev run writes a fresh token for its hooks (src/main/dev-hooks.ts); read it per request.
const auth = (port) => ({ "x-familiar-dev-token": readFileSync(join(tmpdir(), `familiar-dev-${port}.token`), "utf8") });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(C + p, { headers: auth(47810) })).json();
const post = async (p, body) => (await fetch(C + p, { method: "POST", headers: auth(47810), body: typeof body === "string" ? body : JSON.stringify(body) })).json();
const fake = async (js) => (await fetch(F, { method: "POST", headers: auth(47811), body: js })).json();
const send = (msg) => fake(`fake.send(${JSON.stringify(msg)}, true); 1`);
// A key as the addon sends it (src + view; FakeWoW's fake.key), not a bare { t: "key" }.
const key = (k, src = "button") => fake(`fake.key(${JSON.stringify(k)}, ${JSON.stringify(src)}); 1`);
const ROW = 19.2;
const startedAt = new Date().toISOString();
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (e) {
    results.push(["FAIL", name, String(e?.message ?? e)]);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
async function until(fn, ms = 8000, step = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(step);
  }
}
const model = () => get("/model");

/** A minimal PNG reader for the snapshot check: 8-bit RGB/RGBA, not interlaced (what Electron writes). */
function readPng(buf) {
  let p = 8, width = 0, height = 0, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString("ascii", p + 4, p + 8), body = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      type = body[9];
      assert(body[8] === 8 && (type === 2 || type === 6) && body[12] === 0, `unsupported PNG (depth ${body[8]}, type ${type})`);
    } else if (kind === "IDAT") idat.push(body);
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = width * bpp, raw = inflateSync(Buffer.concat(idat)), out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * stride + x] = (row[x] + pred) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out.copy(rgba, i * 4, i * bpp, i * bpp + 3);
    rgba[i * 4 + 3] = bpp === 4 ? out[i * 4 + 3] : 255;
  }
  return { width, height, rgba };
}
async function clickRow(index, b = "L") {
  // Row `index` of the list (the pane title occupies the first row height).
  const r = (await fake("JSON.stringify(fake.regions().list)")).out;
  const list = JSON.parse(r);
  await send({ t: "click", r: "list", x: 0.5, y: +(((index + 1.5) * ROW) / list.h).toFixed(4), b });
}

await check("link is up", async () => {
  const s = await get("/status");
  assert(s.linked, "not linked");
  assert(s.capture.crc === 0, `crc errors: ${s.capture.crc}`);
});

// The Glass ignores clicks while it is hidden (FakeWoW not the foreground window), so every click
// check below would fail for that reason alone, and later prompts would reach whatever quest is
// selected. Stop here instead.
await check("the Glass is showing over FakeWoW (FakeWoW is the foreground window)", async () => {
  const s = await get("/status");
  assert(s.game?.foreground && s.overlay?.shown, `foreground ${s.game?.foreground}, Glass shown ${s.overlay?.shown}: bring FakeWoW to the front and run again`);
});
if (results.at(-1)[0] === "FAIL") {
  for (const r of results) console.log(r.join("  "));
  process.exit(1);
}

await check("Back returns to the quest log", async () => {
  await key("back");
  assert(await until(async () => (await model()).list.title === "Quest Log"), "still not on quest log");
});

await check("right-click a zone starts a draft there", async () => {
  const m = await model();
  const zoneIdx = m.list.rows.findIndex((r) => r.kind === "zone");
  await clickRow(zoneIdx, "R");
  const d = await until(async () => ((await model()).detail.kind === "draft" ? (await model()).detail : null));
  assert(d, "no draft");
  assert(d.project === m.list.rows[zoneIdx].text, `draft zone ${d.project} != ${m.list.rows[zoneIdx].text}`);
  await key("back");
  await until(async () => (await model()).list.title === "Quest Log");
});

await check("mode from the game needs a physical click (a synthetic one is refused)", async () => {
  await key("newClaude");
  await until(async () => (await model()).list.title === "New Quest");
  // The picker may start with one row per agent (when more than Claude and Codex are installed).
  await clickRow((await model()).list.rows.findIndex((r) => r.kind === "project"));
  await until(async () => (await model()).detail.kind === "draft");
  try {
    const before = (await model()).detail.mode;
    // FakeWoW's clicks are not physical mouse input, so physical.ts must refuse this (and say so).
    await key("mode");
    await new Promise((r) => setTimeout(r, 1500));
    assert((await model()).detail.mode === before, "mode changed without physical input");
  } finally {
    await key("back");
    await until(async () => (await model()).list.title === "Quest Log");
  }
});

await check("collapse and expand a zone", async () => {
  const m = await model();
  const zoneIdx = m.list.rows.findIndex((r) => r.kind === "zone");
  const n = m.list.rows.length;
  await clickRow(zoneIdx);
  assert(await until(async () => (await model()).list.rows.length < n), "did not collapse");
  await clickRow(zoneIdx);
  assert(await until(async () => (await model()).list.rows.length === n), "did not expand");
});

await check("selecting a desktop thread loads its history (read-only)", async () => {
  const m = await model();
  const idx = m.list.rows.findIndex((r) => r.kind === "ext");
  assert(idx >= 0, "no desktop threads listed");
  await clickRow(idx);
  const d = await until(async () => {
    const dd = (await model()).detail;
    return dd.kind === "thread" && dd.external && !dd.loading && dd.entries.length ? dd : null;
  }, 15000);
  assert(d, "history did not load");
});

await check("wheel scrolls the details pane", async () => {
  const top0 = await post("/overlay-eval", "document.getElementById('detail-scroll').scrollTop");
  await send({ t: "wheel", r: "detail", d: 3 });
  const moved = await until(async () => (await post("/overlay-eval", "document.getElementById('detail-scroll').scrollTop")) !== top0);
  assert(moved, `scrollTop stayed ${top0}`);
});

await check("a cut request is never approved from the game, even by a corroborated click", async () => {
  // The tutorial quest needs no agent. The token-gated /action hook stands in for a corroborated
  // card click (main hands the Hub TRUSTED proof for it); only the control panel may approve this.
  await key("tutorial");
  const quest = await until(async () => (await get("/threads")).find((x) => x.agent === "familiar"));
  assert(quest, "no tutorial quest");
  const full = "echo " + "x".repeat(5000);
  const requestId = `e2e-cut-${Date.now()}`;
  await post("/inject", { agent: "familiar", type: "approval", threadId: quest.id, requestId, kind: "command", title: "e2e: cut request",
    detail: full.slice(0, 4000) + "\n… (1005 characters omitted from this preview)", canAlways: false, cut: true, full });
  await sleep(500); // older than minCardAgeMs: only the cut can refuse it
  try {
    await post("/action", { type: "decide", thread: quest.id, requestId, decision: "allow" });
    const card = (await get("/threads")).find((x) => x.id === quest.id)?.last.find((e) => e.requestId === requestId);
    assert(card?.approval === "pending", `card is ${card?.approval}`);
    assert(card?.refused?.why === "cut", `refusal: ${JSON.stringify(card?.refused)}`);
    assert((await get("/status")).requests?.some((r) => r.requestId === requestId && r.full === full), "not listed for the control panel in full");
  } finally {
    await post("/inject", { agent: "familiar", type: "approvalResolved", threadId: quest.id, requestId });
  }
});

await check("a request shown whole in game is listed for the control panel too (not cut)", async () => {
  // Deciding it there is the control window's own IPC only (no dev hook reaches "decide" with the
  // panel origin); hub.test.ts covers the decision. This checks what main serves the panel.
  await key("tutorial");
  const quest = await until(async () => (await get("/threads")).find((x) => x.agent === "familiar"));
  assert(quest, "no tutorial quest");
  const requestId = `e2e-short-${Date.now()}`;
  await post("/inject", { agent: "familiar", type: "approval", threadId: quest.id, requestId, kind: "command", title: "e2e: short request", detail: "echo hi", canAlways: true });
  try {
    const row = await until(async () => (await get("/status")).requests?.find((r) => r.requestId === requestId));
    assert(row, "not listed for the control panel");
    assert(row.cut === false && row.full === undefined && row.detail === "echo hi", `row: ${JSON.stringify(row)}`);
  } finally {
    await post("/inject", { agent: "familiar", type: "approvalResolved", threadId: quest.id, requestId });
  }
});

await check("Save what Familiar sees: a PNG of at most 320x32 px with the strip's magenta finder in it", async () => {
  const r = await post("/capture-snapshot", "");
  assert(r?.ok && r.file, `not saved: ${JSON.stringify(r)}`);
  const png = readPng(readFileSync(r.file));
  assert(png.width <= 320 && png.height <= 32, `${png.width}x${png.height}`);
  // The decoder's own test for the first finder cell (decoder.ts magentaish).
  let magenta = false;
  for (let o = 0; o < png.rgba.length && !magenta; o += 4) magenta = png.rgba[o] > 150 && png.rgba[o + 1] < 100 && png.rgba[o + 2] > 150;
  assert(magenta, "no magenta finder pixel in the picture");
});

if (process.argv.includes("--agents")) {
  let claudeId;
  await check("Claude quest resumes after a companion restart and answers", async () => {
    const m = await model();
    const idx = m.list.rows.findIndex((r) => r.kind === "thread" && r.agent === "claude");
    assert(idx >= 0, "no Claude quest");
    const want = m.list.rows[idx].key;
    await clickRow(idx);
    const ok = await until(async () => (await model()).detail.id === want);
    assert(ok, "quest not selected");
    const id = (claudeId = want);
    await send({ t: "prompt", text: "Reply with exactly the word: resumed" });
    const t = await until(async () => {
      const th = (await get("/threads")).find((x) => x.id === id);
      return th && th.status === "idle" && th.last.some((e) => e.kind === "assistant" && /resumed/i.test(e.text)) ? th : null;
    }, 90000, 1500);
    assert(t, "no 'resumed' answer");
  });

  await check("Stop interrupts a running Claude turn", async () => {
    // Only into the Claude quest the check above selected: a prompt to another selection (the
    // tutorial, say) would start something else, and a turn that never ran proves nothing.
    const id = (await model()).detail.id;
    assert(claudeId && id === claudeId, `selected ${id}, not the Claude quest ${claudeId}`);
    await send({ t: "prompt", text: "Count slowly from 1 to 400, one number per line." });
    assert(await until(async () => (await get("/threads")).find((x) => x.id === id)?.status === "running", 20000, 500), "the turn never started");
    await key("stop");
    const t = await until(async () => {
      const th = (await get("/threads")).find((x) => x.id === id);
      return th && th.status !== "running" ? th : null;
    }, 30000, 500);
    assert(t, "still running after Stop");
  });
}

// Evidence for the run record: the capture path and link numbers, and how main judged each click
// and key from the game (corroborated / unverified: <why> / refused).
const s = await get("/status");
console.log(`capture: mode ${s.capture.mode}, fps ${s.capture.fps}, frames ${s.capture.frames}, decoded ${s.capture.decoded}, crc ${s.capture.crc}, missed ${s.capture.missed}`);
try {
  const lines = readFileSync(s.logPath, "utf8").split(/\r?\n/);
  const pick = (re) => lines.filter((l) => re.test(l)).map((l) => "  " + l.slice(0, 200));
  console.log(pick(/\[capture\] (start |no Runestrip lock|screen capture found)/).slice(-1).join("\n"));
  console.log(pick(/corroborated|unverified: |refused/).filter((l) => l.slice(2, 26) >= startedAt).join("\n"));
} catch (e) {
  console.log(`(log not read: ${e?.message ?? e})`);
}
for (const r of results) console.log(r.join("  "));
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

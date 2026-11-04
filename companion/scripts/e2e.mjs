// End-to-end checks against a running FakeWoW + companion (scripts/dev-restart.sh --fake).
// Every interaction goes through FakeWoW -> Runestrip pixels -> WGC capture -> decoder -> Hub.
// Usage: node scripts/e2e.mjs [--agents]   (--agents also runs live Claude turns)
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const C = "http://127.0.0.1:47810";
const F = "http://127.0.0.1:47811/eval";
// Each dev run writes a fresh token for its hooks (src/main/dev-hooks.ts); read it per request.
const auth = (port) => ({ "x-familiar-dev-token": readFileSync(join(tmpdir(), `familiar-dev-${port}.token`), "utf8") });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(C + p, { headers: auth(47810) })).json();
const post = async (p, body) => (await fetch(C + p, { method: "POST", headers: auth(47810), body: typeof body === "string" ? body : JSON.stringify(body) })).json();
const fake = async (js) => (await fetch(F, { method: "POST", headers: auth(47811), body: js })).json();
const send = (msg) => fake(`fake.send(${JSON.stringify(msg)}, true); 1`);
const ROW = 19.2;
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

await check("Back returns to the quest log", async () => {
  await send({ t: "key", k: "back" });
  assert(await until(async () => (await model()).list.title === "Quest Log"), "still not on quest log");
});

await check("right-click a zone starts a draft there", async () => {
  const m = await model();
  const zoneIdx = m.list.rows.findIndex((r) => r.kind === "zone");
  await clickRow(zoneIdx, "R");
  const d = await until(async () => ((await model()).detail.kind === "draft" ? (await model()).detail : null));
  assert(d, "no draft");
  assert(d.project === m.list.rows[zoneIdx].text, `draft zone ${d.project} != ${m.list.rows[zoneIdx].text}`);
  await send({ t: "key", k: "back" });
  await until(async () => (await model()).list.title === "Quest Log");
});

await check("mode from the game needs a physical click (a synthetic one is refused)", async () => {
  await send({ t: "key", k: "newClaude" });
  await until(async () => (await model()).list.title === "New Quest");
  // The picker may start with one row per agent (when more than Claude and Codex are installed).
  await clickRow((await model()).list.rows.findIndex((r) => r.kind === "project"));
  await until(async () => (await model()).detail.kind === "draft");
  try {
    const before = (await model()).detail.mode;
    // FakeWoW's clicks are not physical mouse input, so physical.ts must refuse this (and say so).
    await send({ t: "key", k: "mode" });
    await new Promise((r) => setTimeout(r, 1500));
    assert((await model()).detail.mode === before, "mode changed without physical input");
  } finally {
    await send({ t: "key", k: "back" });
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
  await send({ t: "key", k: "tutorial" });
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
  await send({ t: "key", k: "tutorial" });
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

if (process.argv.includes("--agents")) {
  await check("Claude quest resumes after a companion restart and answers", async () => {
    const m = await model();
    const idx = m.list.rows.findIndex((r) => r.kind === "thread" && r.agent === "claude");
    assert(idx >= 0, "no Claude quest");
    const want = m.list.rows[idx].key;
    await clickRow(idx);
    const ok = await until(async () => (await model()).detail.id === want);
    assert(ok, "quest not selected");
    const id = want;
    await send({ t: "prompt", text: "Reply with exactly the word: resumed" });
    const t = await until(async () => {
      const th = (await get("/threads")).find((x) => x.id === id);
      return th && th.status === "idle" && th.last.some((e) => e.kind === "assistant" && /resumed/i.test(e.text)) ? th : null;
    }, 90000, 1500);
    assert(t, "no 'resumed' answer");
  });

  await check("Stop interrupts a running Claude turn", async () => {
    const id = (await model()).detail.id;
    await send({ t: "prompt", text: "Count slowly from 1 to 400, one number per line." });
    await until(async () => (await get("/threads")).find((x) => x.id === id)?.status === "running", 20000, 500);
    await send({ t: "key", k: "stop" });
    const t = await until(async () => {
      const th = (await get("/threads")).find((x) => x.id === id);
      return th && th.status !== "running" ? th : null;
    }, 30000, 500);
    assert(t, "still running after Stop");
  });
}

for (const r of results) console.log(r.join("  "));
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

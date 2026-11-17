// Pure kernel: matching decisions from the game to physical input on the PC (no journey reaches it
// without Electron + koffi).
import { describe, expect, it } from "vitest";
import { actKey, ApprovalGate, bindingToVk, CLICK_WINDOW_MS, corroborateClick, KEY_HELD, KEY_WINDOW_MS, PressLog, proofCovers, Rect, Sample, STABLE_MS, TRUSTED } from "../src/main/physical";

const s = (at: number, o: Partial<Sample> = {}): Sample => ({ at, x: 0, y: 0, left: false, right: false, down: new Set(), ctrl: false, shift: false, alt: false, ...o });
const ident = (x: number, y: number) => ({ x, y });
const RECT: Rect = [100, 100, 200, 100];

function clickAt(log: PressLog, at: number, x: number, y: number, button: "left" | "right" = "left") {
  log.sample(s(at - 20, { x, y, [button]: true }));
  log.sample(s(at, { x, y }));
}

describe("PressLog", () => {
  it("records a release at the up-transition with that sample's cursor, for either button", () => {
    const log = new PressLog();
    log.sample(s(0, { x: 1, y: 1, left: true }));
    log.sample(s(10, { x: 2, y: 2, left: true }));
    expect(log.releases).toEqual([]);
    log.sample(s(20, { x: 5, y: 6 }));
    log.sample(s(30, { right: true }));
    log.sample(s(40, { x: 7, y: 8 }));
    expect(log.releases).toEqual([
      { at: 20, x: 5, y: 6, button: "L" },
      { at: 40, x: 7, y: 8, button: "R" },
    ]);
  });

  it("records key-down transitions with modifier state, once per press", () => {
    const log = new PressLog();
    log.sample(s(0));
    log.sample(s(10, { down: new Set([0x78]), ctrl: true }));
    log.sample(s(20, { down: new Set([0x78]), ctrl: true }));
    log.sample(s(30));
    log.sample(s(40, { down: new Set([0x78]), shift: true }));
    expect(log.keys).toEqual([
      { at: 10, vk: 0x78, ctrl: true, shift: false, alt: false },
      { at: 40, vk: 0x78, ctrl: false, shift: true, alt: false },
    ]);
  });

  it("drops entries older than 5 s", () => {
    const log = new PressLog();
    clickAt(log, 100, 1, 1);
    log.sample(s(200, { down: new Set([0x41]) }));
    log.sample(s(6000));
    expect(log.releases).toEqual([]);
    expect(log.keys).toEqual([]);
  });
});

describe("corroborateClick", () => {
  it("a release inside the rect passes with the physical position, and is consumed once", () => {
    const log = new PressLog();
    clickAt(log, 1000, 150, 125);
    const p = corroborateClick(log, RECT, { x: 0.26, y: 0.24 }, 1100, ident);
    expect(p).toEqual({ ok: true, how: "click", x: 0.25, y: 0.25 });
    expect(corroborateClick(log, RECT, { x: 0.25, y: 0.25 }, 1100, ident)).toMatchObject({ ok: false, why: "no mouse release on it" });
  });

  it("whole-button checks (no reported position) need only the release inside", () => {
    const log = new PressLog();
    clickAt(log, 1000, 299, 199);
    expect(corroborateClick(log, RECT, undefined, 1000, ident).ok).toBe(true);
  });

  it("refuses a release outside the rect, a stale one, a mismatched report, or no rect", () => {
    const log = new PressLog();
    clickAt(log, 1000, 50, 50);
    expect(corroborateClick(log, RECT, undefined, 1000, ident)).toMatchObject({ ok: false, why: "no mouse release on it" });
    clickAt(log, 2000, 150, 150);
    expect(corroborateClick(log, RECT, undefined, 2000 + CLICK_WINDOW_MS + 100, ident).ok).toBe(false);
    clickAt(log, 9000, 150, 150);
    expect(corroborateClick(log, RECT, { x: 0.9, y: 0.5 }, 9000, ident)).toMatchObject({ ok: false, why: "reported position does not match the mouse" });
    expect(corroborateClick(log, undefined, undefined, 9000, ident)).toMatchObject({ ok: false, why: "no rect" });
    expect(corroborateClick(log, [0, 0, 0, 10], undefined, 9000, ident)).toMatchObject({ ok: false, why: "no rect" });
  });

  it("ignores releases it cannot map into the client", () => {
    const log = new PressLog();
    clickAt(log, 1000, 150, 150);
    expect(corroborateClick(log, RECT, undefined, 1000, () => null).ok).toBe(false);
    expect(log.releases.length).toBe(1);
  });

  it("maps screen to client coordinates through toClient", () => {
    const log = new PressLog();
    clickAt(log, 1000, 1150, 650); // client at (1000, 500)
    expect(corroborateClick(log, RECT, undefined, 1000, (x, y) => ({ x: x - 1000, y: y - 500 })).ok).toBe(true);
  });
});

// The gate: approvals from the game are checked against what the Glass painted, never against a
// rectangle the addon declares. The Glass covers the game's client area (CLIENT, screen px).
describe("ApprovalGate", () => {
  const CLIENT = { x: 1000, y: 500, width: 2000, height: 1000 };
  const ALLOW = { type: "decide", thread: "q1", requestId: "r1", decision: "allow" };
  const KEY = actKey(ALLOW);
  const BTN: Rect = [0.5, 0.5, 0.05, 0.03]; // screen 2000..2100 x 1000..1030
  const card = (o: object = {}) => ({ act: ALLOW, rect: BTN, card: [0.4, 0.3, 0.4, 0.25], sig: "a", ...o });
  const F9 = bindingToVk("F9")!;
  const press = (log: PressLog, at: number, vk = 0x78, mods: Partial<Sample> = {}) => {
    log.sample(s(at - 10));
    log.sample(s(at, { down: new Set([vk]), ...mods }));
    log.sample(s(at + 10));
  };
  /** Move onto the button at `enter`, press and release at `at`. */
  const click = (log: PressLog, enter: number, at: number, x = 2050, y = 1015) => {
    log.sample(s(enter - 10, { x: 10, y: 10 }));
    log.sample(s(enter, { x, y }));
    log.sample(s(at - 20, { x, y, left: true }));
    log.sample(s(at, { x, y }));
  };
  /** A gate that has shown `list` since t=0 with the game in front. */
  const shown = (list: unknown[] = [card()]) => {
    const g = new ApprovalGate();
    g.setLive(true, 0);
    g.report(list, 0);
    return g;
  };

  it("actKey names the request and the action; a proof covers only the keys it names", () => {
    expect(actKey(ALLOW)).not.toBe(actKey({ ...ALLOW, requestId: "r2" }));
    expect(actKey(ALLOW)).not.toBe(actKey({ ...ALLOW, thread: "q2" }));
    expect(actKey(ALLOW)).not.toBe(actKey({ ...ALLOW, decision: "allowAlways" }));
    expect(actKey({ type: "answer", thread: "q1", requestId: "r1", label: "A" })).not.toBe(actKey({ type: "answer", thread: "q1", requestId: "r1", label: "B" }));
    expect(proofCovers({ ok: true, how: "bind", for: [KEY] }, KEY)).toBe(true);
    expect(proofCovers({ ok: true, how: "bind", for: [KEY] }, actKey({ ...ALLOW, requestId: "r2" }))).toBe(false);
    expect(proofCovers({ ok: true, how: "click" }, KEY)).toBe(false); // a bare "ok" names nothing
    expect(proofCovers({ ok: false, how: "bind", for: [KEY] }, KEY)).toBe(false);
    expect(proofCovers(TRUSTED, KEY)).toBe(true);
    expect(proofCovers({ ...TRUSTED }, KEY)).toBe(false); // only the constant itself
  });

  it("the Approve key approves a card shown, unmoved, for 800 ms before the press; one press, one proof", () => {
    const g = shown();
    const log = new PressLog();
    press(log, STABLE_MS + 100);
    expect(g.proveKey(log, F9, STABLE_MS + 300)).toEqual({ ok: true, how: "bind", for: [KEY] });
    expect(g.proveKey(log, F9, STABLE_MS + 300).ok).toBe(false); // replayed hint: the press is used up
  });

  it("refuses a press before the card settled, a key still held, wrong modifiers, a stale press, no registered key", () => {
    const g = shown();
    const early = new PressLog();
    press(early, STABLE_MS - 100);
    expect(g.proveKey(early, F9, STABLE_MS + 200).ok).toBe(false);
    const held = new PressLog();
    held.sample(s(990));
    held.sample(s(1000, { down: new Set([0x78]) }));
    expect(g.proveKey(held, F9, 1100)).toMatchObject({ ok: false, why: KEY_HELD });
    held.sample(s(1200));
    expect(g.proveKey(held, F9, 1250).ok).toBe(true); // released: the same press now counts
    const mods = new PressLog();
    press(mods, 2000, 0x78, { ctrl: true });
    expect(g.proveKey(mods, F9, 2100)).toMatchObject({ ok: false, why: "Approve key not pressed" });
    const stale = new PressLog();
    press(stale, 2000);
    expect(g.proveKey(stale, F9, 2000 + KEY_WINDOW_MS + 100).ok).toBe(false);
    expect(g.proveKey(stale, undefined, 2100)).toMatchObject({ ok: false, why: "no Approve key registered in the control panel" });
  });

  it("with nothing painted, or the Glass not live, the key proves nothing", () => {
    const log = new PressLog();
    press(log, 2000);
    expect(new ApprovalGate().proveKey(log, F9, 2100).ok).toBe(false);
    const g = new ApprovalGate();
    g.report([card()], 0); // painted, but never live (hidden Glass / game not in front)
    press(log, 3000);
    expect(g.proveKey(log, F9, 3100).ok).toBe(false);
  });

  it("a moved, resized or replaced card waits again; an unchanged report keeps its wait", () => {
    for (const change of [{ rect: [0.5, 0.52, 0.05, 0.03] }, { card: [0.4, 0.3, 0.4, 0.3] }, { sig: "b" }]) {
      const g = shown();
      g.report([card()], 500); // the same card again: no reset
      expect(g.eligibleAt(KEY)).toBe(STABLE_MS);
      g.report([card(change)], 1000);
      expect(g.eligibleAt(KEY)).toBe(1000 + STABLE_MS);
      const log = new PressLog();
      press(log, 1500);
      expect(g.proveKey(log, F9, 1600).ok).toBe(false);
    }
    // A different request in the same place is a different key: the old one is gone at once.
    const g = shown();
    g.report([card({ act: { ...ALLOW, requestId: "r2" } })], 5000);
    expect(g.has(KEY)).toBe(false);
    expect(g.eligibleAt(actKey({ ...ALLOW, requestId: "r2" }))).toBe(5000 + STABLE_MS);
  });

  it("focus loss, a hidden Glass, a window move and a link reconnect void the wait", () => {
    const g = shown();
    g.setLive(false, 2000); // another window in front, or the Glass hidden
    expect(g.eligibleAt(KEY)).toBeUndefined();
    const log = new PressLog();
    press(log, 2100);
    expect(g.proveKey(log, F9, 2200).ok).toBe(false);
    g.setLive(true, 3000);
    expect(g.eligibleAt(KEY)).toBe(3000 + STABLE_MS);
    g.rearm(6000); // window or layout moved, link reconnected
    expect(g.eligibleAt(KEY)).toBe(6000 + STABLE_MS);
    press(log, 6500);
    expect(g.proveKey(log, F9, 6600).ok).toBe(false);
    press(log, 7000);
    expect(g.proveKey(log, F9, 7100).ok).toBe(true);
  });

  it("drops forged reports: oversized buttons, rects outside the Glass, malformed and duplicated entries", () => {
    const g = new ApprovalGate();
    g.setLive(true, 0);
    for (const bad of [
      card({ rect: [0, 0, 1, 1] }), // a screen-sized Approve button
      card({ rect: [0.1, 0.1, 0.6, 0.03] }),
      card({ rect: [0.1, 0.1, 0.05, 0.3] }),
      card({ rect: [0.98, 0.5, 0.05, 0.03] }), // runs off the Glass
      card({ rect: [-0.1, 0.5, 0.05, 0.03] }),
      card({ rect: [0.5, 0.5, 0, 0.03] }),
      card({ rect: [0.5, 0.5, NaN, 0.03] }),
      card({ rect: "0.5,0.5,0.05,0.03" }),
      card({ card: [0, 0, 2, 2] }),
      card({ sig: 7 }),
      card({ act: null }),
      card({ act: { thread: "q1" } }),
      null,
      "x",
    ]) {
      g.report([bad], 0);
      expect(g.size, JSON.stringify(bad)).toBe(0);
    }
    g.report("not a list", 0);
    expect(g.size).toBe(0);
    g.report([card(), card({ rect: [0.1, 0.1, 0.05, 0.03] })], 0); // the same action painted twice: neither counts
    expect(g.size).toBe(0);
    g.report(Array.from({ length: 40 }, (_, i) => card({ act: { ...ALLOW, requestId: "r" + i } })), 0);
    expect(g.size).toBe(16);
  });

  it("a click approves with a release inside the Glass's own button, by a pointer that came onto it after the card settled; once", () => {
    const g = shown();
    const log = new PressLog();
    click(log, STABLE_MS + 100, STABLE_MS + 300);
    expect(g.proveClick(log, KEY, CLIENT, STABLE_MS + 400)).toEqual({ ok: true, how: "click", for: [KEY] });
    expect(g.proveClick(log, KEY, CLIENT, STABLE_MS + 400).ok).toBe(false); // replayed: the release is used up
  });

  it("refuses a click elsewhere, for another request, too early, with a pointer already resting there, a right click, a stale release", () => {
    const g = shown();
    const miss = new PressLog();
    click(miss, 1000, 1200, 1500, 800); // a real click, but not on the button
    expect(g.proveClick(miss, KEY, CLIENT, 1300)).toMatchObject({ ok: false, why: "no mouse release on the Glass button" });
    const other = new PressLog();
    click(other, 1000, 1200);
    expect(g.proveClick(other, actKey({ ...ALLOW, requestId: "r2" }), CLIENT, 1300)).toMatchObject({ ok: false, why: "that button is not on the Glass" });
    expect(g.proveClick(other, KEY, null, 1300).ok).toBe(false); // no game window
    const early = new PressLog();
    click(early, 100, 300);
    expect(g.proveClick(early, KEY, CLIENT, 400)).toMatchObject({ ok: false, why: "the request had not been on the Glass long enough" });
    // Bait: the pointer rests where the button then appears; the next ordinary click must not approve.
    const resting = new PressLog();
    click(resting, 100, 2000);
    expect(g.proveClick(resting, KEY, CLIENT, 2100)).toMatchObject({ ok: false, why: "the pointer was on the button before the request settled" });
    const never = new PressLog(); // no history of the pointer anywhere else
    never.sample(s(1980, { x: 2050, y: 1015, left: true }));
    never.sample(s(2000, { x: 2050, y: 1015 }));
    expect(g.proveClick(never, KEY, CLIENT, 2100).ok).toBe(false);
    const right = new PressLog();
    right.sample(s(990, { x: 10, y: 10 }));
    right.sample(s(1000, { x: 2050, y: 1015, right: true }));
    right.sample(s(1020, { x: 2050, y: 1015 }));
    expect(g.proveClick(right, KEY, CLIENT, 1100).ok).toBe(false);
    const stale = new PressLog();
    click(stale, 1000, 1200);
    expect(g.proveClick(stale, KEY, CLIENT, 1200 + CLICK_WINDOW_MS + 100).ok).toBe(false);
  });

  it("the button follows the game window: the same report is tested where the window is now", () => {
    const g = shown();
    const log = new PressLog();
    click(log, 1000, 1200); // on the button for CLIENT
    expect(g.proveClick(log, KEY, { ...CLIENT, x: 0, y: 0 }, 1300).ok).toBe(false);
    expect(g.proveClick(log, KEY, CLIENT, 1300).ok).toBe(true);
  });
});

describe("bindingToVk", () => {
  it.each([
    ["F9", { vk: 0x78, ctrl: false, shift: false, alt: false }],
    ["ctrl-f9", { vk: 0x78, ctrl: true, shift: false, alt: false }],
    ["SHIFT-ALT-NUMPAD5", { vk: 0x65, ctrl: false, shift: true, alt: true }],
    ["BUTTON4", { vk: 0x05, ctrl: false, shift: false, alt: false }],
    ["-", { vk: 0xbd, ctrl: false, shift: false, alt: false }],
    ["CTRL--", { vk: 0xbd, ctrl: true, shift: false, alt: false }],
    ["A", { vk: 0x41, ctrl: false, shift: false, alt: false }],
    ["7", { vk: 0x37, ctrl: false, shift: false, alt: false }],
    ["F24", { vk: 0x87, ctrl: false, shift: false, alt: false }],
    [" SPACE ", { vk: 0x20, ctrl: false, shift: false, alt: false }],
  ])("%s", (name, want) => expect(bindingToVk(name)).toEqual(want));
  it.each(["MOUSEWHEELUP", "META-A", "", "F25", "CTRL-"])("%s is not verifiable", (name) => expect(bindingToVk(name)).toBeUndefined());
});

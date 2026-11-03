// Pure kernel: matching decisions from the game to physical input on the PC (no journey reaches it
// without Electron + koffi).
import { describe, expect, it } from "vitest";
import { bindingToVk, CLICK_WINDOW_MS, corroborateClick, corroborateKey, PressLog, Rect, Sample } from "../src/main/physical";

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

describe("corroborateKey", () => {
  const press = (log: PressLog, at: number, vk: number, mods: Partial<Sample> = {}) => {
    log.sample(s(at - 10));
    log.sample(s(at, { down: new Set([vk]), ...mods }));
    log.sample(s(at + 10));
  };
  it("passes for the registered key with its modifiers, once", () => {
    const log = new PressLog();
    press(log, 1000, 0x78, { ctrl: true });
    const bind = bindingToVk("CTRL-F9");
    expect(corroborateKey(log, bind, 1200)).toEqual({ ok: true, how: "bind" });
    expect(corroborateKey(log, bind, 1200).ok).toBe(false);
  });
  it("refuses the key without (or with extra) modifiers, a stale press, and no registered key", () => {
    const log = new PressLog();
    press(log, 1000, 0x78);
    expect(corroborateKey(log, bindingToVk("CTRL-F9"), 1100)).toMatchObject({ ok: false, why: "Approve key not pressed" });
    press(log, 2000, 0x78, { ctrl: true, shift: true });
    expect(corroborateKey(log, bindingToVk("CTRL-F9"), 2100).ok).toBe(false);
    press(log, 3000, 0x78);
    expect(corroborateKey(log, bindingToVk("F9"), 3000 + 1600).ok).toBe(false);
    expect(corroborateKey(log, undefined, 3100)).toMatchObject({ ok: false, why: "no Approve key registered in the control panel" });
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

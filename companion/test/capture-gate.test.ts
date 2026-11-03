// Pure kernel: the screen-capture fallback gate (no journey reaches it without Electron + koffi +
// a real desktop). Window facts are plain data here; win32.ts windowsAbove supplies them live.
import { describe, expect, it } from "vitest";
import { intersects, RefusalLog, screenCaptureTrusted, ScreenGateFacts, stripScreenBox } from "../src/main/capture-gate";
import { MAX_COLS, MAX_ROWS } from "../src/link/decoder";

const STRIP = { x: 100, y: 50, width: 400, height: 40 };
const facts = (o: Partial<ScreenGateFacts> = {}): ScreenGateFacts => ({
  captureMode: "screen", foreground: "11", game: "11", overlay: "22", strip: STRIP, covering: [], ...o });

describe("screenCaptureTrusted", () => {
  it("window mode is unaffected, whatever the desktop looks like", () => {
    expect(screenCaptureTrusted(facts({ captureMode: "window", foreground: "99", strip: null, covering: null }))).toEqual({ ok: true });
  });
  it("accepts while the game, or our Glass, is in front and nothing covers the strip", () => {
    expect(screenCaptureTrusted(facts())).toEqual({ ok: true });
    expect(screenCaptureTrusted(facts({ foreground: "22" }))).toEqual({ ok: true });
  });
  it("refuses when another window is in front", () => {
    expect(screenCaptureTrusted(facts({ foreground: "99" }))).toEqual({ ok: false, why: "game is not the foreground window" });
  });
  it("refuses with no game window, no lock, or a game missing from the Z order walk", () => {
    expect(screenCaptureTrusted(facts({ game: null }))).toMatchObject({ ok: false, why: "no game window" });
    expect(screenCaptureTrusted(facts({ game: "0", foreground: "0" }))).toMatchObject({ ok: false, why: "no game window" });
    expect(screenCaptureTrusted(facts({ strip: null }))).toMatchObject({ ok: false, why: "no strip lock" });
    expect(screenCaptureTrusted(facts({ covering: null }))).toMatchObject({ ok: false, why: "game window not found in Z order" });
  });
  it("refuses when a window above the game overlaps the strip, naming its exe and class but never its title", () => {
    const v = screenCaptureTrusted(facts({ covering: [{ exe: "chrome.exe", cls: "Chrome_WidgetWin_1" }] }));
    expect(v).toEqual({ ok: false, why: "another window covers the strip (chrome.exe, class Chrome_WidgetWin_1)" });
  });
});

describe("stripScreenBox", () => {
  it("is the capture's decode region (max strip plus margin) moved to screen px by the frame origin", () => {
    const b = stripScreenBox({ x: 10, y: 20, pitch: 2 }, { x: -1920, y: 0 });
    expect(b).toEqual({ x: -1920 + 10 - 6, y: 20 - 6, width: MAX_COLS * 2 + 12, height: MAX_ROWS * 2 + 12 });
  });
  it("rounds outward for fractional locks and pitches", () => {
    const b = stripScreenBox({ x: 10.6, y: 20.4, pitch: 1.5 }, { x: 0, y: 0 });
    expect(b.x).toBe(4);
    expect(b.y).toBe(14);
    expect(b.x + b.width).toBeGreaterThanOrEqual(10.6 + MAX_COLS * 1.5 + 6);
    expect(b.y + b.height).toBeGreaterThanOrEqual(20.4 + MAX_ROWS * 1.5 + 6);
  });
});

describe("intersects", () => {
  it("counts any shared area, not touching edges", () => {
    expect(intersects(STRIP, { x: 499, y: 89, width: 10, height: 10 })).toBe(true);
    expect(intersects(STRIP, { x: 500, y: 50, width: 10, height: 10 })).toBe(false);
    expect(intersects(STRIP, { x: 100, y: 0, width: 10, height: 50 })).toBe(false);
    expect(intersects(STRIP, { x: 0, y: 0, width: 4000, height: 4000 })).toBe(true);
  });
});

describe("RefusalLog", () => {
  it("logs at most once per interval", () => {
    const r = new RefusalLog(5000);
    expect([0, 100, 4999, 5000, 6000, 10000].map((t) => r.shouldLog(t))).toEqual([true, false, false, true, false, true]);
  });
});

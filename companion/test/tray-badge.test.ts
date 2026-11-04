// The tray's state at a glance: which badge and which tooltip for what is happening (pure; main.ts
// paints the badge onto tray.png / tray@2x.png and sets the tooltip on every push).
import { describe, expect, it } from "vitest";
import { paintBadge, trayBadgeFor } from "../src/main/tray-badge";

describe("tray badge and tooltip", () => {
  it("say what is happening in counts, never names; a waiting request outranks work", () => {
    const work = (working: number, approvals: number) => ({ working, approvals });
    expect(trayBadgeFor(null, false)).toEqual({ badge: "none", tooltip: "Familiar" });
    expect(trayBadgeFor(work(0, 0), false)).toEqual({ badge: "none", tooltip: "Familiar" });
    expect(trayBadgeFor(work(2, 0), false)).toEqual({ badge: "working", tooltip: "Familiar · 2 working" });
    expect(trayBadgeFor(work(0, 1), false)).toEqual({ badge: "waiting", tooltip: "Familiar · 1 waiting on you" });
    expect(trayBadgeFor(work(2, 1), false)).toEqual({ badge: "waiting", tooltip: "Familiar · 2 working · 1 waiting on you" });
    // A request too long for the in-game card keeps its own words.
    expect(trayBadgeFor(work(1, 1), true)).toEqual({ badge: "waiting", tooltip: "Familiar: a request is waiting on your PC" });
    expect(trayBadgeFor(null, true)).toEqual({ badge: "waiting", tooltip: "Familiar: a request is waiting on your PC" });
  });

  it("the badge sits in the bottom-right corner at 16 and 32 px and leaves the rest of the face alone", () => {
    const px = (b: Buffer, size: number, x: number, y: number) => [...b.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    for (const size of [16, 32]) {
      const k = size / 16;
      const face = () => Buffer.alloc(size * size * 4, 0x40); // stand-in art: one premultiplied grey
      expect(paintBadge(face(), size, "none")).toEqual(face());
      const working = paintBadge(face(), size, "working");
      expect(px(working, size, 12 * k, 12 * k)).toEqual([0x6b, 0xd9, 0x7d, 255]); // ok green, BGRA
      expect(px(working, size, 4 * k, 4 * k)).toEqual([0x40, 0x40, 0x40, 0x40]);
      const waiting = paintBadge(face(), size, "waiting");
      expect(px(waiting, size, 13 * k, 11 * k)).toEqual([0x40, 0x80, 0xff, 255]); // warn orange
      expect(px(waiting, size, 11 * k, 10 * k)).toEqual([0x0d, 0x0a, 0x0b, 255]); // the "!": bar,
      expect(px(waiting, size, 11 * k, 12 * k)).toEqual([0x40, 0x80, 0xff, 255]); // gap,
      expect(px(waiting, size, 11 * k, 13 * k)).toEqual([0x0d, 0x0a, 0x0b, 255]); // dot
      expect(px(waiting, size, 4 * k, 4 * k)).toEqual([0x40, 0x40, 0x40, 0x40]);
    }
  });
});

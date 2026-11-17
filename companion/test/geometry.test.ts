// Display maths (main/geometry.ts) at 150% scaling with a maximized window: the owner's real case
// is a 5120x2160 monitor at 150% whose maximized WoW has a 5120x2088 extended frame at 0,0 and a
// 5120x2054 client at 0,34 (physical px).
import { describe, expect, it } from "vitest";
import { clientCorners, clientInFrame, CORNER_H, CORNER_W, physicalOrigin } from "../src/main/geometry";

const frame = { x: 0, y: 0, width: 5120, height: 2088 };
const client = { x: 0, y: 34, width: 5120, height: 2054 };
const inside = (r: { x: number; y: number; w: number; h: number }, x: number, y: number, w: number, h: number) =>
  x >= r.x && y >= r.y && x + w <= r.x + r.w && y + h <= r.y + r.h;

describe("display geometry", () => {
  it("places a display's origin in physical px at 150%", () => {
    expect(physicalOrigin({ x: 0, y: 0 }, 1.5)).toEqual({ x: 0, y: 0 });
    // A second 5120-px monitor to the right is 3413 DIP across (5119.5 px): rounds to its true edge.
    expect(physicalOrigin({ x: 3413, y: 0 }, 1.5)).toEqual({ x: 5120, y: 0 });
    expect(physicalOrigin({ x: -2560, y: -1440 }, 1.5)).toEqual({ x: -3840, y: -2160 });
  });

  it("puts the client inside the captured frame", () => {
    // Window capture: the frame is the window's extended frame; the title bar is 34 px at 150%.
    expect(clientInFrame(client, frame)).toEqual({ x: 0, y: 34, width: 5120, height: 2054 });
    // Screen capture of a second monitor to the right: the frame is that monitor.
    expect(clientInFrame({ ...client, x: 5120 }, physicalOrigin({ x: 3413, y: 0 }, 1.5))).toEqual({ x: 0, y: 34, width: 5120, height: 2054 });
  });

  it("searches the four client corners, top-left first, inside the frame", () => {
    const c = clientCorners(frame, clientInFrame(client, frame));
    // 4 px of slack around the client, clipped at the frame's left, right and bottom edges.
    expect(c).toEqual([
      { x: 0, y: 30, w: CORNER_W - 4, h: CORNER_H },
      { x: 5120 - CORNER_W + 4, y: 30, w: CORNER_W - 4, h: CORNER_H },
      { x: 0, y: 34 + 2054 + 4 - CORNER_H, w: CORNER_W - 4, h: CORNER_H - 4 },
      { x: 5120 - CORNER_W + 4, y: 34 + 2054 + 4 - CORNER_H, w: CORNER_W - 4, h: CORNER_H - 4 },
    ]);
    // The default strip (64x4 cells of 4 px) and the idle beacon (32x1) fit their corner at every anchor.
    for (const [w, h] of [[256, 16], [128, 4]]) {
      expect(inside(c[0], 0, 34, w, h)).toBe(true);
      expect(inside(c[1], 5120 - w, 34, w, h)).toBe(true);
      expect(inside(c[2], 0, 34 + 2054 - h, w, h)).toBe(true);
      expect(inside(c[3], 5120 - w, 34 + 2054 - h, w, h)).toBe(true);
    }
  });

  it("windowed at 150%: corners follow the client, not the monitor", () => {
    // Screen capture of the monitor with WoW windowed at 1000,500 (client 1920x1080).
    const c = clientCorners({ width: 5120, height: 2160 }, { x: 1000, y: 500, width: 1920, height: 1080 });
    expect(c[0]).toEqual({ x: 996, y: 496, w: CORNER_W, h: CORNER_H });
    expect(c[3]).toEqual({ x: 1000 + 1920 + 4 - CORNER_W, y: 500 + 1080 + 4 - CORNER_H, w: CORNER_W, h: CORNER_H });
  });
});

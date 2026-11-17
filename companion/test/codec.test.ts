import { describe, expect, it } from "vitest";
import {
  chunkMessage,
  crc16,
  encodeFrameCells,
  finderRgb,
  FLAG_REPEAT,
  Frame,
  LEVELS,
  payloadCapacity,
  Reassembler,
  symbolToRgb,
} from "../src/link/codec";
import { acquire, findStrip, lockBox, Rgba, StripDecoder, View } from "../src/link/decoder";
import { clientCorners } from "../src/main/geometry";
import { LuaVM } from "./lua";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Render a cell grid into an RGBA image, optionally with fractional pitch, gamma and blur.
 * `levels` draws the grey ramp and the symbols at other channel levels (an older palette, say). */
function render(
  cells: ArrayLike<number>,
  cols: number,
  rows: number,
  opts: { w?: number; h?: number; x?: number; y?: number; pitch?: number; gamma?: number; noise?: number; bg?: number; levels?: readonly number[] } = {},
): Rgba {
  const w = opts.w ?? 400,
    h = opts.h ?? 80;
  const pitch = opts.pitch ?? 4;
  const ox = opts.x ?? 0,
    oy = opts.y ?? 0;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = opts.bg ?? 30;
    data[i * 4 + 1] = (opts.bg ?? 30) + 10;
    data[i * 4 + 2] = (opts.bg ?? 30) + 5;
    data[i * 4 + 3] = 255;
  }
  const g = opts.gamma ?? 1;
  const tone = (v: number) => Math.round(255 * Math.pow(v / 255, g));
  for (let py = 0; py < h; py++) {
    for (let pxx = 0; pxx < w; pxx++) {
      // Area-sample the pixel against the cell grid (simulates non-integer UI scale blending).
      let acc = [0, 0, 0],
        cover = 0;
      const S = 3;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const fx = (pxx + (sx + 0.5) / S - ox) / pitch;
          const fy = (py + (sy + 0.5) / S - oy) / pitch;
          if (fx < 0 || fy < 0 || fx >= cols || fy >= rows) continue;
          const v = cells[Math.floor(fy) * cols + Math.floor(fx)];
          const L = opts.levels;
          const rgb = v < 0 ? (L && v <= -3 && v >= -6 ? [L[-v - 3], L[-v - 3], L[-v - 3]] : finderRgb(-v - 1)) : L ? symbolToRgb(v).map((c) => L[LEVELS.indexOf(c as 0)]) : symbolToRgb(v);
          acc = acc.map((a, k) => a + rgb[k]);
          cover++;
        }
      if (!cover) continue;
      const o = (py * w + pxx) * 4;
      for (let k = 0; k < 3; k++) {
        const base = data[o + k];
        const mixed = (acc[k] + base * (S * S - cover)) / (S * S);
        const n = opts.noise ? (Math.random() - 0.5) * 2 * opts.noise : 0;
        data[o + k] = Math.max(0, Math.min(255, tone(mixed) + n));
      }
    }
  }
  return { width: w, height: h, data };
}

/** Simulate Chromium's ARGB->I420 (BT.601 limited, 2x2 chroma) round trip. */
function i420(img: Rgba): Rgba {
  const { width: w, height: h, data } = img;
  const Y = new Float32Array(w * h), U = new Float32Array(w * h), V = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    Y[i] = 16 + 0.257 * r + 0.504 * g + 0.098 * b;
    U[i] = 128 - 0.148 * r - 0.291 * g + 0.439 * b;
    V[i] = 128 + 0.439 * r - 0.368 * g - 0.071 * b;
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const bx = x & ~1, by = y & ~1;
      let u = 0, v = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const j = Math.min(h - 1, by + dy) * w + Math.min(w - 1, bx + dx);
        u += U[j] / 4;
        v += V[j] / 4;
      }
      const yy = Math.round(Y[y * w + x]), uu = Math.round(u), vv = Math.round(v);
      const c = yy - 16, dd = uu - 128, e = vv - 128;
      const o = (y * w + x) * 4;
      out[o] = 1.164 * c + 1.596 * e;
      out[o + 1] = 1.164 * c - 0.392 * dd - 0.813 * e;
      out[o + 2] = 1.164 * c + 2.017 * dd;
      out[o + 3] = 255;
    }
  return { width: w, height: h, data: out };
}

const frame = (payload: string, extra: Partial<Frame> = {}): Frame => ({
  cols: 64,
  rows: 4,
  seq: 1234,
  flags: 0,
  msgId: 4321,
  chunkIdx: 0,
  chunkCount: 1,
  payload: enc.encode(payload),
  ...extra,
});

describe("codec", () => {
  it("crc16 matches CCITT-FALSE check value", () => {
    expect(crc16(enc.encode("123456789"))).toBe(0x29b1);
  });

  it("decodes a clean render", () => {
    const f = frame('{"t":"prompt","text":"hello familiar"}');
    const img = render(encodeFrameCells(f), 64, 4);
    const lock = findStrip(img)!;
    expect(lock).toBeTruthy();
    const r = acquire(img, lock);
    expect(r.ok).toBe(true);
    if (r.ok) expect(dec.decode(r.frame.payload)).toBe('{"t":"prompt","text":"hello familiar"}');
  });

  it("survives fractional pitch, offset, gamma and noise", () => {
    const text = "x".repeat(payloadCapacity(64, 4));
    const f = frame(text);
    for (const [pitch, gamma, x, y] of [
      [3.6, 1.0, 17.3, 5.5],
      [4.4, 0.7, 2.2, 0.0],
      [5.0, 1.6, 100, 30],
      [3.2, 1.25, 0.5, 0.5],
    ]) {
      const img = render(encodeFrameCells(f), 64, 4, { pitch, gamma, x, y, noise: 6, w: 420 });
      const dec2 = new StripDecoder(0);
      const r = dec2.decode(img);
      expect(r.ok, `pitch=${pitch} gamma=${gamma} reason=${!r.ok && r.reason}`).toBe(true);
      if (r.ok) expect(r.frame.payload.length).toBe(text.length);
    }
  });

  it("survives I420 chroma subsampling (live capture path) at odd and fractional offsets", () => {
    const text = "y".repeat(payloadCapacity(64, 4));
    for (const [x, y, pitch] of [
      [1, 38, 4],
      [0.6, 37, 3.99],
      [3, 5, 4],
      [2.5, 11.5, 5],
    ]) {
      const img = i420(render(encodeFrameCells(frame(text)), 64, 4, { pitch, x, y, w: 420, h: 80 }));
      const r = new StripDecoder(0).decode(img);
      expect(r.ok, `x=${x} y=${y} pitch=${pitch} ${!r.ok && r.reason}`).toBe(true);
    }
  });

  it("decodes under gamma, noise and I420", () => {
    const text = "z".repeat(payloadCapacity(64, 4));
    for (const [gamma, x, y] of [
      [1.0, 1, 38],
      [1.25, 0, 0],
      [0.8, 3, 7],
    ]) {
      const img = i420(render(encodeFrameCells(frame(text)), 64, 4, { pitch: 4, gamma, x, y, noise: 2, w: 420, h: 80 }));
      const r = new StripDecoder(0).decode(img);
      expect(r.ok, `gamma=${gamma} ${!r.ok && r.reason}`).toBe(true);
    }
  });

  it("reassembles chunked messages and drops repeats", () => {
    const got: string[] = [];
    const ra = new Reassembler((_, p) => got.push(dec.decode(p)));
    const msg = "The quick brown fox ".repeat(40);
    const chunks = chunkMessage(enc.encode(msg), 7, 64, 4);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) ra.push({ ...c, seq: 0, flags: 0 });
    for (const c of chunks) ra.push({ ...c, seq: 0, flags: FLAG_REPEAT });
    expect(got).toEqual([msg]);
    // same msgId, different content (msgId reuse after /reload) still delivers
    for (const c of chunkMessage(enc.encode("different"), 7, 64, 4)) ra.push({ ...c, seq: 0, flags: 0 });
    expect(got).toEqual([msg, "different"]);
  });
});

/** Deterministic pseudo-random numbers in [0, 1). */
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
/** Apply a colour transform to every pixel (what the client, the driver or HDR does to the strip). */
function tone(img: Rgba, f: (r: number, g: number, b: number) => number[]): Rgba {
  const d = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = f(img.data[i], img.data[i + 1], img.data[i + 2]);
    d[i] = clamp255(r);
    d[i + 1] = clamp255(g);
    d[i + 2] = clamp255(b);
    d[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: d };
}
const each = (f: (v: number) => number) => (r: number, g: number, b: number) => [f(r), f(g), f(b)];
const steps = (a: number, b: number, s: number) => Array.from({ length: Math.round((b - a) / s) + 1 }, (_, i) => Math.round((a + i * s) * 1000) / 1000);
/** A full frame whose bytes put every level on every channel. */
const varied = (() => {
  const p = new Uint8Array(payloadCapacity(64, 4));
  for (let i = 0; i < p.length; i++) p[i] = (i * 37 + 11) & 255;
  return encodeFrameCells({ cols: 64, rows: 4, seq: 7, flags: 0, msgId: 9, chunkIdx: 0, chunkCount: 1, payload: p });
})();
/** Paste `src` into `dst` at (x, y). */
function paste(dst: Rgba, src: Rgba, x: number, y: number) {
  for (let r = 0; r < src.height; r++) dst.data.set(src.data.subarray(r * src.width * 4, (r + 1) * src.width * 4), ((y + r) * dst.width + x) * 4);
}
/** Cut a view (frame px offset kept) out of a frame, as the capture page reads one. */
function cut(img: Rgba, b: { x: number; y: number; w: number; h: number }): View {
  const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y));
  const w = Math.min(img.width, Math.ceil(b.x + b.w)) - x, h = Math.min(img.height, Math.ceil(b.y + b.h)) - y;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) data.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return { width: w, height: h, data, ox: x, oy: y };
}
/** A game-like frame: muted noisy scenery. */
function scenery(w: number, h: number, seed = 1): Rgba {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 70 + rand() * 60;
    data[i + 1] = 55 + rand() * 50;
    data[i + 2] = 40 + rand() * 40;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

// The passing envelope of the shipped levels (0/28/56/84) through a live-like path: the client or
// HDR bends the colours, then the capture's I420 conversion. Pinned so a regression shows; widen
// the pins when the decoder improves. Outside the envelope a clipped or crushed ramp must say
// "ramp" (Link Doctor: HDR or a colour filter), never just "not found".
describe("decoder envelope", () => {
  const base = render(varied, 64, 4, { pitch: 4, x: 3, y: 5, w: 420, h: 80 });
  const read = (img: Rgba) => {
    const r = new StripDecoder(0).decode(i420(img));
    return r.ok ? "ok" : r.reason;
  };
  const reads: [string, number[], (v: number) => (r: number, g: number, b: number) => number[]][] = [
    ["gain, clipping at 255", steps(0.3, 4.5, 0.1), (v) => each((x) => x * v)],
    ["lift", steps(0, 150, 10), (v) => each((x) => x + v)],
    ["washed out (HDR to SDR)", steps(0, 150, 10), (v) => each((x) => v + x * (1 - v / 255))],
    ["gamma", steps(0.3, 2, 0.1), (v) => each((x) => 255 * Math.pow(x / 255, v))],
    ["dimming", steps(0.25, 1, 0.05), (v) => each((x) => x * v)],
    ["night light (blue and some green cut)", steps(0.25, 1, 0.05), (v) => (r, g, b) => [r, g * (0.5 + v / 2), b * v]],
    ["contrast", steps(0.4, 1.2, 0.1), (v) => each((x) => 128 + (x - 128) * v)],
  ];
  for (const [name, values, f] of reads)
    it(`reads under ${name} from ${values[0]} to ${values[values.length - 1]}`, () => {
      for (const v of values) expect(read(tone(base, f(v))), `${name} ${v}`).toBe("ok");
    });

  it("says ramp when the grey steps clip or crush together", () => {
    for (const [name, f] of [
      ["gain 6", each((x) => x * 6)],
      ["gain 10", each((x) => x * 10)],
      ["gamma 2.4", each((x) => 255 * Math.pow(x / 255, 2.4))],
      ["contrast 1.6", each((x) => 128 + (x - 128) * 1.6)],
    ] as const)
      expect(read(tone(base, f)), name).toBe("ramp");
  });

  it("the owner's client: the old full-range ramp clips, the shipped levels read", () => {
    // This client drew 0/85/170/255 as 0/157/255/255.
    const brighter = each((x) => x * 1.85);
    const vivid = render(varied, 64, 4, { pitch: 4, x: 3, y: 5, w: 420, h: 80, levels: [0, 85, 170, 255] });
    const r = new StripDecoder(0).decode(i420(tone(vivid, brighter)));
    expect(r.ok ? "ok" : r.reason).toBe("ramp");
    if (!r.ok) expect(r.levels!.map((l) => l[3] - l[2]).every((d) => d < 3)).toBe(true);
    expect(read(tone(base, brighter))).toBe("ok");
  });
});

describe("decoder search", () => {
  it("never locks on scenery, colour bars or finder look-alikes", () => {
    const W = 320, H = 180;
    const fill = (f: (x: number, y: number) => number[]): Rgba => {
      const data = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const [r, g, b] = f(x, y);
          data.set([r, g, b, 255], (y * W + x) * 4);
        }
      return { width: W, height: H, data };
    };
    const rand = rng(7);
    const M = [255, 0, 255], G = [0, 255, 0], C = [0, 255, 255], Y = [255, 255, 0], K = [0, 0, 0];
    const palette = [M, G, C, Y, K, [28, 28, 28], [56, 56, 56], [84, 84, 84]];
    const cells = Array.from({ length: (W / 4) * (H / 4) }, () => palette[Math.floor(rand() * palette.length)]);
    const hue = (x: number) => {
      const h = (x / W) * 6, k = (n: number) => 255 * Math.max(0, Math.min(1, Math.abs(((h + n) % 6) - 3) - 1));
      return [k(0), k(4), k(2)];
    };
    const images: [string, Rgba][] = [
      ["random noise", fill(() => [rand() * 256, rand() * 256, rand() * 256])],
      ["game-like scenery", scenery(W, H)],
      ["hue sweep", fill((x, y) => hue(x).map((c) => c * (1 - y / H)))],
      ["colour bars", fill((x) => [[255, 255, 255], Y, C, G, M, [255, 0, 0], [0, 0, 255], K][Math.floor(x / 40)])],
      ["magenta and green checkerboard", fill((x, y) => ((x >> 2) + (y >> 2)) % 2 ? M : G)],
      ["random cells of the strip's own colours", fill((x, y) => cells[(y >> 2) * (W / 4) + (x >> 2)])],
      ["finder colours with a coloured ramp", fill((x, y) => (y >> 2) % 3 ? [40, 40, 40] : [M, G, [255, 0, 0], [0, 0, 255], [255, 128, 0], [128, 0, 255], C, Y][(x >> 2) % 8])],
    ];
    for (const [name, img] of images) {
      const d = new StripDecoder(0);
      for (const view of [img, i420(img)]) {
        const r = d.decode(view);
        expect(r.ok, name).toBe(false);
        expect(d.lock, name).toBeNull();
      }
      // Cells of the strip's own colours can line up as a finder (at some pitch); only the CRC
      // then keeps them from locking. Everything else is rejected before that.
      if (!name.startsWith("random cells")) expect(findStrip(img), name).toBeNull();
    }
    // A real finder over cells that are not a frame: seen, never locked.
    const fake = render(Int16Array.from({ length: 256 }, (_, i) => (i < 8 ? -1 - i : Math.floor(rand() * 64))), 64, 4, { pitch: 4, x: 3, y: 5, w: 420, h: 80 });
    const d = new StripDecoder(0);
    expect(findStrip(fake)).not.toBeNull();
    expect(d.decode(fake).ok).toBe(false);
    expect(d.lock).toBeNull();
  });

  it("a locked strip whose ramp collapses keeps its lock and says ramp, then reads again", () => {
    const base = render(varied, 64, 4, { pitch: 4, x: 3, y: 5, w: 420, h: 80 });
    const d = new StripDecoder(0);
    expect(d.decode(base, 0).ok).toBe(true);
    const r = d.decode(tone(base, each((x) => x * 10)), 100);
    expect(r.ok ? "ok" : r.reason).toBe("ramp");
    expect(d.lock).not.toBeNull();
    expect(d.decode(base, 200).ok).toBe(true);
  });

  it("finds a bottom-left strip in the owner's maximized 150% window through the corner regions", () => {
    // 5120x2088 frame (extended frame bounds), client 5120x2054 at 0,34; strip anchored BOTTOMLEFT.
    const frame = { width: 5120, height: 2088 }, client = { x: 0, y: 34, width: 5120, height: 2054 };
    const img = scenery(frame.width, frame.height, 3);
    paste(img, render(varied, 64, 4, { pitch: 4, w: 256, h: 16 }), 0, client.y + client.height - 16);
    // Stray pink in the scenery above it, some of it followed by green: the old 400-candidate cap gave up.
    const rand = rng(11);
    for (let k = 0; k < 3000; k++) {
      const x = Math.floor(rand() * 5000), y = 40 + Math.floor(rand() * 1800);
      for (let dy = 0; dy < 4; dy++)
        for (let dx = 0; dx < 8; dx++) img.data.set(dx < 4 ? [235, 40, 225] : k % 2 ? [20, 230, 30] : [90, 80, 70], ((y + dy) * frame.width + x + dx) * 4);
    }
    const hints = clientCorners(frame, client);
    // Between whole-frame searches only the four corners are read, and they are enough.
    const quick = new StripDecoder({ hints, budgetMs: 1000 });
    quick.plan(0, frame.width, frame.height); // (the whole-frame turn, not taken here)
    const corners = quick.plan(300, frame.width, frame.height);
    expect(corners).toEqual(hints);
    expect(quick.decode(corners.map((b) => cut(img, b)), 300).ok).toBe(true);
    // The first search reads the whole frame but tries the corners first.
    const d = new StripDecoder({ hints, budgetMs: 1000 });
    const boxes = d.plan(0, frame.width, frame.height);
    expect(boxes).toEqual([{ x: 0, y: 0, w: frame.width, h: frame.height }]);
    const r = d.decode(boxes.map((b) => cut(img, b)), 0);
    expect(r.ok, !r.ok ? r.reason : "").toBe(true);
    expect(d.lock!.x).toBeCloseTo(0, 0);
    expect(d.lock!.y).toBeCloseTo(client.y + client.height - 16, 0);
    // Locked: only the strip's box is read from the next frame, and it decodes from that box alone.
    const [box] = d.plan(100, frame.width, frame.height);
    const want = lockBox(d.lock!); // clipped to the frame
    expect(box).toEqual({ x: Math.max(0, want.x), y: want.y, w: want.w + Math.min(0, want.x), h: frame.height - want.y });
    expect(d.decode([cut(img, box)], 100).ok).toBe(true);
  });

  it("plans corner searches often and whole-frame searches now and then", () => {
    const frame = { width: 1920, height: 1080 };
    const d = new StripDecoder({ hints: clientCorners(frame, { x: 0, y: 0, ...frame }) });
    const empty = scenery(frame.width, frame.height);
    const whole = [{ x: 0, y: 0, w: frame.width, h: frame.height }];
    const step = (now: number) => {
      const boxes = d.plan(now, frame.width, frame.height);
      if (boxes.length) expect(d.decode(boxes.map((b) => cut(empty, b)), now).ok).toBe(false);
      return boxes;
    };
    expect(step(0)).toEqual(whole);
    expect(step(100)).toEqual([]);
    expect(step(300)).toHaveLength(4);
    expect(step(400)).toEqual([]);
    expect(step(600)).toHaveLength(4);
    expect(step(2100)).toEqual(whole);
  });

  it("a search out of time resumes where it stopped, so the whole frame is covered", () => {
    // No corner hints and a frame full of finder-like candidates: each search gets 2 ms.
    const W = 1600, H = 1200;
    const img = scenery(W, H, 5);
    for (let y = 0; y < H - 40; y += 6)
      for (let x = 0; x < W - 8; x += 10)
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 8; dx++) img.data.set(dx < 4 ? [235, 40, 225] : [20, 230, 30], ((y + dy) * W + x + dx) * 4);
    paste(img, render(varied, 64, 4, { pitch: 4, w: 256, h: 16 }), 700, H - 20);
    const d = new StripDecoder({ searchEveryMs: 0, budgetMs: 2 });
    let searches = 0;
    while (!d.decode(img, searches).ok && searches < 2000) searches++;
    expect(searches).toBeGreaterThan(0); // one search could not cover it...
    expect(searches).toBeLessThan(2000); // ...but the searches together did
    expect(d.lock!.y).toBeCloseTo(H - 20, 0);
  });

  it("keeps its lock in frame coordinates across views cut at different offsets", () => {
    const img = scenery(1400, 700, 9);
    paste(img, render(varied, 64, 4, { pitch: 5, w: 320, h: 20 }), 1003, 505);
    const d = new StripDecoder(0);
    expect(d.decode([cut(img, { x: 900, y: 400, w: 500, h: 300 })]).ok).toBe(true);
    expect(d.lock).toMatchObject({ x: 1003, y: 505, pitch: 5 });
    expect(d.decode([cut(img, d.plan(0, img.width, img.height)[0])]).ok).toBe(true);
    expect(d.lock).toMatchObject({ x: 1003, y: 505, pitch: 5 });
  });
});

describe("lua parity", () => {
  const vm = new LuaVM();
  vm.loadAddon("Json.lua", "Link.lua");

  it("lua crc16 matches", () => {
    const out = vm.run(`
      local s = "123456789"; local b = {}
      for i = 1, #s do b[i] = s:byte(i) end
      return tostring(NS.Link.crc16(b, #b))`);
    expect(Number(out)).toBe(0x29b1);
  });

  it("lua frame cells equal TS frame cells", () => {
    const payload = 'héllo "familiar" \n' + "z".repeat(90);
    const luaCells = vm
      .run(`return table.concat(NS.Link.encodeFrame(64, 4, 1234, 0, 4321, 0, 1, ${luaStr(payload)}), ",")`)
      .split(",")
      .map(Number);
    const tsCells = Array.from(encodeFrameCells(frame(payload)));
    expect(luaCells).toEqual(tsCells);
  });

  it("lua scheduler output decodes end-to-end", () => {
    const got: string[] = [];
    const ra = new Reassembler((_, p) => got.push(dec.decode(p)));
    const msg = JSON.stringify({ t: "prompt", text: "Refactor the ingest loop ".repeat(20) });
    vm.run(`NS.Link.Enqueue(${luaStr(msg)}, { reliable = true })`);
    const decoder = new StripDecoder(0);
    for (let t = 0; t < 80; t++) {
      const out = vm.run(`
        local cells, cols, rows = NS.Link.Step(${(t * 0.02 + 10).toFixed(2)})
        if not cells then return "" end
        return cols .. ";" .. rows .. ";" .. table.concat(cells, ",")`);
      if (!out) continue;
      const [cols, rows, list] = out.split(";");
      const img = render(list.split(",").map(Number), Number(cols), Number(rows), { pitch: 4, w: 300, h: 24 });
      const r = decoder.decode(img);
      if (r.ok) ra.push(r.frame);
    }
    expect(got).toEqual([msg]);
  });

  it("lua levels and finder cells match TS", () => {
    const out = vm.run(`local r,g,b = NS.Link.symbolColor(0x39) local F = math.floor local t = { F(r*255+0.5), F(g*255+0.5), F(b*255+0.5) } for i = 1, 8 do local fr, fg, fb = NS.Link.FinderColor(i) t[#t+1] = F(fr*255+0.5) t[#t+1] = F(fg*255+0.5) t[#t+1] = F(fb*255+0.5) end return table.concat(t, ",")`);
    const n = out.split(",").map(Number);
    expect(n.slice(0, 3)).toEqual(symbolToRgb(0x39));
    for (let i = 0; i < 8; i++) expect(n.slice(3 + i * 3, 6 + i * 3), `finder ${i}`).toEqual([...finderRgb(i)]);
  });

  it("lua json encodes like JSON.stringify for simple tables", () => {
    const out = vm.run(`return NS.Json.encode({ t = "new", agent = "codex", n = 3, f = 0.25, ok = true, list = {1, 2, "a"}, s = "q\\"\\n\\t" })`);
    expect(JSON.parse(out)).toEqual({ t: "new", agent: "codex", n: 3, f: 0.25, ok: true, list: [1, 2, "a"], s: 'q"\n\t' });
  });
});

function luaStr(s: string): string {
  // Lua long-bracket string that is safe for any content without ]==]
  const bytes = Buffer.from(s, "utf8");
  return '"' + Array.from(bytes, (b) => "\\" + b.toString().padStart(3, "0")).join("") + '"';
}

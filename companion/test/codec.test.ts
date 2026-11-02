import { describe, expect, it } from "vitest";
import {
  chunkMessage,
  crc16,
  encodeFrameCells,
  FINDER,
  finderRgb,
  FLAG_REPEAT,
  Frame,
  payloadCapacity,
  Reassembler,
  symbolToRgb,
} from "../src/link/codec";
import { acquire, findStrip, Rgba, StripDecoder } from "../src/link/decoder";
import { LuaVM } from "./lua";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Render a cell grid into an RGBA image, optionally with fractional pitch, gamma and blur. */
function render(
  cells: ArrayLike<number>,
  cols: number,
  rows: number,
  opts: { w?: number; h?: number; x?: number; y?: number; pitch?: number; gamma?: number; noise?: number; bg?: number; palette?: "vivid" | "dim" } = {},
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
          const rgb = v < 0 ? finderRgb(-v - 1, opts.palette) : symbolToRgb(v, opts.palette);
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

  it("dim palette decodes under gamma, noise and I420", () => {
    const text = "z".repeat(payloadCapacity(64, 4));
    for (const [gamma, x, y] of [
      [1.0, 1, 38],
      [1.25, 0, 0],
      [0.8, 3, 7],
    ]) {
      const img = i420(render(encodeFrameCells(frame(text)), 64, 4, { pitch: 4, gamma, x, y, noise: 2, w: 420, h: 80, palette: "dim" }));
      const r = new StripDecoder(0).decode(img);
      expect(r.ok, `dim gamma=${gamma} ${!r.ok && r.reason}`).toBe(true);
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

  it("lua palettes match TS palettes", () => {
    for (const pal of ["vivid", "dim"] as const) {
      const out = vm.run(`NS.Link.SetPalette("${pal}") local r,g,b = NS.Link.symbolColor(0x39) local fr = NS.Link.FinderColor(6) NS.Link.SetPalette("vivid") local F = math.floor return string.format("%d,%d,%d,%d", F(r*255+0.5), F(g*255+0.5), F(b*255+0.5), F(fr*255+0.5))`);
      const [r, g, b, ramp3] = out.split(",").map(Number);
      expect([r, g, b]).toEqual(symbolToRgb(0x39, pal));
      expect(ramp3).toBe(finderRgb(5, pal)[0]);
    }
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

// Runestrip codec — the byte-level protocol shared by the addon (Lua, addon/Familiar/Link.lua)
// and the companion (this file). See docs/protocol.md. Any change here must be mirrored in Lua
// and covered by test/codec.test.ts (which cross-checks against the Lua implementation).

export const MAGIC = 0x46; // 'F'
export const VERSION = 1;
export const HEADER_BYTES = 13;
export const CRC_BYTES = 2;
export const FINDER_CELLS = 8;

/** Channel levels for a 2-bit symbol component, per palette. The decoder never needs to know which
 * palette is in use: it calibrates from the grey ramp (finder cells 2..5), drawn in the same levels. */
export const PALETTES = {
  vivid: [0, 85, 170, 255],
  dim: [0, 28, 56, 84],
} as const;
export type Palette = keyof typeof PALETTES;
export const LEVELS = PALETTES.vivid;

/** Finder + calibration cells at the start of row 0, as RGB triples. */
export const FINDER: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 255], // magenta  — finder
  [0, 255, 0], //   green    — finder
  [0, 0, 0], //     level 0  — calibration
  [85, 85, 85], //  level 1
  [170, 170, 170], // level 2
  [255, 255, 255], // level 3
  [0, 255, 255], // cyan     — finder
  [255, 255, 0], // yellow   — finder
];

export interface FrameHeader {
  cols: number;
  rows: number;
  seq: number;
  flags: number;
  msgId: number;
  chunkIdx: number;
  chunkCount: number;
}

export interface Frame extends FrameHeader {
  payload: Uint8Array;
}

export const FLAG_IDLE = 1;
export const FLAG_REPEAT = 2;

/** Bytes a strip of the given size can carry (header + payload + crc). */
export function frameCapacity(cols: number, rows: number): number {
  const symbols = cols * rows - FINDER_CELLS;
  return Math.floor((symbols * 6) / 8);
}

export function payloadCapacity(cols: number, rows: number): number {
  return frameCapacity(cols, rows) - HEADER_BYTES - CRC_BYTES;
}

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). */
export function crc16(bytes: Uint8Array, len = bytes.length): number {
  let crc = 0xffff;
  for (let i = 0; i < len; i++) crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 0xff];
  return crc;
}

/** Pack bytes into 6-bit symbols, 3 bytes → 4 symbols, zero-padded. */
export function bytesToSymbols(bytes: Uint8Array, symbolCount: number): Uint8Array {
  const out = new Uint8Array(symbolCount);
  let s = 0;
  for (let i = 0; i < bytes.length && s < symbolCount; i += 3) {
    const v = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out[s++] = (v >> 18) & 63;
    if (s < symbolCount) out[s++] = (v >> 12) & 63;
    if (s < symbolCount) out[s++] = (v >> 6) & 63;
    if (s < symbolCount) out[s++] = v & 63;
  }
  return out;
}

export function symbolsToBytes(symbols: ArrayLike<number>, byteCount: number): Uint8Array {
  const out = new Uint8Array(byteCount);
  let b = 0;
  for (let i = 0; i < symbols.length && b < byteCount; i += 4) {
    const v =
      ((symbols[i] ?? 0) << 18) | ((symbols[i + 1] ?? 0) << 12) | ((symbols[i + 2] ?? 0) << 6) | (symbols[i + 3] ?? 0);
    out[b++] = (v >> 16) & 255;
    if (b < byteCount) out[b++] = (v >> 8) & 255;
    if (b < byteCount) out[b++] = v & 255;
  }
  return out;
}

export function symbolToRgb(sym: number, palette: Palette = "vivid"): [number, number, number] {
  const L = PALETTES[palette];
  return [L[(sym >> 4) & 3], L[(sym >> 2) & 3], L[sym & 3]];
}

/** Colour of finder cell `i` (0..7) for a palette: detection cells stay vivid, the ramp follows it. */
export function finderRgb(i: number, palette: Palette = "vivid"): readonly [number, number, number] {
  if (i >= 2 && i <= 5) {
    const v = PALETTES[palette][i - 2];
    return [v, v, v];
  }
  return FINDER[i];
}

/** Serialize a frame to bytes (header + payload + crc). */
export function encodeFrameBytes(f: Frame): Uint8Array {
  const len = f.payload.length;
  const cap = frameCapacity(f.cols, f.rows);
  if (HEADER_BYTES + len + CRC_BYTES > cap) throw new Error(`payload ${len} exceeds capacity ${cap - HEADER_BYTES - CRC_BYTES}`);
  const out = new Uint8Array(HEADER_BYTES + len + CRC_BYTES);
  out[0] = MAGIC;
  out[1] = VERSION;
  out[2] = f.cols;
  out[3] = f.rows;
  out[4] = (f.seq >> 8) & 255;
  out[5] = f.seq & 255;
  out[6] = f.flags & 255;
  out[7] = (f.msgId >> 8) & 255;
  out[8] = f.msgId & 255;
  out[9] = f.chunkIdx & 255;
  out[10] = f.chunkCount & 255;
  out[11] = (len >> 8) & 255;
  out[12] = len & 255;
  out.set(f.payload, HEADER_BYTES);
  const crc = crc16(out, HEADER_BYTES + len);
  out[HEADER_BYTES + len] = (crc >> 8) & 255;
  out[HEADER_BYTES + len + 1] = crc & 255;
  return out;
}

/** Full cell grid (row-major) of symbols for a frame; finder cells are -1. */
export function encodeFrameCells(f: Frame): Int16Array {
  const total = f.cols * f.rows;
  const bytes = encodeFrameBytes(f);
  const syms = bytesToSymbols(bytes, total - FINDER_CELLS);
  const cells = new Int16Array(total);
  for (let i = 0; i < FINDER_CELLS; i++) cells[i] = -1 - i;
  cells.set(syms, FINDER_CELLS);
  return cells;
}

export type ParseResult = { ok: true; frame: Frame } | { ok: false; reason: string };

/** Parse the first bytes of a strip; `readMore` lets the caller supply the rest once cols/rows are known. */
export function parseFrameBytes(bytes: Uint8Array): ParseResult {
  if (bytes.length < HEADER_BYTES + CRC_BYTES) return { ok: false, reason: "short" };
  if (bytes[0] !== MAGIC) return { ok: false, reason: "magic" };
  if (bytes[1] !== VERSION) return { ok: false, reason: `version ${bytes[1]}` };
  const len = (bytes[11] << 8) | bytes[12];
  if (HEADER_BYTES + len + CRC_BYTES > bytes.length) return { ok: false, reason: "len" };
  const want = (bytes[HEADER_BYTES + len] << 8) | bytes[HEADER_BYTES + len + 1];
  if (crc16(bytes, HEADER_BYTES + len) !== want) return { ok: false, reason: "crc" };
  return {
    ok: true,
    frame: {
      cols: bytes[2],
      rows: bytes[3],
      seq: (bytes[4] << 8) | bytes[5],
      flags: bytes[6],
      msgId: (bytes[7] << 8) | bytes[8],
      chunkIdx: bytes[9],
      chunkCount: bytes[10],
      payload: bytes.slice(HEADER_BYTES, HEADER_BYTES + len),
    },
  };
}

/** Split a message into frames for a strip geometry. */
export function chunkMessage(
  payload: Uint8Array,
  msgId: number,
  cols: number,
  rows: number,
): Array<Omit<Frame, "seq" | "flags">> {
  const cap = payloadCapacity(cols, rows);
  const count = Math.max(1, Math.ceil(payload.length / cap));
  if (count > 255) throw new Error("message too large");
  const out: Array<Omit<Frame, "seq" | "flags">> = [];
  for (let i = 0; i < count; i++) {
    out.push({ cols, rows, msgId, chunkIdx: i, chunkCount: count, payload: payload.slice(i * cap, (i + 1) * cap) });
  }
  return out;
}

/**
 * Reassembles chunked messages and de-duplicates repeats. The dedup key is msgId + payload CRC,
 * so a msgId reused after a /reload (the addon reseeds it, but collisions are possible) with
 * different content is still delivered, while a FLAG_REPEAT resend is dropped.
 */
export class Reassembler {
  private partial = new Map<number, { count: number; parts: Map<number, Uint8Array>; at: number }>();
  private done = new Map<string, number>(); // dedup key -> time completed
  constructor(private onMessage: (msgId: number, payload: Uint8Array) => void, private ttlMs = 30_000) {}

  push(f: Frame, now = Date.now()): void {
    if (f.flags & FLAG_IDLE) return;
    let p = this.partial.get(f.msgId);
    if (!p || p.count !== f.chunkCount) {
      p = { count: f.chunkCount, parts: new Map(), at: now };
      this.partial.set(f.msgId, p);
    }
    p.parts.set(f.chunkIdx, f.payload);
    p.at = now;
    if (p.parts.size === p.count) {
      const total = [...p.parts.values()].reduce((n, b) => n + b.length, 0);
      const buf = new Uint8Array(total);
      let o = 0;
      for (let i = 0; i < p.count; i++) {
        const part = p.parts.get(i)!;
        buf.set(part, o);
        o += part.length;
      }
      this.partial.delete(f.msgId);
      const key = `${f.msgId}:${crc16(buf)}:${buf.length}`;
      const seen = this.done.get(key);
      this.done.set(key, now);
      if (seen === undefined || now - seen >= this.ttlMs) this.onMessage(f.msgId, buf);
    }
    this.gc(now);
  }

  private gc(now: number) {
    for (const [id, p] of this.partial) if (now - p.at > this.ttlMs) this.partial.delete(id);
    if (this.done.size > 512) for (const [id, t] of this.done) if (now - t > this.ttlMs) this.done.delete(id);
  }
}

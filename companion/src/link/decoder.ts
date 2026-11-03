// Locates and reads the Runestrip from captured RGBA pixels. Pure (no DOM / Electron) so it can be
// unit-tested against synthetic images rendered by the reference encoder and the Lua addon code.
import { FINDER_CELLS, Frame, frameCapacity, HEADER_BYTES, parseFrameBytes, symbolsToBytes } from "./codec";

/** Largest strip the addon draws, in cells: the capture reads (and the screen gate guards) this box. */
export const MAX_COLS = 128;
export const MAX_ROWS = 8;

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray; // RGBA, row-major
}

export interface StripLock {
  x: number; // strip origin (top-left of cell 0) in image px, fractional allowed
  y: number;
  pitch: number; // cell size in px, fractional allowed
}

export type DecodeResult =
  | { ok: true; frame: Frame; lock: StripLock }
  | { ok: false; reason: string; lock?: StripLock };

const px = (img: Rgba, x: number, y: number): [number, number, number] => {
  const xi = Math.min(img.width - 1, Math.max(0, Math.floor(x)));
  const yi = Math.min(img.height - 1, Math.max(0, Math.floor(y)));
  const o = (yi * img.width + xi) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};

const isMagenta = ([r, g, b]: number[]) => r > 190 && g < 70 && b > 190;
const isGreen = ([r, g, b]: number[]) => r < 70 && g > 190 && b < 70;
const isCyan = ([r, g, b]: number[]) => r < 70 && g > 190 && b > 190;
const isYellow = ([r, g, b]: number[]) => r > 190 && g > 190 && b < 70;
const isBlack = ([r, g, b]: number[]) => r < 50 && g < 50 && b < 50;

/** Verify that a candidate lock lands on the finder pattern. */
export function verifyLock(img: Rgba, lock: StripLock): boolean {
  const c = (i: number) => px(img, lock.x + (i + 0.5) * lock.pitch, lock.y + 0.5 * lock.pitch);
  if (!(isMagenta(c(0)) && isGreen(c(1)) && isCyan(c(6)) && isYellow(c(7)) && isBlack(c(2)))) return false;
  // The grey ramp (cells 2..5) must rise on every channel; works for vivid and dim palettes.
  const r = [c(2), c(3), c(4), c(5)];
  for (let ch = 0; ch < 3; ch++) {
    if (!(r[0][ch] < r[1][ch] && r[1][ch] < r[2][ch] && r[2][ch] < r[3][ch])) return false;
    if (r[3][ch] - r[0][ch] < 40) return false;
  }
  return true;
}

const magentaish = (d: Uint8Array | Uint8ClampedArray, o: number) => d[o] > 150 && d[o + 1] < 100 && d[o + 2] > 150;

/**
 * Find the strip. Captures arrive as I420 video, so cell edges blur over ~2px (chroma is
 * subsampled 2x2) and pure colour survives only near cell centres. For each magenta candidate
 * (the left edge of a run) we sweep cell pitches and sub-pixel origins and check the whole
 * 8-cell finder at cell centres; `acquire` then confirms with the frame CRC.
 * `region` restricts the search (image px). Returns a rough lock or null.
 */
export function findStrip(img: Rgba, region?: { x: number; y: number; w: number; h: number }): StripLock | null {
  const x0 = Math.max(0, region?.x ?? 0);
  const y0 = Math.max(0, region?.y ?? 0);
  const x1 = Math.min(img.width, x0 + (region?.w ?? img.width));
  const y1 = Math.min(img.height, y0 + (region?.h ?? img.height));
  const d = img.data;
  const W = img.width;
  let candidates = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * W * 4;
    for (let x = x0; x < x1; x++) {
      const o = row + x * 4;
      if (!magentaish(d, o)) continue;
      // Left/top edge of a magenta block only.
      if (x > 0 && magentaish(d, o - 4)) continue;
      if (y > 0 && magentaish(d, o - W * 4)) continue;
      if (++candidates > 400) return null;
      const lock = sweep(img, x, y);
      if (lock) return lock;
    }
  }
  return null;
}

// Integer pitches first (the addon renders pixel-perfect cells), then fractional ones.
const PITCHES = (() => {
  const out: number[] = [];
  for (let p = 3; p <= 16; p++) out.push(p);
  for (let p = 2.5; p <= 16; p += 0.125) if (!Number.isInteger(p)) out.push(p);
  return out;
})();

function sweep(img: Rgba, x: number, y: number): StripLock | null {
  // The candidate pixel may be a blended edge, so the true origin lies within ~1.5px of it.
  for (const pitch of PITCHES) {
    for (const dx of [-1, -0.5, 0, 0.5, 1]) {
      for (const dy of [-1, 0, 1]) {
        const lock = { x: x + dx, y: y + dy, pitch };
        if (verifyLock(img, lock)) return lock;
      }
    }
  }
  return null;
}

/** Per-channel calibration levels sampled from finder cells 2..5 (gray ramp). */
export function calibrate(img: Rgba, lock: StripLock): number[][] {
  const levels: number[][] = [[], [], []];
  for (let i = 2; i <= 5; i++) {
    const c = px(img, lock.x + (i + 0.5) * lock.pitch, lock.y + 0.5 * lock.pitch);
    for (let ch = 0; ch < 3; ch++) levels[ch].push(c[ch]);
  }
  return levels;
}

function nearest(levels: number[], v: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < 4; i++) {
    const dd = Math.abs(levels[i] - v);
    if (dd < bd) {
      bd = dd;
      best = i;
    }
  }
  return best;
}

function readSymbols(img: Rgba, lock: StripLock, cols: number, rows: number, levels: number[][], count: number) {
  const out = new Uint8Array(count);
  for (let s = 0; s < count; s++) {
    const cell = s + FINDER_CELLS;
    const c = cell % cols;
    const r = Math.floor(cell / cols);
    if (r >= rows) break;
    const [R, G, B] = px(img, lock.x + (c + 0.5) * lock.pitch, lock.y + (r + 0.5) * lock.pitch);
    out[s] = (nearest(levels[0], R) << 4) | (nearest(levels[1], G) << 2) | nearest(levels[2], B);
  }
  return out;
}

/** Decode one frame at a known lock. */
export function decodeAt(img: Rgba, lock: StripLock): DecodeResult {
  if (!verifyLock(img, lock)) return { ok: false, reason: "nofinder" };
  const levels = calibrate(img, lock);
  // First pass: header symbols live in row 0 right after the finder (cols >= 8 + 4 guaranteed by the addon).
  const head = symbolsToBytes(readSymbols(img, lock, 4096, 1, levels, 4), 3); // MAGIC, VERSION, cols
  if (head[0] !== 0x46) return { ok: false, reason: "magic", lock };
  const cols = head[2];
  if (cols < 16) return { ok: false, reason: "cols", lock };
  const head2 = symbolsToBytes(readSymbols(img, lock, cols, 1, levels, 8), 6);
  const rows = head2[3];
  if (rows < 1 || rows > 16) return { ok: false, reason: "rows", lock };
  const cap = frameCapacity(cols, rows);
  if (cap < HEADER_BYTES + 2) return { ok: false, reason: "cap", lock };
  const syms = readSymbols(img, lock, cols, rows, levels, cols * rows - FINDER_CELLS);
  const bytes = symbolsToBytes(syms, cap);
  const parsed = parseFrameBytes(bytes);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, lock };
  return { ok: true, frame: parsed.frame, lock };
}

/**
 * CRC-guided refinement. The finder only spans 8 cells, so a ±1px edge error becomes a large
 * pitch error across a 64-cell row. Every frame carries a CRC, so we try nearby pitches/origins
 * (integer pitch first — the addon renders pixel-perfect cells, so that is the common case) and
 * keep the first geometry that yields a valid frame.
 */
export function acquire(img: Rgba, rough: StripLock): DecodeResult {
  const pitches: number[] = [];
  const ri = Math.round(rough.pitch);
  if (Math.abs(ri - rough.pitch) < 0.35) pitches.push(ri);
  for (let k = 0; k <= 25; k++) {
    for (const s of k === 0 ? [0] : [-1, 1]) pitches.push(rough.pitch + s * k * 0.02);
  }
  const offs = [0, -0.5, -1, 0.5];
  let last: DecodeResult = { ok: false, reason: "acquire" };
  for (const p of pitches) {
    for (const dx of offs) {
      for (const dy of offs) {
        const lock = { x: rough.x + dx, y: rough.y + dy, pitch: p };
        const r = decodeAt(img, lock);
        if (r.ok) return r;
        last = r;
        if (r.reason === "nofinder") continue;
      }
    }
  }
  return last;
}

/** Stateful decoder: keeps the lock between frames, re-acquires when lost or after CRC failures. */
export class StripDecoder {
  lock: StripLock | null = null;
  private lastSearch = 0;
  private crcStreak = 0;
  stats = { frames: 0, ok: 0, crc: 0, lost: 0, searches: 0 };

  constructor(private searchEveryMs = 500) {}

  decode(img: Rgba, now = Date.now(), hint?: { x: number; y: number; w: number; h: number }): DecodeResult {
    this.stats.frames++;
    if (this.lock) {
      const r = decodeAt(img, this.lock);
      if (r.ok) {
        this.stats.ok++;
        this.crcStreak = 0;
        return r;
      }
      if (r.reason !== "nofinder") {
        this.stats.crc++;
        if (++this.crcStreak < 3) return r;
        // Geometry drifted (e.g. strip grew from idle to full width): refine around the lock.
        this.crcStreak = 0;
        const rr = acquire(img, this.lock);
        if (rr.ok) {
          this.lock = rr.lock;
          this.stats.ok++;
        }
        return rr;
      }
      this.lock = null;
      this.stats.lost++;
    }
    if (now - this.lastSearch < this.searchEveryMs) return { ok: false, reason: "searching" };
    this.lastSearch = now;
    this.stats.searches++;
    const found = (hint && findStrip(img, hint)) || findStrip(img);
    if (!found) return { ok: false, reason: "notfound" };
    const r = acquire(img, found);
    if (r.ok) {
      this.lock = r.lock;
      this.stats.ok++;
    } else {
      this.lock = found;
    }
    return r;
  }
}

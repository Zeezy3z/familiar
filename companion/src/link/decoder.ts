// Locates and reads the Runestrip from captured RGBA pixels. Pure (no DOM / Electron) so it can be
// unit-tested against synthetic images rendered by the reference encoder and the Lua addon code.
import { FINDER_CELLS, Frame, frameCapacity, HEADER_BYTES, parseFrameBytes, symbolsToBytes } from "./codec";

/** Largest strip the addon draws, in cells: the capture reads (and the screen gate guards) this box. */
export const MAX_COLS = 128;
export const MAX_ROWS = 8;
/** Slack around a lock when only the strip's box is read from a frame (image px). */
const LOCK_MARGIN = 6;

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray; // RGBA, row-major
}

/** An image read from part of a frame: (ox, oy) is its top-left in frame px (0 when omitted). */
export interface View extends Rgba {
  ox?: number;
  oy?: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StripLock {
  x: number; // strip origin (top-left of cell 0) in image px, fractional allowed
  y: number;
  pitch: number; // cell size in px, fractional allowed
  /** Pixels within this distance of a cell's edge are not averaged (default EDGE). */
  edge?: number;
}

/** Cell averaging keeps clear of the edges by EDGE px: I420 video blurs colour over ~2 px there.
 * A clean (pixel-exact, unsubsampled) image is read better over nearly the whole cell, FULL_EDGE;
 * `acquire` tries both and the frame CRC decides. */
const EDGE = 1.25;
const FULL_EDGE = 0.5;

/** Failure reasons: "nofinder" (no finder at the lock), "ramp" (the finder is there but its grey
 * ramp has collapsed or clipped: two steps read the same, so symbols cannot be told apart),
 * "notfound" (a search found no strip), "searching" (between searches), and the frame parser's
 * ("magic", "crc", ...). `levels` carries the measured ramp (per channel) with "ramp". */
export type DecodeResult =
  | { ok: true; frame: Frame; lock: StripLock }
  | { ok: false; reason: string; lock?: StripLock; levels?: number[][] };

type Rgb = [number, number, number];

const px = (img: Rgba, x: number, y: number): Rgb => {
  const xi = Math.min(img.width - 1, Math.max(0, Math.floor(x)));
  const yi = Math.min(img.height - 1, Math.max(0, Math.floor(y)));
  const o = (yi * img.width + xi) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};

/** Mean colour of a cell: the pixels whose centres lie at least `lock.edge` px inside it, or the
 * centre pixel when the cell is too small for that. Averaging keeps capture noise from flipping
 * the closely spaced low levels. */
function cell(img: Rgba, lock: StripLock, col: number, row: number): Rgb {
  const cx = lock.x + (col + 0.5) * lock.pitch;
  const cy = lock.y + (row + 0.5) * lock.pitch;
  const a = lock.pitch / 2 - (lock.edge ?? EDGE);
  if (a < 0.5) return px(img, cx, cy);
  const x0 = Math.max(0, Math.ceil(cx - a - 0.5)), x1 = Math.min(img.width - 1, Math.floor(cx + a - 0.5));
  const y0 = Math.max(0, Math.ceil(cy - a - 0.5)), y1 = Math.min(img.height - 1, Math.floor(cy + a - 0.5));
  if (x1 < x0 || y1 < y0) return px(img, cx, cy);
  const d = img.data;
  let r = 0, g = 0, b = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const o = (y * img.width + x) * 4;
      r += d[o];
      g += d[o + 1];
      b += d[o + 2];
    }
  const n = (x1 - x0 + 1) * (y1 - y0 + 1);
  return [r / n, g / n, b / n];
}

// The finder judges colours against references measured in the finder itself, not fixed
// thresholds: magenta, green, cyan and yellow each light two channels fully and leave the third
// dark, so every channel has a measured "on" and "off" level whatever the client's gain, lift,
// gamma or tint. Cells 0, 1, 6, 7; which channels each lights (R, G, B).
const FINDER_AT = [0, 1, 6, 7];
const LIT = [
  [1, 0, 1],
  [0, 1, 0],
  [0, 1, 1],
  [1, 1, 0],
];
/** Least on-off difference per channel: below it the colours are too faint to be the strip. */
const MIN_SPAN = 60;
/** Each ramp step must rise at least this much on every channel (px value), else "ramp". */
const MIN_STEP = 3;
/** Ramp cells must be grey: their normalized level may differ this much between channels. */
const GREY_TOLERANCE = 0.25;

type FinderCheck = { at: "ok" | "ramp"; levels: number[][] } | { at: "none" };

/** Is the finder at this lock? "ok": colours and grey ramp verify; "ramp": the finder is there but
 * two ramp steps read the same (clipped or collapsed); "none": not the strip. `levels` are the
 * measured ramp levels per channel (calibration). */
function checkFinder(img: Rgba, lock: StripLock): FinderCheck {
  // Cheap rejects on cell-centre pixels first: the sweep tries thousands of geometries.
  if (!hue(img, lock, 1, 1, 0, 1, 2) || !hue(img, lock, 6, 1, 0, 2, 0) || !hue(img, lock, 7, 0, 2, 1, 2)) return { at: "none" };
  const centre = (i: number) => px(img, lock.x + (i + 0.5) * lock.pitch, lock.y + 0.5 * lock.pitch);
  if (!finderColours(FINDER_AT.map(centre), centre(2))) return { at: "none" };
  const f = FINDER_AT.map((i) => cell(img, lock, i, 0));
  const ramp = [2, 3, 4, 5].map((i) => cell(img, lock, i, 0));
  const ref = finderColours(f, ramp[0]);
  if (!ref) return { at: "none" };
  const levels: number[][] = [0, 1, 2].map((ch) => ramp.map((c) => c[ch]));
  // The ramp cells are grey: same normalized level on every channel.
  for (let i = 1; i < 4; i++) {
    const t = [0, 1, 2].map((ch) => (levels[ch][i] - ref.off[ch]) / ref.span[ch]);
    if (Math.max(...t) - Math.min(...t) > GREY_TOLERANCE) return { at: "none" };
  }
  for (const l of levels) for (let i = 1; i < 4; i++) if (l[i] - l[i - 1] < MIN_STEP) return { at: "ramp", levels };
  return { at: "ok", levels };
}

/** Necessary for finder cell `i`: at its centre, channel `hi` clearly above `lo` and `hi2` above
 * `lo2` (green: G over R and B; cyan: G and B over R; yellow: R and G over B). */
function hue(img: Rgba, lock: StripLock, i: number, hi: number, lo: number, hi2: number, lo2: number): boolean {
  const xi = Math.min(img.width - 1, Math.max(0, Math.floor(lock.x + (i + 0.5) * lock.pitch)));
  const yi = Math.min(img.height - 1, Math.max(0, Math.floor(lock.y + 0.5 * lock.pitch)));
  const o = (yi * img.width + xi) * 4, d = img.data;
  return d[o + hi] - d[o + lo] > 20 && d[o + hi2] - d[o + lo2] > 20;
}

/** The four finder colours and the black ramp cell against their own per-channel references. */
function finderColours(f: Rgb[], black: Rgb): { off: number[]; span: number[] } | null {
  const off: number[] = [], span: number[] = [];
  for (let ch = 0; ch < 3; ch++) {
    let on = 0, n = 0, lo = 0, m = 0;
    for (let k = 0; k < 4; k++)
      if (LIT[k][ch]) (on += f[k][ch]), n++;
      else (lo += f[k][ch]), m++;
    on /= n;
    lo /= m;
    const s = on - lo;
    if (s < MIN_SPAN) return null;
    for (let k = 0; k < 4; k++) {
      const t = (f[k][ch] - lo) / s;
      if (LIT[k][ch] ? t < 0.7 : t > 0.3) return null;
    }
    if ((black[ch] - lo) / s > 0.3) return null;
    off.push(lo);
    span.push(s);
  }
  return { off, span };
}

/** Candidate pixels: clearly more red and blue than green (magenta at any gain, lift or tint). */
const magentaish = (d: Uint8Array | Uint8ClampedArray, o: number) => d[o] - d[o + 1] > 50 && d[o + 2] - d[o + 1] > 30;
const greenish = (d: Uint8Array | Uint8ClampedArray, o: number) => d[o + 1] - d[o] > 40 && d[o + 1] - d[o + 2] > 30;

// Integer pitches first (the addon renders pixel-perfect cells), then fractional ones.
const PITCHES = (() => {
  const out: number[] = [];
  for (let p = 3; p <= 16; p++) out.push(p);
  for (let p = 2.5; p <= 16; p += 0.125) if (!Number.isInteger(p)) out.push(p);
  return out;
})();
/** A magenta run wider than this cannot be finder cell 0 (largest pitch plus blur). */
const MAX_RUN = 19;

/** Shared state of one search: the time budget and the candidates already tried (image px), so
 * overlapping regions do not repeat them. */
interface Search {
  deadline: number;
  tried: Set<number>;
  /** The budget ran out at this row (image px); -1 while it lasts. */
  stopRow: number;
}

const newSearch = (budgetMs = Infinity): Search => ({ deadline: performance.now() + budgetMs, tried: new Set(), stopRow: -1 });

/**
 * Rough locks of verified finders in `region` (image px), scanning rows from `startRow` (wrapping).
 * Captures arrive as I420 video, so cell edges blur over ~2px (chroma is subsampled 2x2) and pure
 * colour survives only near cell centres. For each magenta candidate (the top-left of a run) we
 * sweep cell pitches near the run's width and sub-pixel origins and check the whole 8-cell finder;
 * `acquire` then confirms with the frame CRC. Stops when the search's time budget is spent.
 */
function* finders(img: Rgba, region: Box | undefined, s: Search, startRow = 0): Generator<StripLock> {
  const x0 = Math.max(0, Math.floor(region?.x ?? 0));
  const y0 = Math.max(0, Math.floor(region?.y ?? 0));
  const x1 = Math.min(img.width, Math.ceil((region?.x ?? 0) + (region?.w ?? img.width)));
  const y1 = Math.min(img.height, Math.ceil((region?.y ?? 0) + (region?.h ?? img.height)));
  const d = img.data;
  const W = img.width;
  const rows = y1 - y0;
  const start = startRow > y0 && startRow < y1 ? startRow - y0 : 0;
  for (let i = 0; i < rows; i++) {
    const y = y0 + ((start + i) % rows);
    // Every scan covers at least a row, so a resumed scan always moves on.
    if (i > 0 && performance.now() > s.deadline) {
      s.stopRow = y;
      return;
    }
    const row = y * W * 4;
    for (let x = x0; x < x1; x++) {
      const o = row + x * 4;
      if (!magentaish(d, o)) continue;
      // Top-left of a magenta block only.
      if (x > 0 && magentaish(d, o - 4)) continue;
      if (y > 0 && magentaish(d, o - W * 4)) continue;
      const key = y * W + x;
      if (s.tried.has(key)) continue;
      s.tried.add(key);
      let run = 1;
      while (run <= MAX_RUN && x + run < W && magentaish(d, o + run * 4)) run++;
      if (run > MAX_RUN) continue;
      // Finder cell 1 (green) follows within a blurred pixel or two.
      let green = false;
      for (let k = run; k < run + 3 && x + k < W && !green; k++) green = greenish(d, o + k * 4);
      if (!green) continue;
      const lock = sweep(img, x, y, run);
      if (lock) yield lock;
      if (performance.now() > s.deadline) {
        s.stopRow = y0 + ((start + i + 1) % rows);
        return;
      }
    }
  }
}

/** First finder in `region` (no time limit), or null. Its grey ramp may still be collapsed:
 * `acquire` tells. */
export function findStrip(img: Rgba, region?: Box): StripLock | null {
  for (const lock of finders(img, region, newSearch())) return lock;
  return null;
}

function sweep(img: Rgba, x: number, y: number, run: number): StripLock | null {
  // The candidate pixel may be a blended edge, so the true origin lies within ~2px of it, and
  // cell 0 is about as wide as the magenta run (blur shortens or lengthens it by a pixel or two).
  let ramp: StripLock | null = null;
  for (const pitch of PITCHES) {
    if (pitch < run - 1.5 || pitch > run + 2.5) continue;
    for (const dx of [0, 0.5, 1, -0.5, -1, 1.5, 2]) {
      for (const dy of [0, 1, -1, 2]) {
        const lock = { x: x + dx, y: y + dy, pitch };
        const c = checkFinder(img, lock);
        if (c.at === "ok") return lock;
        if (c.at === "ramp") ramp ??= lock;
      }
    }
  }
  return ramp;
}

/** Decode one frame at a known lock. Symbols are read against the ramp measured in this frame
 * (finder cells 2..5), so monotonic gain, lift and gamma curves are absorbed. */
function decodeAt(img: Rgba, lock: StripLock): DecodeResult {
  const c = checkFinder(img, lock);
  if (c.at === "none") return { ok: false, reason: "nofinder" };
  if (c.at === "ramp") return { ok: false, reason: "ramp", lock, levels: c.levels };
  const levels = c.levels;
  // Header first: header symbols live in row 0 right after the finder (cols >= 8 + 4 guaranteed by the addon).
  const mid = midpoints(levels);
  const head = symbolsToBytes(classify(readCells(img, lock, 4096, 1, 4), mid), 3); // MAGIC, VERSION, cols
  if (head[0] !== 0x46) return { ok: false, reason: "magic", lock };
  const cols = head[2];
  if (cols < 16) return { ok: false, reason: "cols", lock };
  const head2 = symbolsToBytes(classify(readCells(img, lock, cols, 1, 8), mid), 6);
  const rows = head2[3];
  if (rows < 1 || rows > 16) return { ok: false, reason: "rows", lock };
  const cap = frameCapacity(cols, rows);
  if (cap < HEADER_BYTES + 2) return { ok: false, reason: "cap", lock };
  const raw = readCells(img, lock, cols, rows, cols * rows - FINDER_CELLS);
  const syms = classify(raw, midpoints(levels));
  let parsed = parseFrameBytes(symbolsToBytes(syms, cap));
  // One second reading with thresholds placed from this frame's own cells (never bit flipping:
  // the CRC stays the only judge, and it is asked once more at most).
  if (!parsed.ok) parsed = parseFrameBytes(symbolsToBytes(classify(raw, refine(raw, syms, levels)), cap));
  if (!parsed.ok) return { ok: false, reason: parsed.reason, lock };
  return { ok: true, frame: parsed.frame, lock };
}

/** Mean colours of `count` symbol cells (those after the finder), three values each. */
function readCells(img: Rgba, lock: StripLock, cols: number, rows: number, count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let s = 0; s < count; s++) {
    const i = s + FINDER_CELLS;
    const r = Math.floor(i / cols);
    if (r >= rows) break;
    out.set(cell(img, lock, i % cols, r), s * 3);
  }
  return out;
}

/** Per channel, the three values separating adjacent levels: midpoints of the measured ramp. */
const midpoints = (levels: number[][]) => levels.map((l) => [(l[0] + l[1]) / 2, (l[1] + l[2]) / 2, (l[2] + l[3]) / 2]);

function classify(raw: Float32Array, t: number[][]): Uint8Array {
  const out = new Uint8Array(raw.length / 3);
  for (let s = 0; s < out.length; s++) {
    let sym = 0;
    for (let ch = 0; ch < 3; ch++) {
      const v = raw[s * 3 + ch], th = t[ch];
      sym = (sym << 2) | (+(v > th[0]) + +(v > th[1]) + +(v > th[2]));
    }
    out[s] = sym;
  }
  return out;
}

/** Thresholds placed from the cells read as each level: between neighbouring means, nearer the
 * quieter level (weighted by spread), so a noisy level does not cost its neighbour. Levels with
 * too few cells keep the ramp's value. */
function refine(raw: Float32Array, syms: Uint8Array, levels: number[][]): number[][] {
  return [0, 1, 2].map((ch) => {
    const shift = (2 - ch) * 2;
    const sum = [0, 0, 0, 0], sq = [0, 0, 0, 0], n = [0, 0, 0, 0];
    for (let s = 0; s < syms.length; s++) {
      const L = (syms[s] >> shift) & 3, v = raw[s * 3 + ch];
      sum[L] += v;
      sq[L] += v * v;
      n[L]++;
    }
    const m = n.map((k, L) => (k >= 4 ? sum[L] / k : levels[ch][L]));
    const sd = n.map((k, L) => (k >= 4 ? Math.max(0.5, Math.sqrt(Math.max(0, sq[L] / k - m[L] * m[L]))) : 1));
    if (!(m[0] < m[1] && m[1] < m[2] && m[2] < m[3])) return midpoints([levels[ch]])[0];
    return [0, 1, 2].map((L) => (m[L] * sd[L + 1] + m[L + 1] * sd[L]) / (sd[L] + sd[L + 1]));
  });
}

/**
 * CRC-guided refinement. The finder only spans 8 cells, so a ±1px edge error becomes a large
 * pitch error across a 64-cell row. Every frame carries a CRC, so we try nearby pitches/origins
 * (integer pitch first — the addon renders pixel-perfect cells, so that is the common case) and
 * keep the first geometry that yields a valid frame, reading each cell over its inner part and,
 * failing that, nearly all of it. A failure reports the most telling reason met on the way:
 * a frame error ("crc", "magic", ...) over "ramp" over "nofinder".
 */
export function acquire(img: Rgba, rough: StripLock): DecodeResult {
  const pitches: number[] = [];
  const ri = Math.round(rough.pitch);
  if (Math.abs(ri - rough.pitch) < 0.35) pitches.push(ri);
  for (let k = 0; k <= 25; k++) {
    for (const s of k === 0 ? [0] : [-1, 1]) pitches.push(rough.pitch + s * k * 0.02);
  }
  const offs = [0, -0.5, 0.5, -1, 1];
  const rank = (r: DecodeResult) => (r.ok ? 3 : r.reason === "nofinder" ? 0 : r.reason === "ramp" ? 1 : 2);
  let best: DecodeResult = { ok: false, reason: "nofinder" };
  for (const p of pitches) {
    for (const dx of offs) {
      for (const dy of offs) {
        for (const edge of [EDGE, FULL_EDGE]) {
          const r = decodeAt(img, { x: rough.x + dx, y: rough.y + dy, pitch: p, edge });
          if (r.ok) return r;
          if (rank(r) > rank(best)) best = r;
          if (r.reason === "nofinder") break;
        }
      }
    }
  }
  return best;
}

const intersect = (a: Box, b: Box): Box | null => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
};

/** The box (frame px) to read around a lock: the largest strip the addon draws, plus a margin. */
export function lockBox(lock: StripLock): Box {
  return {
    x: lock.x - LOCK_MARGIN,
    y: lock.y - LOCK_MARGIN,
    w: MAX_COLS * lock.pitch + 2 * LOCK_MARGIN,
    h: MAX_ROWS * lock.pitch + 2 * LOCK_MARGIN,
  };
}

export interface DecoderOptions {
  /** Least time between searches while unlocked (ms). */
  searchEveryMs?: number;
  /** While unlocked, read the whole frame this often; in between only the hint regions. */
  fullEveryMs?: number;
  /** Time one search may spend scanning and checking candidates (ms). */
  budgetMs?: number;
  /** Where the strip usually sits (frame px), searched before anything else: the client corners. */
  hints?: Box[];
}

/**
 * Stateful decoder: keeps the lock between frames, re-acquires after CRC failures, searches when
 * lost. Production (capture.ts) asks `plan` which parts of the next frame to read, then hands the
 * views read to `decode`; tests pass a whole image to `decode`. The lock is in frame px.
 */
export class StripDecoder {
  lock: StripLock | null = null;
  hints: Box[];
  stats = { frames: 0, ok: 0, crc: 0, lost: 0, searches: 0 };
  private lastSearch = -Infinity;
  private lastFull = -Infinity;
  private crcStreak = 0;
  private resumeRow = 0;
  private searchEveryMs: number;
  private fullEveryMs: number;
  private budgetMs: number;

  constructor(opts: DecoderOptions | number = {}) {
    const o = typeof opts === "number" ? { searchEveryMs: opts } : opts;
    this.searchEveryMs = o.searchEveryMs ?? 250;
    this.fullEveryMs = o.fullEveryMs ?? 2000;
    this.budgetMs = o.budgetMs ?? 40;
    this.hints = o.hints ?? [];
  }

  /** The boxes (frame px) to read from the next frame: around the lock; while unlocked the hint
   * regions every `searchEveryMs` and the whole frame every `fullEveryMs`; none in between. */
  plan(now: number, width: number, height: number): Box[] {
    const frame = { x: 0, y: 0, w: width, h: height };
    if (this.lock) return [intersect(lockBox(this.lock), frame)].filter((b): b is Box => !!b);
    if (now - this.lastSearch < this.searchEveryMs) return [];
    const hints = this.hints.map((h) => intersect(h, frame)).filter((b): b is Box => !!b);
    if (!hints.length || now - this.lastFull >= this.fullEveryMs) {
      this.lastFull = now;
      return [frame];
    }
    return hints;
  }

  decode(views: View | View[], now = Date.now()): DecodeResult {
    const list = Array.isArray(views) ? views : [views];
    this.stats.frames++;
    if (this.lock && list.length) {
      const v = list[0];
      const ox = v.ox ?? 0, oy = v.oy ?? 0;
      const local = { ...this.lock, x: this.lock.x - ox, y: this.lock.y - oy };
      let r = decodeAt(v, local);
      // A collapsed ramp keeps the lock (it reads again once HDR or the filter is off); any other
      // miss counts toward re-acquiring.
      if (!r.ok && r.reason !== "nofinder" && r.reason !== "ramp") {
        if (r.reason === "crc") this.stats.crc++;
        // Geometry drifted (e.g. strip grew from idle to full width): refine around the lock.
        if (++this.crcStreak >= 3) {
          this.crcStreak = 0;
          r = acquire(v, local);
        }
      }
      if (r.ok) {
        this.crcStreak = 0;
        this.stats.ok++;
        this.lock = { ...r.lock, x: r.lock.x + ox, y: r.lock.y + oy };
        return { ...r, lock: this.lock };
      }
      if (r.reason !== "nofinder") return { ...r, lock: this.lock };
      this.lock = null;
      this.crcStreak = 0;
      this.stats.lost++;
    }
    if (now - this.lastSearch < this.searchEveryMs) return { ok: false, reason: "searching" };
    this.lastSearch = now;
    return this.search(list);
  }

  /** Hint regions first, then each whole view, within one time budget. Only a CRC-verified frame
   * locks: a finder look-alike in the scenery never does. */
  private search(views: View[]): DecodeResult {
    this.stats.searches++;
    const s = newSearch(this.budgetMs);
    let miss: DecodeResult & { ok: false } = { ok: false, reason: "notfound" };
    // Each search starts at the next hint, so a busy corner cannot use up every budget.
    const k = (this.stats.searches - 1) % Math.max(1, this.hints.length);
    const hints = [...this.hints.slice(k), ...this.hints.slice(0, k)];
    for (const v of views) {
      const ox = v.ox ?? 0, oy = v.oy ?? 0;
      const whole = { x: ox, y: oy, w: v.width, h: v.height };
      const regions = hints.map((h) => intersect(h, whole)).filter((b): b is Box => !!b);
      const covered = regions.some((h) => h.x <= whole.x && h.y <= whole.y && h.x + h.w >= whole.x + whole.w && h.y + h.h >= whole.y + whole.h);
      if (!covered) regions.push(whole);
      for (const g of regions) {
        // A whole-view scan starts where the last one ran out of time, so the budget never
        // leaves the same part of the frame unsearched.
        const own = g === whole;
        for (const rough of finders(v, { x: g.x - ox, y: g.y - oy, w: g.w, h: g.h }, s, own ? this.resumeRow - oy : 0)) {
          const r = acquire(v, rough);
          if (r.ok) {
            this.lock = { ...r.lock, x: r.lock.x + ox, y: r.lock.y + oy };
            this.stats.ok++;
            if (own) this.resumeRow = 0;
            return { ...r, lock: this.lock };
          }
          // Report a collapsed ramp over any other miss: it is the one the player can fix.
          if (miss.reason === "notfound" || r.reason === "ramp") miss = { ok: false, reason: r.reason, levels: r.levels };
        }
        if (own) this.resumeRow = s.stopRow >= 0 ? s.stopRow + oy : 0;
        if (s.stopRow >= 0) return miss;
      }
    }
    return miss;
  }
}

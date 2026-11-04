// The tray says what is happening without opening anything: a badge on the familiar's face and a
// tooltip with counts. Pure (no Electron): main.ts hands in activity() and the bitmaps.

export type TrayBadge = "none" | "working" | "waiting";

/** The cut-request tooltip keeps its own words (surfaceRequests raises the matching notice). */
export const CUT_WAITING_TOOLTIP = "Familiar: a request is waiting on your PC";

/** Counts only, never a project or quest name, so Hide names / Stream-safe leave it as it is. */
export function trayBadgeFor(work: { working: number; approvals: number } | null, cutWaiting: boolean): { badge: TrayBadge; tooltip: string } {
  const working = work?.working ?? 0, approvals = work?.approvals ?? 0;
  const badge: TrayBadge = approvals > 0 || cutWaiting ? "waiting" : working > 0 ? "working" : "none";
  if (cutWaiting) return { badge, tooltip: CUT_WAITING_TOOLTIP };
  const parts = ["Familiar", working > 0 && `${working} working`, approvals > 0 && `${approvals} waiting on you`].filter(Boolean);
  return { badge, tooltip: parts.join(" · ") };
}

// Design tokens (docs/design.md §3): ok, warn, and the panel background as the dark outline.
const OK: Rgb = [0x7d, 0xd9, 0x6b];
const WARN: Rgb = [0xff, 0x80, 0x40];
const DARK: Rgb = [0x0b, 0x0a, 0x0d];
type Rgb = [number, number, number];

/** Paints the badge into the bottom-right of a square BGRA bitmap (Electron's toBitmap layout,
 * premultiplied alpha), in place. Geometry is in 16 px units and scales with `size` (32 px → ×2):
 * working = a 5 px ok disc with a 1 px dark ring; waiting = a 7 px warn disc with a 1 px dark ring
 * and a dark "!" (a 1 × 3 px bar over a 1 px dot, rows 9–13 at 16 px; a plain 1 × 4 bar read as "I").
 * Edges are antialiased (4 × 4 samples per pixel);
 * premultiplied, so the art's own colour simply scales by the share of the pixel it keeps. */
export function paintBadge(bgra: Buffer, size: number, badge: TrayBadge) {
  if (badge === "none") return bgra;
  const k = size / 16;
  const fill = badge === "working" ? 2.5 : 3.5; // disc radius
  const outer = fill + 1;
  const c = 16 - outer; // centre, flush with the bottom-right corner
  const fillRgb = badge === "working" ? OK : WARN;
  // The "!": 1 px wide on the disc's centre column, bar rows 9–11 and dot row 13 of the 16 px icon.
  const bang = (x: number, y: number) => badge === "waiting" && x >= c - 0.5 && x < c + 0.5 && ((y >= 9 && y < 12) || (y >= 13 && y < 14));
  const N = 4;
  const from = Math.max(0, Math.floor((c - outer) * k));
  for (let py = from; py < size; py++)
    for (let px = from; px < size; px++) {
      let ring = 0, disc = 0, mark = 0;
      for (let sy = 0; sy < N; sy++)
        for (let sx = 0; sx < N; sx++) {
          const x = (px + (sx + 0.5) / N) / k, y = (py + (sy + 0.5) / N) / k; // in 16 px units
          const d = Math.hypot(x - c, y - c);
          if (d > outer) continue;
          ring++;
          if (d > fill) continue;
          disc++;
          if (bang(x, y)) mark++;
        }
      // Area fractions of this pixel: the badge's fill colour, its dark ring and "!", and the art left showing.
      const o = (py * size + px) * 4, n = N * N;
      const lit = (disc - mark) / n, dark = (ring - disc + mark) / n, art = 1 - ring / n;
      if (art === 1) continue;
      for (let i = 0; i < 3; i++) bgra[o + i] = Math.round(fillRgb[2 - i] * lit + DARK[2 - i] * dark + bgra[o + i] * art);
      bgra[o + 3] = Math.round(255 * (lit + dark) + bgra[o + 3] * art);
    }
  return bgra;
}

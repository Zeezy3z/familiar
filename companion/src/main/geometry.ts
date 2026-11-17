// Window and overlay geometry (pure, testable).
//
// Display maths: Electron and Win32 give the game's client and frame in physical screen px, the
// displays' bounds in DIP; the capture works in frame px. Drags: the addon reports one "dragstart"
// (the frame's rect, the cursor, the resize limits — all in physical px of the game's client area);
// from then on the companion reads the OS cursor and moves/resizes the overlay itself, so the Glass
// keeps up with the mouse instead of waiting for updates through the Runestrip. The exact layout
// arrives when the drag ends.

export type Rect = number[]; // [x, y, w, h]

/** A rectangle in physical px (win32.ts Rect). */
export interface PxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A display's top-left in physical px from its DIP bounds (Electron) and scale factor. */
export function physicalOrigin(bounds: { x: number; y: number }, scaleFactor: number): { x: number; y: number } {
  return { x: Math.round(bounds.x * scaleFactor), y: Math.round(bounds.y * scaleFactor) };
}

/** The client area in frame px: `origin` is the captured frame's top-left on screen (the window's
 * extended frame for window capture, the display's physical origin for screen capture). */
export function clientInFrame(client: PxRect, origin: { x: number; y: number }): PxRect {
  return { x: client.x - origin.x, y: client.y - origin.y, width: client.width, height: client.height };
}

/** Size of each corner region the capture searches first for the Runestrip (frame px): wide
 * enough for the finder at the largest pitch and a full 64x4 strip at the default one. */
export const CORNER_W = 700;
export const CORNER_H = 160;

/** The client's four corners in frame px (top-left first: the default anchor), each reaching
 * 4 px outside the client for blur and rounding, clipped to the frame. */
export function clientCorners(frame: { width: number; height: number }, client: PxRect): { x: number; y: number; w: number; h: number }[] {
  const left = client.x - 4, top = client.y - 4;
  const right = client.x + client.width + 4 - CORNER_W, bottom = client.y + client.height + 4 - CORNER_H;
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const [x, y] of [[left, top], [right, top], [left, bottom], [right, bottom]]) {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(frame.width, x + CORNER_W), y1 = Math.min(frame.height, y + CORNER_H);
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

export interface Drag {
  kind: "move" | "size";
  target: "win" | "tracker";
  /** Cursor at drag start (physical px, client area). */
  c0: { x: number; y: number };
  /** Resize limits (physical px). */
  min?: [number, number];
  max?: [number, number];
}

interface LayoutLike {
  scr: number[];
  focus?: boolean;
  win?: Rect;
  list?: Rect;
  detail?: Rect;
  status?: Rect;
  tracker?: Rect;
  keys?: Record<string, Rect>;
}

const clamp = (v: number, lo = -Infinity, hi = Infinity) => Math.max(lo, Math.min(hi, v));

/** The layout as it is once the cursor is at (cx, cy): `base` is the layout at drag start. */
export function dragLayout<L extends LayoutLike>(base: L, d: Drag, cx: number, cy: number): L {
  const dx = cx - d.c0.x,
    dy = cy - d.c0.y;
  const [sw, sh] = base.scr;
  const box = d.target === "tracker" ? base.tracker : base.win;
  if (!box) return base;
  if (d.kind === "move") {
    // Familiar frames are clamped to the screen, like WoW's SetClampedToScreen.
    const ox = clamp(box[0] + dx, 0, Math.max(0, sw - box[2])) - box[0];
    const oy = clamp(box[1] + dy, 0, Math.max(0, sh - box[3])) - box[1];
    const mv = (r?: Rect) => (r ? [r[0] + ox, r[1] + oy, r[2], r[3]] : r);
    if (d.target === "tracker") return { ...base, tracker: mv(base.tracker) };
    return { ...base, win: mv(base.win), list: mv(base.list), detail: mv(base.detail), status: mv(base.status), keys: mapKeys(base.keys, mv) };
  }
  // Resizing from the bottom-right corner.
  const nw = clamp(box[2] + dx, d.min?.[0], d.max?.[0]);
  const nh = clamp(box[3] + dy, d.min?.[1], d.max?.[1]);
  if (d.target === "tracker") return { ...base, tracker: [box[0], box[1], nw, nh] };
  const dW = nw - box[2],
    dH = nh - box[3];
  const fit = (r: Rect | undefined, stretchX = false) => (r ? anchored(r, box, dW, dH, stretchX) : r);
  return {
    ...base,
    win: [box[0], box[1], nw, nh],
    list: fit(base.list),
    detail: fit(base.detail),
    status: fit(base.status, true), // spans from the left edge to the action buttons
    keys: mapKeys(base.keys, (r) => fit(r)),
  };
}

/** Where a child rect goes when its window grows by (dW, dH): big panes stretch with the window,
 * small ones stay attached to the nearer edge (toolbar buttons left/right, the action bar bottom). */
function anchored(r: Rect, win: Rect, dW: number, dH: number, stretchX: boolean): Rect {
  let [x, y, w, h] = r;
  const left = r[0] - win[0],
    right = win[0] + win[2] - (r[0] + r[2]);
  const top = r[1] - win[1],
    bottom = win[1] + win[3] - (r[1] + r[3]);
  if (stretchX || r[2] > win[2] * 0.5) w += dW;
  else if (right < left) x += dW;
  if (r[3] > win[3] * 0.5) h += dH;
  else if (bottom < top) y += dH;
  return [x, y, Math.max(0, w), Math.max(0, h)];
}

function mapKeys(keys: Record<string, Rect> | undefined, f: (r: Rect) => Rect | undefined) {
  return keys ? Object.fromEntries(Object.entries(keys).map(([k, r]) => [k, f(r) as Rect])) : keys;
}

/** Where a left-button press at (x, y) would start a drag of the Familiar window, judging from
 * the layout alone: the resize grip (bottom-right corner) resizes; the window's frame (title area,
 * borders) moves it; panes, the composer, the toolbar and bottom-bar rows and the close button
 * don't (their own widgets take the mouse in WoW). Used to start following before "dragstart". */
export function dragZone(layout: LayoutLike & { fpx?: number; px?: number }, x: number, y: number): Drag | null {
  const w = layout.win;
  if (!w || x < w[0] || y < w[1] || x > w[0] + w[2] || y > w[1] + w[3]) return null;
  const f = layout.fpx ?? layout.px ?? 1;
  const right = w[0] + w[2],
    bottom = w[1] + w[3];
  const zero = { x: 0, y: 0 };
  if (x >= right - 26 * f && y >= bottom - 26 * f)
    return { kind: "size", target: "win", c0: zero, min: [(layout.focus ? 324 : 560) * f, (layout.focus ? 300 : 340) * f], max: [1600 * f, 1100 * f] };
  const inside = (r?: Rect) => !!r && x >= r[0] && y >= r[1] && x <= r[0] + r[2] && y <= r[1] + r[3];
  if (inside(layout.list) || inside(layout.detail) || inside(layout.status)) return null;
  if (layout.keys && Object.values(layout.keys).some(inside)) return null;
  if (!layout.focus && y >= w[1] + 26 * f && y <= w[1] + 52 * f) return null; // toolbar row
  if (y >= bottom - 38 * f) return null; // bottom bar: Log, status, action buttons
  if (!layout.focus && x >= right - 36 * f && y <= w[1] + 36 * f) return null; // close button
  const d = layout.detail;
  if (d && y >= d[1] + d[3] && x >= d[0]) return null; // composer, under the detail pane
  return { kind: "move", target: "win", c0: zero };
}

/** Where the quest log sat inside the window, remembered from the last full layout, so expanding
 * it can be predicted: offsets from the window's top-left, width, gap to the bottom, gap to the
 * detail pane. */
export interface LogMemo {
  dx: number;
  dy: number;
  w: number;
  bottom: number;
  gap: number;
}

export function rememberLog(l: LayoutLike): LogMemo | undefined {
  if (!l.win || !l.list || !l.detail) return undefined;
  return {
    dx: l.list[0] - l.win[0],
    dy: l.list[1] - l.win[1],
    w: l.list[2],
    bottom: l.win[1] + l.win[3] - (l.list[1] + l.list[3]),
    gap: l.detail[0] - (l.list[0] + l.list[2]),
  };
}

/** The layout right after the quest log was collapsed or expanded: the window's right edge stays,
 * its left edge moves to `rect` (the window's new rect, from the addon); the detail pane takes or
 * gives back the log's room; the bottom bar text follows the left edge. The exact layout follows. */
export function logLayout<L extends LayoutLike>(base: L, collapsed: boolean, rect: Rect, memo?: LogMemo): L {
  const W = base.win;
  if (!W || rect.length < 4) return base;
  const d = rect[0] - W[0];
  const win: Rect = [rect[0], rect[1], rect[2], rect[3]];
  const right = win[0] + win[2];
  const D = base.detail;
  const rightGap = D ? W[0] + W[2] - (D[0] + D[2]) : 0;
  let list: Rect | undefined;
  let left: number;
  if (collapsed) {
    list = undefined;
    left = win[0] + (base.list ? base.list[0] - W[0] : memo?.dx ?? 0);
  } else {
    list = memo ? [win[0] + memo.dx, win[1] + memo.dy, memo.w, win[3] - memo.dy - memo.bottom] : undefined;
    left = list && memo ? list[0] + list[2] + memo.gap : D ? D[0] + d : win[0];
  }
  return {
    ...base,
    win,
    list,
    detail: D ? [left, D[1], right - rightGap - left, D[3]] : D,
    status: base.status ? [base.status[0] + d, base.status[1], base.status[2] - d, base.status[3]] : base.status,
  };
}

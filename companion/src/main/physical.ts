// Corroborates decisions that arrive over the Runestrip with physical input seen on the PC.
// Any Lua in the WoW client can draw strip frames (another addon, an imported UI string), so a
// "key approve" or a "click" message proves nothing by itself. Main polls read-only OS input
// (GetAsyncKeyState / GetCursorPos, see win32.ts) into a PressLog; a decision passes only when the
// player really released a mouse button on that button / card, or really pressed the Approve key
// registered in the control panel, within the strip's latency. Each physical act corroborates one
// message. Pure: no Electron, no koffi.

export type Rect = [number, number, number, number]; // client physical px, like layout rects
export interface Sample {
  at: number;
  x: number; // cursor, screen px
  y: number;
  left: boolean;
  right: boolean;
  down: Set<number>; // watched virtual keys currently down
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}
export interface Release {
  at: number;
  x: number;
  y: number;
  button: "L" | "R";
}
export interface KeyDown {
  at: number;
  vk: number;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}
export interface Bind {
  vk: number;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}
export interface Proof {
  ok: boolean;
  how: "click" | "bind" | "none";
  why?: string;
  x?: number;
  y?: number;
}

export const CLICK_WINDOW_MS = 1500; // strip latency: 70 ms hold x 2 frames, 30 fps capture, queue ahead
export const KEY_WINDOW_MS = 1500;
export const CLICK_TOL = 0.03; // of the region (about 12 px on a 400 px pane)
const KEEP_MS = 5000;
export const NO_PROOF: Proof = Object.freeze({ ok: false, how: "none", why: "no physical input" }) as Proof;
export const TRUSTED: Proof = Object.freeze({ ok: true, how: "none" }) as Proof; // dev hooks only

export class PressLog {
  releases: Release[] = [];
  keys: KeyDown[] = [];
  private prev?: Sample;
  sample(s: Sample) {
    const p = this.prev;
    if (p) {
      if (p.left && !s.left) this.releases.push({ at: s.at, x: s.x, y: s.y, button: "L" });
      if (p.right && !s.right) this.releases.push({ at: s.at, x: s.x, y: s.y, button: "R" });
      for (const vk of s.down) if (!p.down.has(vk)) this.keys.push({ at: s.at, vk, ctrl: s.ctrl, shift: s.shift, alt: s.alt });
    }
    this.prev = s;
    const cut = s.at - KEEP_MS;
    while (this.releases.length && this.releases[0].at < cut) this.releases.shift();
    while (this.keys.length && this.keys[0].at < cut) this.keys.shift();
  }
}

/** A click the addon reports for region `rect` (x,y 0..1 inside it, or undefined for a whole
 * button). Passes when a mouse button was really released inside that rect within CLICK_WINDOW_MS
 * and the reported position agrees; the proof carries the physical position so the Glass hit-tests
 * where the mouse really was. The release is consumed: one physical click corroborates one message. */
export function corroborateClick(
  log: PressLog,
  rect: Rect | undefined,
  reported: { x: number; y: number } | undefined,
  now: number,
  toClient: (x: number, y: number) => { x: number; y: number } | null,
): Proof {
  if (!Array.isArray(rect) || !(rect[2] > 0) || !(rect[3] > 0)) return { ok: false, how: "click", why: "no rect" };
  for (let i = log.releases.length - 1; i >= 0; i--) {
    const r = log.releases[i];
    if (now - r.at > CLICK_WINDOW_MS) break;
    const c = toClient(r.x, r.y);
    if (!c) continue;
    const rx = (c.x - rect[0]) / rect[2],
      ry = (c.y - rect[1]) / rect[3];
    if (rx < 0 || rx > 1 || ry < 0 || ry > 1) continue;
    if (reported && !(Math.abs(rx - reported.x) <= CLICK_TOL && Math.abs(ry - reported.y) <= CLICK_TOL))
      return { ok: false, how: "click", why: "reported position does not match the mouse" };
    log.releases.splice(i, 1);
    return { ok: true, how: "click", x: Math.round(rx * 1e4) / 1e4, y: Math.round(ry * 1e4) / 1e4 };
  }
  return { ok: false, how: "click", why: "no mouse release on it" };
}

/** The registered Approve key (with exactly its modifiers) was pressed within KEY_WINDOW_MS; consumed. */
export function corroborateKey(log: PressLog, bind: Bind | undefined, now: number): Proof {
  if (!bind) return { ok: false, how: "bind", why: "no Approve key registered in the control panel" };
  for (let i = log.keys.length - 1; i >= 0; i--) {
    const k = log.keys[i];
    if (now - k.at > KEY_WINDOW_MS) break;
    if (k.vk === bind.vk && k.ctrl === bind.ctrl && k.shift === bind.shift && k.alt === bind.alt) {
      log.keys.splice(i, 1);
      return { ok: true, how: "bind" };
    }
  }
  return { ok: false, how: "bind", why: "Approve key not pressed" };
}

// WoW binding names -> Win32 virtual keys (US layout for punctuation). Unknown = not verifiable.
const VK: Record<string, number> = {
  SPACE: 0x20, TAB: 0x09, ENTER: 0x0d, ESCAPE: 0x1b, BACKSPACE: 0x08, INSERT: 0x2d, DELETE: 0x2e,
  HOME: 0x24, END: 0x23, PAGEUP: 0x21, PAGEDOWN: 0x22, UP: 0x26, DOWN: 0x28, LEFT: 0x25, RIGHT: 0x27,
  BUTTON3: 0x04, BUTTON4: 0x05, BUTTON5: 0x06,
  NUMPADPLUS: 0x6b, NUMPADMINUS: 0x6d, NUMPADMULTIPLY: 0x6a, NUMPADDIVIDE: 0x6f, NUMPADDECIMAL: 0x6e,
  "`": 0xc0, "-": 0xbd, "=": 0xbb, "[": 0xdb, "]": 0xdd, "\\": 0xdc, ";": 0xba, "'": 0xde, ",": 0xbc, ".": 0xbe, "/": 0xbf,
};
/** "F9", "CTRL-F9", "SHIFT-ALT-NUMPAD5" (WoW's binding text) -> virtual key + modifiers. */
export function bindingToVk(s: string): Bind | undefined {
  const m = String(s ?? "").trim().toUpperCase().match(/^((?:CTRL-|SHIFT-|ALT-)*)(.+)$/);
  if (!m) return undefined;
  const [, mods, key] = m;
  const vk =
    VK[key] ??
    (/^[A-Z0-9]$/.test(key)
      ? key.charCodeAt(0)
      : /^F([1-9]|1\d|2[0-4])$/.test(key)
        ? 0x6f + Number(key.slice(1))
        : /^NUMPAD\d$/.test(key)
          ? 0x60 + Number(key.slice(6))
          : undefined);
  if (vk === undefined) return undefined;
  return { vk, ctrl: mods.includes("CTRL-"), shift: mods.includes("SHIFT-"), alt: mods.includes("ALT-") };
}

// Approval authority for decisions that arrive from the game.
// Any Lua in the WoW client can draw strip frames (another addon, an imported UI string), so a
// "key approve" or a "click" message is only a hint that something happened, and no rectangle the
// addon declares is ever used to approve. Main polls read-only OS input (GetAsyncKeyState /
// GetCursorPos, see win32.ts) into a PressLog, and the Glass reports where it painted each button
// that grants something (ApprovalGate). A grant passes only for a card the Glass has shown at an
// unchanged place for STABLE_MS with the game in front, on a fresh press and release of the
// registered Approve key, or a real mouse release inside the Glass's own button that the pointer
// entered after the card settled. Each physical act backs one decision. Pure: no Electron, no koffi.

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
  /** What this proof may grant: actKey()s of the cards that were eligible when the input happened. */
  for?: string[];
}

export const CLICK_WINDOW_MS = 1500; // strip latency: 70 ms hold x 2 frames, 30 fps capture, queue ahead
export const KEY_WINDOW_MS = 1500;
export const CLICK_TOL = 0.03; // of the region (about 12 px on a 400 px pane)
const KEEP_MS = 5000;
export const NO_PROOF: Proof = Object.freeze({ ok: false, how: "none", why: "no physical input" }) as Proof;
/** Already verified (the hub's own follow-on actions) or the token-gated dev hooks: covers anything. */
export const TRUSTED: Proof = Object.freeze({ ok: true, how: "none" }) as Proof;
/** The Approve key is down but not released yet: main asks again at the release. */
export const KEY_HELD = "Approve key still held";
/** The card had not been on the Glass for STABLE_MS when the key went down or the button was released. */
export const TOO_SOON = "the request had not been on the Glass long enough";

/** What a granting action is about: its type, quest, request and answer (or, for a card that carries
 * a typed message, a hash of that message). A proof names the keys it covers. */
export function actKey(a: { type?: unknown; thread?: unknown; requestId?: unknown; decision?: unknown; label?: unknown; hash?: unknown }): string {
  return JSON.stringify([a.type, a.thread, a.requestId, a.decision ?? a.label ?? a.hash].map((v) => (typeof v === "string" ? v : "")));
}
/** Does `proof` back this exact action? Only TRUSTED itself covers an action without naming it. */
export function proofCovers(proof: Proof, key: string): boolean {
  return proof === TRUSTED || (proof.ok && !!proof.for?.includes(key));
}

/** Screen px. */
export interface Box { x: number; y: number; width: number; height: number }
const inBox = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
const TRAIL_MAX = 600;

export class PressLog {
  releases: Release[] = [];
  keys: KeyDown[] = [];
  /** Key releases, and where the pointer went: one entry per move, so a resting pointer keeps its history. */
  ups: { at: number; vk: number }[] = [];
  trail: { at: number; x: number; y: number }[] = [];
  private prev?: Sample;
  sample(s: Sample) {
    const p = this.prev;
    if (p) {
      if (p.left && !s.left) this.releases.push({ at: s.at, x: s.x, y: s.y, button: "L" });
      if (p.right && !s.right) this.releases.push({ at: s.at, x: s.x, y: s.y, button: "R" });
      for (const vk of s.down) if (!p.down.has(vk)) this.keys.push({ at: s.at, vk, ctrl: s.ctrl, shift: s.shift, alt: s.alt });
      for (const vk of p.down) if (!s.down.has(vk)) this.ups.push({ at: s.at, vk });
    }
    if (!p || p.x !== s.x || p.y !== s.y) {
      this.trail.push({ at: s.at, x: s.x, y: s.y });
      if (this.trail.length > TRAIL_MAX) this.trail.shift();
    }
    this.prev = s;
    const cut = s.at - KEEP_MS;
    while (this.releases.length && this.releases[0].at < cut) this.releases.shift();
    while (this.keys.length && this.keys[0].at < cut) this.keys.shift();
    while (this.ups.length && this.ups[0].at < cut) this.ups.shift();
  }
  /** When the pointer last came into `box` (screen px) at or before `at`. Undefined when the kept
   * trail never shows it outside: it cannot be shown to have entered. */
  enteredAt(box: Box, at: number): number | undefined {
    let entered: number | undefined;
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const t = this.trail[i];
      if (t.at > at) continue;
      if (!inBox(box, t.x, t.y)) return entered;
      entered = t.at;
    }
    return undefined;
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

// ---- the approval gate ---------------------------------------------------------------------------
export const STABLE_MS = 800; // a card sits unchanged this long, in front, before anything approves it
const MAX_TARGETS = 16;
/** A granting button is a button: never wider than half the Glass or taller than a fifth of it. */
const MAX_BUTTON = { w: 0.5, h: 0.2 };

/** One granting button as the Glass painted it. `rect` (the button) and `card` (its card) are
 * fractions of the Glass viewport, which covers the game's client area; `sig` changes with the
 * card's text. */
export interface Painted {
  act: { type: string; thread?: string; requestId?: string; decision?: string; label?: string; hash?: string };
  rect: Rect;
  card: Rect;
  sig: string;
}

const isFrac = (r: unknown): r is Rect =>
  Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number" && Number.isFinite(n)) &&
  r[0] >= 0 && r[1] >= 0 && r[2] > 0 && r[3] > 0 && r[0] + r[2] <= 1.0001 && r[1] + r[3] <= 1.0001;

/** Which painted cards may be approved right now, and the proof for one decision. Fed only by the
 * Glass renderer's report and main's own view of the windows; nothing from the addon reaches it. */
export class ApprovalGate {
  private targets = new Map<string, { p: Painted; since: number }>();
  private liveSince: number | undefined;

  /** The Glass renderer's list of the granting buttons it has on screen (replaces the last list).
   * A button that moved or resized, or whose card changed, starts its wait again; malformed,
   * oversized and duplicated entries are dropped. */
  report(list: unknown, now: number) {
    const next = new Map<string, { p: Painted; since: number }>();
    const twice = new Set<string>();
    for (const raw of Array.isArray(list) ? list.slice(0, MAX_TARGETS) : []) {
      const act = raw?.act;
      if (!act || typeof act.type !== "string" || typeof raw.sig !== "string" || raw.sig.length > 64) continue;
      if (!isFrac(raw.rect) || !isFrac(raw.card) || raw.rect[2] > MAX_BUTTON.w || raw.rect[3] > MAX_BUTTON.h) continue;
      const p: Painted = { act, rect: [...raw.rect] as Rect, card: [...raw.card] as Rect, sig: raw.sig };
      const key = actKey(act);
      if (next.has(key)) twice.add(key);
      const old = this.targets.get(key);
      const same = !!old && old.p.sig === p.sig && String(old.p.rect) === String(p.rect) && String(old.p.card) === String(p.card);
      next.set(key, { p, since: same ? old.since : now });
    }
    for (const key of twice) next.delete(key);
    this.targets = next;
  }

  /** Live: the Glass is showing, the game (or the Glass) is the foreground window and the link is
   * up. Losing any of them voids every card's wait. */
  setLive(live: boolean, now: number) {
    if (!live) this.liveSince = undefined;
    else this.liveSince ??= now;
  }

  /** The window or the layout moved, or the link reconnected: every card waits again. */
  rearm(now: number) {
    for (const t of this.targets.values()) t.since = now;
    if (this.liveSince !== undefined) this.liveSince = now;
  }

  get size() {
    return this.targets.size;
  }
  has(key: string) {
    return this.targets.has(key);
  }

  /** From when this card may be approved (possibly still ahead), or undefined. */
  eligibleAt(key: string): number | undefined {
    const t = this.targets.get(key);
    return t && this.liveSince !== undefined ? Math.max(t.since, this.liveSince) + STABLE_MS : undefined;
  }

  /** The registered Approve key (exactly its modifiers) was pressed and released within
   * KEY_WINDOW_MS. The proof covers the cards that were already eligible at the press. Consumed. */
  proveKey(log: PressLog, bind: Bind | undefined, now: number): Proof {
    if (!bind) return { ok: false, how: "bind", why: "no Approve key registered in the control panel" };
    for (let i = log.keys.length - 1; i >= 0; i--) {
      const k = log.keys[i];
      if (now - k.at > KEY_WINDOW_MS) break;
      if (k.vk !== bind.vk || k.ctrl !== bind.ctrl || k.shift !== bind.shift || k.alt !== bind.alt) continue;
      if (!log.ups.some((u) => u.vk === k.vk && u.at > k.at)) return { ok: false, how: "bind", why: KEY_HELD };
      log.keys.splice(i, 1);
      const covered = [...this.targets.keys()].filter((key) => this.eligibleAt(key)! <= k.at);
      if (!covered.length) return { ok: false, how: "bind", why: this.targets.size ? TOO_SOON : "no request was on the Glass when the key was pressed" };
      return { ok: true, how: "bind", for: covered };
    }
    return { ok: false, how: "bind", why: "Approve key not pressed" };
  }

  /** A left release inside the Glass's own button for exactly this action, after the card became
   * eligible, by a pointer that came onto the button after that too. `client`: the game's client
   * area on screen, which the Glass covers. Consumed. */
  proveClick(log: PressLog, key: string, client: Box | null, now: number): Proof {
    const t = this.targets.get(key);
    const from = this.eligibleAt(key);
    if (!t || from === undefined || !client) return { ok: false, how: "click", why: "that button is not on the Glass" };
    const [x, y, w, h] = t.p.rect;
    const box: Box = { x: client.x + x * client.width, y: client.y + y * client.height, width: w * client.width, height: h * client.height };
    for (let i = log.releases.length - 1; i >= 0; i--) {
      const r = log.releases[i];
      if (now - r.at > CLICK_WINDOW_MS) break;
      if (r.button !== "L" || !inBox(box, r.x, r.y)) continue;
      if (r.at < from) return { ok: false, how: "click", why: TOO_SOON };
      const entered = log.enteredAt(box, r.at);
      if (entered === undefined || entered < from) return { ok: false, how: "click", why: "the pointer was on the button before the request settled" };
      log.releases.splice(i, 1);
      return { ok: true, how: "click", for: [key] };
    }
    return { ok: false, how: "click", why: "no mouse release on the Glass button" };
  }
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

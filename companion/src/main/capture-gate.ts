// Screen-capture fallback gate. In window mode WGC composes only the game window; in screen mode the
// frame is the whole monitor, so any window drawn over the strip (a browser, another app) could feed
// Runestrip messages. Strip messages are accepted there only while the game (or our Glass) is the
// foreground window and no other visible top-level window above the game overlaps the strip box.
// Pure: main supplies the window facts (win32.ts windowsAbove / foregroundKey).
import { MAX_COLS, MAX_ROWS } from "../link/decoder";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** A window above the game that overlaps the strip (no title: logs never carry other apps' content). */
export interface Covering {
  exe: string;
  cls: string;
}
export type Verdict = { ok: true } | { ok: false; why: string };

/** Same margin as the capture renderer's decode region around a lock. */
const MARGIN = 6;

export const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The box the capture decodes from, in screen px: the lock (frame px) offset by the frame's screen origin. */
export function stripScreenBox(lock: { x: number; y: number; pitch: number }, origin: { x: number; y: number }): Box {
  const x = Math.floor(origin.x + lock.x - MARGIN), y = Math.floor(origin.y + lock.y - MARGIN);
  const right = Math.ceil(origin.x + lock.x + MAX_COLS * lock.pitch + MARGIN), bottom = Math.ceil(origin.y + lock.y + MAX_ROWS * lock.pitch + MARGIN);
  return { x, y, width: right - x, height: bottom - y };
}

export interface ScreenGateFacts {
  captureMode: "window" | "screen";
  /** hwnd keys ("0" = none). */
  foreground: string;
  game: string | null;
  overlay: string;
  /** Where the strip sits on screen; null while the capture has no lock. */
  strip: Box | null;
  /** Windows above the game overlapping `strip`; null when the game is not in the Z order walk. */
  covering: Covering[] | null;
}

export function screenCaptureTrusted(f: ScreenGateFacts): Verdict {
  if (f.captureMode !== "screen") return { ok: true };
  if (!f.game || f.game === "0") return { ok: false, why: "no game window" };
  if (f.foreground !== f.game && f.foreground !== f.overlay) return { ok: false, why: "game is not the foreground window" };
  if (!f.strip) return { ok: false, why: "no strip lock" };
  if (!f.covering) return { ok: false, why: "game window not found in Z order" };
  if (f.covering.length) {
    const c = f.covering[0];
    return { ok: false, why: `another window covers the strip (${c.exe || "?"}, class ${c.cls || "?"})` };
  }
  return { ok: true };
}

/** At most one log line per `everyMs` for refused batches. */
export class RefusalLog {
  private last = -Infinity;
  constructor(private everyMs = 5000) {}
  shouldLog(now: number): boolean {
    if (now - this.last < this.everyMs) return false;
    this.last = now;
    return true;
  }
}

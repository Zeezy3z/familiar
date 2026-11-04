// Link Doctor: one honest sentence about why the game link isn't up, from the stage state main
// already has (game window, capture frames, strip lock, CRC, screen-capture gate). Pure: main
// supplies the facts; the control panel shows the line and Copy diagnostics carries it.

export interface Doctor {
  step: "game" | "frames" | "strip" | "crc" | "covered" | "ok";
  level: "ok" | "warn" | "muted";
  text: string;
}

export interface DoctorFacts {
  /** A game window is known. */
  game: boolean;
  minimized: boolean;
  /** The game (or the Glass) is the foreground window. */
  foreground: boolean;
  captureMode: "window" | "screen";
  /** fps: 0 when no frame statistics arrived lately. lock: where the strip was found. lastOk: the
   * last decoded strip frame (ms epoch, 0 = never). */
  stats: { fps: number; crc: number; lock: { x: number; y: number; pitch: number } | null | undefined; lastOk: number };
  /** Since when the game has been on screen for this link attempt (found or restored), ms epoch. */
  startedAt: number;
  now: number;
  /** Screen capture only: the program whose window covered the strip in the last 5 s. */
  refusedExe?: string;
}

export const DOCTOR_OK = "Game link working.";

export function linkDoctor(s: DoctorFacts): Doctor {
  if (!s.game) return { step: "game", level: "muted", text: "WoW isn't open, or isn't in Windowed / Windowed (Fullscreen)." };
  if (s.now - (s.stats.lastOk || 0) < 3000) return { step: "ok", level: "ok", text: DOCTOR_OK };
  return { step: "strip", level: "muted", text: "Looking for the game link…" };
}

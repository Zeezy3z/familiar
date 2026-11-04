// Link Doctor: one honest sentence about why the game link isn't up, from the stage state main
// already has (game window, capture frames, strip lock, decoded frames, screen-capture gate). Pure:
// main supplies the facts; the control panel shows the line and Copy diagnostics carries it.

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
  /** fps: 0 when no frame statistics arrived lately. lock: where the strip was found (null: not
   * found). lastOk: the last decoded strip frame (ms epoch, 0 = never). */
  stats: { fps: number; crc: number; lock: { x: number; y: number; pitch: number } | null | undefined; lastOk: number };
  /** Since when the game has been on screen for this link attempt (found or restored), ms epoch. */
  startedAt: number;
  now: number;
  /** Screen capture only: the program whose window covered the strip in the last 5 s ("" when
   * unknown); undefined when nothing did. */
  refusedExe?: string;
}

export const DOCTOR_OK = "Game link working.";
/** How long each stage may take before it is called a problem (a WoW loading screen is shorter). */
export const FRAMES_GRACE_MS = 5000;
export const STRIP_GRACE_MS = 8000;
/** Linked: a strip frame decoded this recently (main's linked()). */
export const LINK_FRESH_MS = 3000;

const warn = (step: Doctor["step"], text: string): Doctor => ({ step, level: "warn", text });
const waiting = (step: Doctor["step"], text: string): Doctor => ({ step, level: "muted", text });

export function linkDoctor(s: DoctorFacts): Doctor {
  if (!s.game) return waiting("game", "WoW isn't open, or isn't in Windowed / Windowed (Fullscreen).");
  if (s.minimized) return warn("game", "WoW is minimized. Restore it; the link only works while the game is on screen.");
  if (s.captureMode === "screen" && s.refusedExe !== undefined)
    return warn("covered", `The link is on screen capture and ${s.refusedExe || "another window"} covers the strip. Move that window, or /fam strip tr.`);
  if (s.captureMode === "screen" && !s.foreground)
    return warn("covered", "The link is on screen capture, which reads WoW only while it is in front. Click into WoW.");
  const lastOk = s.stats.lastOk || 0;
  if (s.now - lastOk < LINK_FRESH_MS) return { step: "ok", level: "ok", text: DOCTOR_OK };
  // Each stage gets its grace time from when the game came on screen or the link was last up.
  const waited = s.now - Math.max(s.startedAt || 0, lastOk);
  if (!s.stats.fps)
    return waited > FRAMES_GRACE_MS
      ? warn("frames", "WoW is open but Familiar gets no picture of it. Another always-on-top app may block capture; try the other display mode, or HDR off for that monitor.")
      : waiting("frames", "Starting to read the WoW window…");
  // The strip was found but no frame decoded for LINK_FRESH_MS: its colours don't read back.
  if (s.stats.lock)
    return warn("crc", "The strip is there but can't be read. A colour filter, HDR or a scaling mismatch is the usual cause: /fam strip vivid, HDR off, or move WoW to one monitor.");
  return waited > STRIP_GRACE_MS
    ? warn("strip", "Familiar sees the game but no coloured strip in its top-left corner. In game: is Familiar ticked in AddOns? Type /fam strip — it should say TOPLEFT. If something covers that corner, /fam strip tr.")
    : waiting("strip", "Looking for the coloured strip in WoW's top-left corner…");
}

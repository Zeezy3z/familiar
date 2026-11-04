// Windows notices (tray balloons) for requests waiting while WoW isn't in front. Pure: main decides
// whether the game is in front and shows the balloon; this only says whether and what.

export interface TrayNotice {
  title: string;
  content: string;
}

/** The toast as far as a notice needs it: its kind and, for a quest's toast, real names. */
export interface NoticeToast {
  kind: "done" | "approval" | "error" | "info";
  project?: string;
  questTitle?: string;
}

export interface NoticeContext {
  /** WoW is the foreground window (or the Glass is) and not minimized. */
  gameInFront: boolean;
  /** Hide names / Stream-safe: the notice names nothing. */
  privateMode: boolean;
  /** The player's "Windows notice when a request is waiting" setting. */
  trayNotices: boolean;
}

// Windows cuts balloon titles at 63 characters and text at 255.
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A notice only for approvals (finished quests wait in the catch-up notes), only while WoW isn't
 * in front, only when the setting is on; generic under Hide names. */
export function trayNoticeFor(toast: NoticeToast, ctx: NoticeContext): TrayNotice | null {
  if (toast.kind !== "approval" || !ctx.trayNotices || ctx.gameInFront) return null;
  if (ctx.privateMode || !toast.project) return { title: "Needs approval", content: "A quest is waiting for your say-so." };
  return {
    title: clip(`Needs approval · ${toast.project}`, 63),
    content: clip(`${toast.questTitle || "A quest"} — open Familiar to read and approve it, or answer in game.`, 255),
  };
}

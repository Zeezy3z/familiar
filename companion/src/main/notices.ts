// Windows notices (tray balloons) for requests waiting while WoW isn't in front. Pure: main decides
// whether the game is in front and shows the balloon; this only says whether and what.
import { NEEDS_YOU } from "../shared/words";

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

/** A notice for approvals and for finished quests, only while WoW isn't in front, only when the
 * setting is on; generic under Hide names. */
export function trayNoticeFor(toast: NoticeToast, ctx: NoticeContext): TrayNotice | null {
  if ((toast.kind !== "approval" && toast.kind !== "done") || !ctx.trayNotices || ctx.gameInFront) return null;
  if (toast.kind === "done") {
    if (ctx.privateMode || !toast.project) return { title: "Quest finished", content: "A familiar has finished. Its reply is waiting in game." };
    return { title: clip(`Quest finished · ${toast.project}`, 63), content: clip(`${toast.questTitle || "A quest"} is done.`, 255) };
  }
  if (ctx.privateMode || !toast.project) return { title: NEEDS_YOU, content: "A quest is waiting for your say-so." };
  return {
    title: clip(`${NEEDS_YOU} · ${toast.project}`, 63),
    content: clip(`${toast.questTitle || "A quest"} — open Familiar to read and approve it, or answer in game.`, 255),
  };
}

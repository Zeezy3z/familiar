// One name per state, wherever the Glass shows it: the waiting banner, the quest header's chip, the
// tracker, the welcome line and the status bar. The hub's render model and the Glass both read these.
export const NEEDS_YOU = "Needs you";
export const INCOMPLETE_REQUEST = "Familiar cannot show this request in full. Deny it and ask for a smaller request.";
export const REPLY_READY = "Reply ready";

/** "1 needs you" / "2 need you" */
export const needYou = (n: number) => `${n} ${n === 1 ? "needs" : "need"} you`;
/** "1 reply ready" / "2 replies ready" */
export const repliesReady = (n: number) => `${n} ${n === 1 ? "reply" : "replies"} ready`;

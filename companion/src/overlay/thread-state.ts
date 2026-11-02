import type { DetailModel } from "../hub/viewmodel";
import { STOP_NOTICE, USAGE_LIMIT_NOTICE } from "../shared/notes";

// Read only; the label must not mistake an interrupted idle turn for a finished reply.
export function threadState(d: Extract<DetailModel, { kind: "thread" }>) {
  if (d.historyError && !d.entries.length) return { label: "History unavailable", hint: "Use Retry below to load saved messages", level: "warn" };
  if (d.loading && !d.entries.length) return { label: "Loading conversation", hint: "Saved messages will appear here", level: "muted" };
  if (d.external) return { label: "Desktop conversation", hint: "Asks before continuing here", level: "muted" };
  if (d.status === "approval") return { label: "Needs your approval", hint: "Review the request below", level: "warn" };
  if (d.status === "running") return { label: "Working", hint: "You can send a follow-up or use Stop", level: "working" };
  if (d.status === "error") return { label: "Needs attention", hint: "Read the notice below before trying again", level: "error" };
  const lastUser = d.entries.findLastIndex(e => e.kind === "user");
  const turn = d.entries.slice(lastUser + 1);
  const notice = turn.findLast(e => e.kind === "notice" && (STOP_NOTICE.test(e.text) || USAGE_LIMIT_NOTICE.test(e.text)));
  if (notice && STOP_NOTICE.test(notice.text)) return { label: "Interrupted", hint: "Send a message when you’re ready to continue", level: "warn" };
  if (notice && USAGE_LIMIT_NOTICE.test(notice.text)) return { label: "Waiting for usage reset", hint: "Ctrl+Up recalls your message when you can retry", level: "warn" };
  if (turn.some(e => e.kind === "assistant" && e.text.trim() && !e.streaming)) return { label: "Reply ready", hint: "Read below or send your next message", level: "ok" };
  return { label: "Ready for your message", hint: "Enter sends · Shift+Enter adds a line", level: "muted" };
}

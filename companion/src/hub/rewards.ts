// What a quest earned: the rewards line under its Quest Complete / Quest Failed banner, and the spend
// formatting the tracker and quest details share. Pure (no hub state beyond the thread passed in).
import type { Thread } from "./hub";

/** Tools whose entries are file edits (Claude's names; Codex fileChange and ACP edits arrive as "Edit"). */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** "3/3 objectives · 2 edits · $0.21": objectives done, edits this turn, spend. Counts and a cost
 * only, never a name, path or reply text, so private mode keeps it. Chats get none; nothing to say
 * → undefined. */
export function rewards(t: Thread): string | undefined {
  if (t.kind === "chat") return undefined;
  const parts: string[] = [];
  if (t.todos.length) parts.push(`${t.todos.filter((x) => x.status === "completed").length}/${t.todos.length} objectives`);
  const lastUser = t.entries.map((x) => x.kind).lastIndexOf("user");
  // A refused or failed edit changed nothing, so it is not counted.
  const edits = t.entries.slice(lastUser + 1).filter((x) => x.kind === "tool" && EDIT_TOOLS.has(x.name ?? "") && x.status !== "error").length;
  if (edits) parts.push(`${edits} edit${edits === 1 ? "" : "s"}`);
  const cost = costLabel(t.usage);
  if (cost) parts.push(cost);
  return parts.length ? parts.join(" · ") : undefined;
}

/** A quest's spend as its agent reported it (displayed, never sent anywhere): dollars, else tokens. */
export function costLabel(u: Thread["usage"]): string | undefined {
  if (u?.costUsd) return dollars(u.costUsd);
  const tokens = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);
  return tokens ? `${fmtK(tokens)} tokens` : undefined;
}

export const dollars = (usd: number) => (usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);

export function fmtK(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

import type { Entry, Hub, Thread } from "./hub";
import { createHash } from "node:crypto";
import { MODE_LABEL } from "../agents/types";
import { STOP_NOTICE, USAGE_LIMIT_NOTICE } from "../shared/notes";

export interface AttentionItem {
  thread: string;
  entry: string;
  revision: string;
  title: string;
  project: string;
  cwd: string;
  agent: string;
  mode: string;
  label: string;
  excerpt: string;
  pending: boolean;
  at: number;
}

// Saved events, never expiring toasts or a model-generated recap.
export function attentionEntry(t: Thread): Entry | undefined {
  // Match the request the existing keyboard approve/deny commands will act on.
  return t.entries.find(e => e.kind === "approval" && e.approval === "pending") ??
    t.entries.findLast(e =>
      (e.kind === "assistant" && !!e.text.trim() && !e.streaming) ||
      (e.kind === "approval" && e.approval === "expired") ||
      (e.kind === "notice" && (e.level === "error" || STOP_NOTICE.test(e.text) || USAGE_LIMIT_NOTICE.test(e.text))));
}

// Repeated render pushes revisit completed replies. Keep only the last exact
// fingerprint per live entry; the weak key lets discarded history be collected.
const revisions = new WeakMap<Entry, { id: string; fields: readonly (string | undefined)[]; revision: string }>();

// Providers may correct a final message under the same item ID. A stale click must not hide it.
export function attentionRevision(e: Entry): string {
  const fields = [e.kind, e.text, e.title, e.approval, e.level];
  const cached = revisions.get(e);
  if (cached?.id === e.id && fields.every((value, index) => value === cached.fields[index])) return cached.revision;
  const revision = `${e.id}:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
  revisions.set(e, { id: e.id, fields, revision });
  return revision;
}

export function attentionItems(hub: Hub): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const t of hub.threads.values()) {
    const e = attentionEntry(t);
    if (!e) continue;
    const pending = e.kind === "approval" && e.approval === "pending";
    const revision = attentionRevision(e);
    if (!pending && t.attentionSeen === revision) continue;
    const label = pending ? "Needs approval" : e.kind === "approval" ? "Request expired" :
      e.kind === "assistant" ? "Reply waiting" : STOP_NOTICE.test(e.text) ? "Interrupted" : "Needs attention";
    const excerpt = e.kind === "approval" ? e.title ?? e.text : e.text;
    const mode = t.kind === "chat" ? "Chat" : MODE_LABEL[t.mode];
    items.push({ thread: t.id, entry: e.id, revision, title: t.title, project: hub.projectName(t), cwd: t.cwd,
      agent: t.agent, mode, label, excerpt: excerpt.slice(0, 160) + (excerpt.length > 160 ? "…" : ""), pending, at: e.at });
  }
  return items.sort((a, b) => Number(b.pending) - Number(a.pending) || b.at - a.at);
}

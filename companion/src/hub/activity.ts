import type { Hub } from "./hub";

// A live presentation snapshot, not permission or a lock to restart the companion.
export function activity(hub: Hub) {
  const threads = [...hub.threads.values()];
  return {
    working: threads.filter(t => t.status === "running" || t.status === "approval").length,
    approvals: threads.reduce((n, t) => n + t.entries.filter(e => e.kind === "approval" && e.approval === "pending").length, 0),
    confirmation: !!hub.view.confirm,
  };
}

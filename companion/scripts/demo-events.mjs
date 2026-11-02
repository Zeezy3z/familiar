// Dev visual QA: inject synthetic agent events into the running companion (FAMILIAR_DEV=1).
// Usage: node scripts/demo-events.mjs approval-edit|todos <threadId>
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const C = "http://127.0.0.1:47810";
const token = readFileSync(join(tmpdir(), "familiar-dev-47810.token"), "utf8"); // written by this dev run (src/main/dev-hooks.ts)
const [kind, threadId] = process.argv.slice(2);
const inject = (e) => fetch(C + "/inject", { method: "POST", headers: { "x-familiar-dev-token": token }, body: JSON.stringify({ agent: "claude", threadId, ...e }) }).then((r) => r.text());
if (kind === "approval-edit") {
  console.log(await inject({
    type: "approval", requestId: "claude:demo-" + Date.now(), kind: "tool", canAlways: true,
    title: "Claude wants to edit hub.ts",
    detail: [String.raw`D:\src\familiar\companion\src\hub\hub.ts`, "-    if (!this.opened.has(t.id)) {", "+    if (!b.isOpen(t.id)) {", "-      this.opened.add(t.id);", "+      // backends own open-state now"].join("\n"),
  }));
} else if (kind === "todos") {
  console.log(await inject({ type: "todo", items: [
    { text: "Read the ingest pipeline", status: "completed" },
    { text: "Write a failing test for the dedupe bug", status: "completed" },
    { text: "Fix dedupe key to include payload CRC", status: "in_progress" },
    { text: "Run the full suite", status: "pending" },
  ] }));
}

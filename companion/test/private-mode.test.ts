// Private (streamer) mode: the render model, notices and the FamiliarSync snapshot carry no real
// project names, titles, desktop threads or (snapshot) transcript; approval previews stay complete.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentBackend, AgentEvent, BackendStatus, HistoryEntry, StartOptions, ThreadInfo } from "../src/agents/types";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "familiar-private-")));
process.env.APPDATA = tmp;
const projRoot = path.join(tmp, "dev");
for (const p of ["secret-alpha", "secret-beta"]) fs.mkdirSync(path.join(projRoot, p), { recursive: true });

const { Hub } = await import("../src/hub/hub");
const { DEFAULT_CONFIG } = await import("../src/hub/config");
const { buildModel } = await import("../src/hub/viewmodel");
const { buildSnapshot } = await import("../src/main/wow");

class FakeBackend implements AgentBackend {
  handlers: ((e: AgentEvent) => void)[] = [];
  open_ = new Set<string>();
  constructor(readonly kind: string) {}
  async init(): Promise<BackendStatus> { return this.status(); }
  status(): BackendStatus { return { ready: true, account: "test", models: [{ id: "m1", label: "M1", isDefault: true }] }; }
  async listThreads(): Promise<ThreadInfo[]> {
    return [{ nativeId: "ext-1", agent: this.kind, cwd: path.join(projRoot, "secret-beta"), title: "Hush desktop plan", updatedAt: Date.now() - 3600_000 }];
  }
  async readHistory(): Promise<HistoryEntry[]> { return [{ kind: "assistant", text: "desktop reply" }]; }
  isOpen(id: string) { return this.open_.has(id); }
  async open(o: StartOptions) { this.open_.add(o.threadId); return `native-${o.threadId}`; }
  async send() {}
  async interrupt() {}
  respondApproval() {}
  async setMode() {}
  async setModel() {}
  async close(id: string) { this.open_.delete(id); }
  async shutdown() {}
  on(h: (e: AgentEvent) => void) { this.handlers.push(h); return () => {}; }
  emit(e: AgentEvent) { for (const h of this.handlers) h(e); }
}

const cfg = { ...DEFAULT_CONFIG, projectRoots: [projRoot], speak: true, exclude: DEFAULT_CONFIG.exclude.filter((e) => !e.includes("temp")) };
let claude: FakeBackend, hub: InstanceType<typeof Hub>;
const SECRETS = /secret-alpha|secret-beta|Refactor billing|Hush desktop plan|Launch notes|desktop reply|The vault key moved/;
const model = () => buildModel(hub, { linked: true, fps: 30 });

beforeEach(async () => {
  process.env.APPDATA = fs.mkdtempSync(path.join(tmp, "state-"));
  cfg.privateMode = false;
  claude = new FakeBackend("claude");
  hub = new Hub(() => cfg, { claude }, () => {});
  hub.minCardAgeMs = 0;
  hub.projects.scanRoots();
  await hub.refreshExternal();
});

async function scene() {
  await hub.quick("claude", "@secret-alpha Launch notes");
  const done = hub.view.selected!;
  claude.emit({ type: "message", threadId: done, itemId: "a1", text: "The vault key moved to the new folder." });
  claude.emit({ type: "done", threadId: done, status: "completed" });
  await hub.quick("claude", "@secret-beta Refactor billing");
  const pending = hub.view.selected!;
  claude.emit({ type: "approval", threadId: pending, requestId: "r1", kind: "command", title: "Run: rm -rf build", detail: "rm -rf build && npm run deploy", canAlways: false });
  return { done, pending };
}

describe("private mode", () => {
  it("masks names, hides desktop threads and transcripts, keeps approval previews, and restores on toggle off", async () => {
    const spoken: string[] = [];
    hub.onSpeak = (t) => spoken.push(t);
    await hub.key("private", "on");
    expect(cfg.privateMode).toBe(true);
    const { done, pending } = await scene();

    const m = model();
    // Everything painted (row keys and actions are ids for clicks, never drawn).
    const visible = JSON.stringify({ rows: m.list.rows.map((r) => [r.text, r.sub]), target: m.target, tracker: m.tracker,
      attention: m.attention?.map(({ revision: _r, entry: _e, thread: _t, ...i }) => i), toasts: m.toasts,
      detail: m.detail.kind === "thread" ? { title: m.detail.title, project: m.detail.project, cwd: m.detail.cwd } : m.detail });
    expect(visible).not.toMatch(SECRETS);
    expect(visible).not.toContain(projRoot.replace(/\\/g, "\\\\"));
    expect(m.list.rows.some((r) => r.kind === "ext")).toBe(false);
    expect(m.list.rows.filter((r) => r.kind === "zone").map((r) => r.text)).toEqual(["Chats", "Project 1", "Project 2"]);
    expect(m.list.rows.filter((r) => r.kind === "thread").map((r) => r.text).sort()).toEqual(["Quest #1", "Quest #2"]);
    // The selected pending quest: generic header, full approval preview.
    expect(m.detail.kind === "thread" && m.detail.id).toBe(pending);
    if (m.detail.kind !== "thread") throw new Error("thread detail expected");
    expect(m.detail.title).toMatch(/^Quest #\d$/);
    expect(m.detail.project).toMatch(/^Project \d$/);
    const card = m.detail.entries.find((e) => e.kind === "approval")!;
    expect(card.title).toBe("Run: rm -rf build");
    expect(card.text).toBe("rm -rf build && npm run deploy");
    expect(m.attention?.find((i) => i.pending)?.excerpt).toBe("Run: rm -rf build");
    // Toasts: generic only; nothing spoken.
    expect(m.toasts.map((t) => t.text)).toEqual(expect.arrayContaining(["Claude finished", "Claude needs approval"]));
    expect(spoken).toEqual([]);
    // Names stay stable across renders.
    expect(model().list.rows.map((r) => r.text)).toEqual(m.list.rows.map((r) => r.text));

    // FamiliarSync: no titles, no transcript.
    for (const id of [done, pending]) {
      hub.action({ type: "select", id });
      const snap = buildSnapshot(hub);
      expect(snap).not.toMatch(SECRETS);
      expect(snap).not.toMatch(/rm -rf|You:/);
      expect(snap).toMatch(/Quest #\d/);
    }
    // A desktop thread selected while private is not shown at all.
    hub.action({ type: "select", id: "ext:claude:ext-1" });
    expect(model().detail.kind).toBe("welcome");
    expect(buildSnapshot(hub)).not.toMatch(SECRETS);

    // Real data stays in the hub.
    expect([...hub.threads.values()].map((t) => t.title)).toEqual(expect.arrayContaining(["Launch notes", "Refactor billing"]));

    // Off: everything back.
    await hub.key("private", "off");
    hub.action({ type: "select", id: done });
    const back = model();
    expect(back.private).toBeUndefined();
    const text = JSON.stringify(back);
    for (const s of ["secret-alpha", "secret-beta", "Launch notes", "Refactor billing", "Hush desktop plan"]) expect(text).toContain(s);
    claude.emit({ type: "approval", threadId: pending, requestId: "r2", kind: "command", title: "Run: npm test", detail: "npm test", canAlways: false });
    expect(model().toasts.some((t) => t.text.includes("secret-beta") && t.text.includes("Run: npm test"))).toBe(true);
    expect(buildSnapshot(hub)).toContain("The vault key moved");
  });

  it("chats are titled Chats / Chat #n", async () => {
    cfg.privateMode = true;
    hub.threads.set("c1", { id: "c1", kind: "chat", agent: "claude", cwd: path.join(tmp, "chats"), projectKey: "chats", title: "Is the Onyxia key worth it",
      status: "idle", mode: "ask", entries: [], todos: [], createdAt: 1, updatedAt: Date.now(), unread: false, origin: "familiar" } as any);
    const rows = model().list.rows;
    expect(rows.find((r) => r.kind === "zone" && r.key === "chats")?.text).toBe("Chats");
    expect(rows.find((r) => r.key === "c1")?.text).toBe("Chat #1");
    expect(JSON.stringify(rows)).not.toContain("Onyxia");
  });
});

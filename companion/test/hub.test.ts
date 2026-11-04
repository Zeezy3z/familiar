// Hub state machine with fake backends (no agents, no Electron). APPDATA is redirected to a fresh
// temp dir per test so the real %APPDATA%\Familiar state is never touched and a save timer left
// behind by an earlier test's Hub can't write threads.json into a later test's state.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activity } from "../src/hub/activity";
import { describeOverlayAction } from "../src/main/log-file";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { buildSnapshot } from "../src/main/wow";
import type { AgentBackend, AgentEvent, BackendStatus, Decision, HistoryEntry, Mode, StartOptions, ThreadInfo } from "../src/agents/types";

// realpath: on CI runners os.tmpdir() is an 8.3 short path (RUNNER~1); the hub compares real paths.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "familiar-hub-")));
let appData = tmp;
process.env.APPDATA = appData;
const projRoot = path.join(tmp, "dev");
for (const p of ["alpha", "beta", "familiar", "node_modules", "private-vault", "gamma"]) fs.mkdirSync(path.join(projRoot, p), { recursive: true });

const { Hub } = await import("../src/hub/hub");
const { DEFAULT_CONFIG, loadConfig, saveConfig } = await import("../src/hub/config");
const { buildModel } = await import("../src/hub/viewmodel");
const { projectRootOf } = await import("../src/hub/projects");
const { NO_PROOF } = await import("../src/main/physical");
/** What main hands the Hub when a decision coincided with a real click (physical.ts). */
const OK = { ok: true, how: "click" as const };

class FakeBackend implements AgentBackend {
  failOpen = false;
  handlers: ((e: AgentEvent) => void)[] = [];
  open_ = new Map<string, StartOptions>();
  sent: { threadId: string; text: string }[] = [];
  decisions: { requestId: string; d: Decision }[] = [];
  interrupted: string[] = [];
  modes: Mode[] = [];
  constructor(readonly kind: string) {}
  async init(): Promise<BackendStatus> {
    return this.status();
  }
  status(): BackendStatus {
    return { ready: true, account: "test", models: [{ id: "m1", label: "M1", isDefault: true }, { id: "m2", label: "M2" }] };
  }
  extra: Omit<ThreadInfo, "agent">[] = [];
  async listThreads(): Promise<ThreadInfo[]> {
    return [
      { nativeId: "ext-1", agent: this.kind, cwd: path.join(projRoot, "beta"), title: "Old desktop thread", updatedAt: Date.now() - 3600_000 },
      ...this.extra.map((x) => ({ ...x, agent: this.kind })),
    ];
  }
  async readHistory(_nativeId?: string, _cwd?: string, _limit?: number): Promise<HistoryEntry[]> {
    return [{ kind: "user" as const, text: "hi" }, { kind: "assistant" as const, text: "hello" }];
  }
  isOpen(id: string) {
    return this.open_.has(id);
  }
  /** Native ids the agent's own app (or a terminal) has open right now. */
  held = new Set<string>();
  heldElsewhere(nativeId: string) {
    return this.held.has(nativeId);
  }
  async open(o: StartOptions) {
    if (this.failOpen) throw new Error("thread/start: boom");
    await tick();
    this.open_.set(o.threadId, o);
    return o.resumeNativeId ?? `native-${o.threadId}`;
  }
  async send(threadId: string, text: string) {
    this.sent.push({ threadId, text });
  }
  async interrupt(threadId: string) {
    this.interrupted.push(threadId);
  }
  respondApproval(_t: string, requestId: string, d: Decision) {
    this.decisions.push({ requestId, d });
  }
  async setMode(_t: string, m: Mode) {
    this.modes.push(m);
  }
  async setModel() {}
  async close(id: string) {
    this.open_.delete(id);
  }
  archived: [string, boolean][] = [];
  canArchive = false;
  async archive(id: string, on: boolean) {
    this.archived.push([id, on]);
    return this.canArchive;
  }
  /** "Continue in <app>": what was handed over, in order. */
  handedOff: string[] = [];
  async handOff(threadId: string | undefined, nativeId: string) {
    if (threadId) await this.close(threadId);
    this.handedOff.push(nativeId);
    return `${this.kind}://open/${nativeId}`;
  }
  async shutdown() {}
  on(h: (e: AgentEvent) => void) {
    this.handlers.push(h);
    return () => {};
  }
  emit(e: AgentEvent) {
    for (const h of this.handlers) h(e);
  }
}

let claude: FakeBackend, codex: FakeBackend, hub: InstanceType<typeof Hub>;
// The temp dir lives under AppData\Local\Temp, which the default exclusion list hides; drop that one
// entry. private-vault stands in for a folder the user added to `exclude` in config.json.
const cfg = { ...DEFAULT_CONFIG, projectRoots: [projRoot], exclude: [...DEFAULT_CONFIG.exclude.filter((e) => !e.includes("temp")), "\\private-vault"] };
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  appData = fs.mkdtempSync(path.join(tmp, "state-"));
  process.env.APPDATA = appData;
  claude = new FakeBackend("claude");
  codex = new FakeBackend("codex");
  hub = new Hub(() => cfg, { claude, codex }, () => {});
  hub.minCardAgeMs = 0; // the 400 ms "read it first" rule has its own test
  hub.projects.scanRoots();
  await hub.refreshExternal();
});

describe("Hub", () => {
  it("focus decision keys never fall back to another thread, including stale layouts and malformed context", async () => {
    await hub.quick("codex", "@familiar waiting");
    const waiting = hub.view.selected!;
    codex.emit({ type: "approval", threadId: waiting, requestId: "hidden", kind: "command", title: "Hidden request", detail: "Full hidden details", canAlways: true });
    await hub.quick("claude", "@familiar active");
    const selected = hub.view.selected!;
    for (const view of ["focus", "unknown", "legacy", undefined, null, true, {}]) for (const k of ["approve", "deny", "always"]) {
      hub.handleAddon({ t: "key", k, view });
      await tick();
      expect(codex.decisions).toEqual([]);
      expect(hub.view.selected).toBe(selected);
    }
    expect(hub.toasts.some(t => /Full view|focus/i.test(t.text))).toBe(true);
    claude.emit({ type: "approval", threadId: selected, requestId: "visible", kind: "tool", title: "Visible request", detail: "Full visible details", canAlways: true });
    hub.handleAddon({ t: "key", k: "approve", view: "focus" }, OK);
    hub.handleAddon({ t: "key", k: "always", view: "focus" }, OK);
    await tick();
    expect(claude.decisions).toEqual([{ requestId: "visible", d: "allow" }]);
    expect(codex.decisions).toEqual([]);
    // Missing context after a capable key is never treated as legacy, even after a delayed hello.
    (hub as any).lastDecisionAt = 0;
    hub.handleAddon({ t: "key", k: "deny" });
    hub.handleAddon({ t: "hello" });
    hub.handleAddon({ t: "key", k: "deny" });
    await tick();
    expect(codex.decisions).toEqual([]);
    // The hello capability independently establishes the same conservative boundary.
    const capable = new Hub(() => cfg, { claude, codex }, () => {});
    capable.threads = hub.threads;
    capable.view.selected = selected;
    capable.handleAddon({ t: "hello", viewKeys: 1 });
    capable.handleAddon({ t: "hello" });
    capable.handleAddon({ t: "key", k: "deny" });
    await tick();
    expect(codex.decisions).toEqual([]);
    // A truly old addon on a fresh Hub retains its existing sole-request fallback.
    const legacy = new Hub(() => cfg, { claude, codex }, () => {});
    legacy.threads = hub.threads;
    legacy.view.selected = selected;
    legacy.handleAddon({ t: "key", k: "deny" });
    await tick();
    expect(codex.decisions).toEqual([{ requestId: "hidden", d: "deny" }]);
  });

  it("malformed decision context cannot confirm desktop or held prompts; focus keeps their selected semantics", async () => {
    const external = "ext:claude:ext-1";
    hub.action({ type: "select", id: external });
    await hub.prompt("Review before continuing");
    expect(hub.view.confirm).toBeTruthy();
    hub.handleAddon({ t: "key", k: "approve", view: "invalid" });
    await tick();
    expect(hub.view.confirm).toBeTruthy();
    expect(claude.sent).toEqual([]);
    hub.handleAddon({ t: "key", k: "deny", view: "focus" });
    await tick();
    expect(hub.view.confirm).toBeUndefined();
    await hub.quick("codex", "@familiar local thread");
    const local = hub.selectedThread()!;
    codex.emit({ type: "done", threadId: local.id, status: "completed" });
    codex.held.add(local.nativeId!);
    await hub.prompt("held reply");
    expect(hub.view.held?.threadId).toBe(local.id);
    (hub as any).lastDecisionAt = 0;
    hub.handleAddon({ t: "key", k: "approve", view: null });
    await tick();
    expect(hub.view.held?.text).toBe("held reply");
    expect(codex.sent.map(item => item.text)).not.toContain("held reply");
    hub.handleAddon({ t: "key", k: "deny", view: "focus" });
    await tick();
    expect(hub.view.held).toBeUndefined();
  });

  it("Glass Stop is bound to the selected current thread and cannot stop a newer selection", async () => {
    await hub.quick("codex", "@familiar first");
    const first = hub.view.selected!;
    await hub.quick("claude", "@familiar second");
    const second = hub.view.selected!;
    hub.action({ type: "stop", thread: first });
    await tick();
    expect(codex.interrupted).toEqual([]);
    expect(claude.interrupted).toEqual([]);
    hub.action({ type: "stop", thread: second });
    await tick();
    expect(claude.interrupted).toEqual([second]);
    claude.emit({ type: "done", threadId: second, status: "completed" });
    hub.action({ type: "stop", thread: second });
    await tick();
    expect(claude.interrupted).toEqual([second]);
  });

  it("approval preview expansion is read-only for pending, resolved and expired requests", async () => {
    await hub.quick("codex", "@familiar preview");
    const id = hub.view.selected!;
    const detail = "Review this change.\n".repeat(80);
    codex.emit({ type: "approval", threadId: id, requestId: "preview", kind: "command", title: "Run command?", detail, canAlways: true });
    const action = { type: "approvalPreview", thread: id, id: "p:preview" };
    const card = () => {
      const d = buildModel(hub, { linked: true, fps: 30 }).detail;
      if (d.kind !== "thread") throw new Error("Expected a thread");
      return d.entries.find(e => e.id === action.id)!;
    };
    hub.action({ ...action, thread: "other" });
    expect(card().expanded).toBe(false);
    hub.action(action);
    expect(card()).toMatchObject({ expanded: true, text: detail, approval: "pending", canAlways: true });
    expect(codex.decisions).toEqual([]);
    expect(hub.selectedThread()?.mode).toBe("ask");
    codex.emit({ type: "approvalResolved", threadId: id, requestId: "preview" });
    hub.action(action);
    expect(card()).toMatchObject({ expanded: false, approval: "expired" });
    hub.action({ type: "decide", thread: id, requestId: "preview", decision: "allow" });
    expect(codex.decisions).toEqual([]);
    codex.emit({ type: "approval", threadId: id, requestId: "resolved", kind: "command", title: "Run command?", detail, canAlways: false });
    hub.action({ type: "decide", thread: id, requestId: "resolved", decision: "deny" });
    hub.action({ ...action, id: "p:resolved" });
    expect(hub.selectedThread()?.entries.find(e => e.id === "p:resolved")?.approval).toBe("denied");
    expect(hub.view.expanded.has("p:resolved")).toBe(true);
    expect(codex.decisions).toEqual([{ requestId: "resolved", d: "deny" }]);
  });

  it("history failures leave Loading, Retry is single-flight, and successful empty history is explicit", async () => {
    const id = "ext:claude:ext-1";
    let resolve!: (h: HistoryEntry[]) => void;
    let reject!: (e: Error) => void;
    const read = vi.spyOn(claude, "readHistory").mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const model = () => buildModel(hub, { linked: true, fps: 30 }).detail;
    hub.action({ type: "select", id });
    hub.action({ type: "select", id });
    hub.action({ type: "more", id });
    expect(model()).toMatchObject({ loading: true, historyEmpty: false });
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    reject(new Error("synthetic read failure"));
    await tick();
    expect(model()).toMatchObject({ loading: false, historyError: "Couldn't load this conversation's history.", historyEmpty: false, entries: [] });
    hub.action({ type: "retryHistory", id });
    hub.action({ type: "retryHistory", id });
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(model()).toMatchObject({ loading: true, historyError: undefined });
    resolve([]);
    await tick();
    expect(model()).toMatchObject({ loading: false, historyError: undefined, historyEmpty: true, entries: [], more: false });
  });

  it("failed Load earlier preserves the visible entries/window and Retry uses the same requested size", async () => {
    const id = "ext:claude:ext-1";
    const initial: HistoryEntry[] = Array.from({ length: 160 }, (_, i) => ({ kind: "assistant", text: `Saved ${i}` }));
    const read = vi.spyOn(claude, "readHistory").mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("synthetic earlier failure"));
    hub.action({ type: "select", id });
    await tick();
    const before = buildModel(hub, { linked: true, fps: 30 }).detail;
    if (before.kind !== "thread") throw new Error("Expected a thread");
    hub.action({ type: "more", id });
    hub.action({ type: "more", id });
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][2]).toBe(450);
    expect(hub.view.window[id]).toBe(150);
    expect(hub.extHistory.get(id)).toBe(initial);
    expect(buildModel(hub, { linked: true, fps: 30 }).detail).toMatchObject({ loading: false, entries: before.entries, historyError: expect.stringContaining("Your loaded messages are still here") });
    const earlier: HistoryEntry[] = [...Array.from({ length: 160 }, (_, i) => ({ kind: "assistant" as const, text: `Earlier ${i}` })), ...initial];
    read.mockResolvedValueOnce(earlier);
    hub.action({ type: "retryHistory", id });
    await tick();
    expect(read.mock.calls[2][2]).toBe(450);
    expect(hub.view.window[id]).toBe(300);
    expect(buildModel(hub, { linked: true, fps: 30 }).detail).toMatchObject({ loading: false, historyError: undefined });
  });

  it.each(["success", "failure"])("ignores obsolete history %s after switching away and back, with no overlapping reads", async outcome => {
    const id = "ext:claude:ext-1";
    const pending: { resolve: (h: HistoryEntry[]) => void; reject: (e: Error) => void }[] = [];
    const read = vi.spyOn(claude, "readHistory").mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    hub.action({ type: "select", id });
    await tick();
    hub.action({ type: "select", id: "ext:codex:ext-1" });
    hub.action({ type: "more", id }); // Stale click cannot operate on the other conversation.
    hub.action({ type: "select", id });
    hub.action({ type: "select", id });
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    if (outcome === "success") pending[0].resolve([{ kind: "assistant", text: "Obsolete" }]);
    else pending[0].reject(new Error("Obsolete failure"));
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(hub.extHistory.has(id)).toBe(false);
    expect(buildModel(hub, { linked: true, fps: 30 }).detail).toMatchObject({ loading: true, historyError: undefined, entries: [] });
    pending[1].resolve([{ kind: "assistant", text: "Current" }]);
    await tick();
    expect(buildModel(hub, { linked: true, fps: 30 }).detail).toMatchObject({ loading: false, historyError: undefined, entries: [{ text: "Current" }] });
  });

  it("lists zones from the root but never excluded folders", () => {
    const names = hub.projects.list().map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["alpha", "beta", "familiar", "gamma"]));
    for (const bad of ["node_modules", "private-vault"]) expect(names).not.toContain(bad);
  });

  it("never offers an excluded folder as a zone, listed or typed", async () => {
    const vault = path.join(projRoot, "private-vault");
    hub.projects.scanRoots();
    const names = hub.projects.list().map((p) => p.name);
    expect(names).toContain("beta");
    expect(names).not.toContain("private-vault");
    expect(hub.projects.add(path.join(vault, "statements"))).toBeNull();
    await hub.key("newClaude");
    await hub.prompt(vault); // typed as a folder path while picking a zone
    expect(hub.view.draft).toBeUndefined();
  });

  it("a .nofamiliar file hides its folder and everything below it", async () => {
    const hidden = path.join(projRoot, "delta");
    fs.mkdirSync(path.join(hidden, "src"), { recursive: true });
    fs.writeFileSync(path.join(hidden, ".nofamiliar"), "");
    try {
      const h = new Hub(() => cfg, { claude, codex }, () => {});
      h.projects.scanRoots();
      const names = h.projects.list().map((p) => p.name);
      expect(names).toContain("alpha");
      expect(names).not.toContain("delta");
      expect(h.projects.add(hidden)).toBeNull();
      expect(h.projects.add(path.join(hidden, "src"))).toBeNull(); // e.g. a history cwd inside it
      expect(h.projects.add(path.join(hidden, ".claude", "worktrees", "w"))).toBeNull();
    } finally {
      fs.rmSync(hidden, { recursive: true, force: true });
    }
  });

  it("never offers the home folder or a drive root as a zone", () => {
    expect(hub.projects.add(os.homedir())).toBeNull();
    expect(hub.projects.add(path.parse(tmp).root)).toBeNull();
    expect(hub.projects.list().map((p) => p.path)).not.toContain(os.homedir());
  });

  it("+Claude → pick zone → prompt starts a quest in that folder", async () => {
    await hub.key("newClaude");
    expect(hub.view.list).toBe("pick");
    const wow = hub.projects.list().find((p) => p.name === "familiar")!;
    hub.action({ type: "pick", key: wow.key });
    expect(hub.view.draft?.cwd).toBe(wow.path);
    await hub.prompt("Fix the tests");
    expect(claude.sent).toEqual([{ threadId: hub.view.selected, text: "Fix the tests" }]);
    const t = hub.selectedThread()!;
    expect(t.cwd).toBe(wow.path);
    expect(t.mode).toBe("ask");
    expect(t.title).toBe("Fix the tests");
    expect(hub.view.list).toBe("quests");
  });

  it("typing a zone name in pick mode selects it; @zone quick quests work", async () => {
    await hub.key("newCodex");
    await hub.prompt("alph");
    expect(hub.view.draft?.projectKey).toBe(hub.projects.list().find((p) => p.name === "alpha")!.key);
    await hub.quick("claude", "@beta summarize the open issues");
    const t = hub.selectedThread()!;
    expect(t.agent).toBe("claude");
    expect(path.basename(t.cwd)).toBe("beta");
    expect(claude.sent.at(-1)!.text).toBe("summarize the open issues");
  });

  it("streams deltas, finalizes messages, and toasts on completion", async () => {
    await hub.quick("claude", "@familiar hello");
    const id = hub.view.selected!;
    claude.emit({ type: "turnStarted", threadId: id });
    claude.emit({ type: "delta", threadId: id, itemId: "m1", channel: "text", text: "Hel" });
    claude.emit({ type: "delta", threadId: id, itemId: "m1", channel: "text", text: "lo" });
    expect(hub.threads.get(id)!.entries.at(-1)).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
    claude.emit({ type: "message", threadId: id, itemId: "m1", text: "Hello there." });
    claude.emit({ type: "done", threadId: id, status: "completed" });
    const t = hub.threads.get(id)!;
    expect(t.status).toBe("idle");
    expect(t.entries.at(-1)).toMatchObject({ text: "Hello there.", streaming: false });
    expect(hub.toasts.at(-1)!.kind).toBe("done");
    expect(hub.toasts.at(-1)!.text).toMatch(/^Quest Complete · /);
    expect(hub.toasts.at(-1)!.text).not.toContain("Hello there");
  });

  it("finish toasts name the quest only: Quest Complete, Answer ready for a chat, Quest Failed", async () => {
    await hub.quick("claude", "@familiar ship it");
    const quest = hub.view.selected!;
    claude.emit({ type: "done", threadId: quest, status: "failed", error: "boom" });
    expect(hub.toasts.at(-1)).toMatchObject({ kind: "error", text: "Quest Failed · ship it", generic: "Quest Failed" });
    await hub.ask("is the hearth lit?");
    claude.emit({ type: "done", threadId: hub.view.selected!, status: "completed" });
    expect(hub.toasts.at(-1)).toMatchObject({ kind: "done", text: "Answer ready · is the hearth lit?", generic: "Answer ready" });
  });

  it("approvals: pending → approve via key → backend gets allow; status recovers", async () => {
    await hub.quick("codex", "@familiar do it");
    const id = hub.view.selected!;
    codex.emit({ type: "approval", threadId: id, requestId: "codex:7", kind: "command", title: "Run command?", detail: "npm test", canAlways: true });
    expect(hub.threads.get(id)!.status).toBe("approval");
    expect(buildModel(hub, { linked: true, fps: 30 }).keys.approve).toBe(true);
    await hub.key("approve", undefined, "legacy", OK);
    expect(codex.decisions).toEqual([{ requestId: "codex:7", d: "allow" }]);
    const e = hub.threads.get(id)!.entries.find((x) => x.requestId === "codex:7")!;
    expect(e.approval).toBe("approved");
    expect(hub.threads.get(id)!.status).toBe("running");
  });

  it("card buttons decide a specific request; Always maps to allowAlways", async () => {
    await hub.quick("claude", "@familiar edit");
    const id = hub.view.selected!;
    claude.emit({ type: "approval", threadId: id, requestId: "claude:a", kind: "tool", title: "Edit?", detail: "-a\n+b", canAlways: true });
    hub.action({ type: "decide", thread: id, requestId: "claude:a", decision: "allowAlways" }, OK);
    expect(claude.decisions).toEqual([{ requestId: "claude:a", d: "allowAlways" }]);
  });

  it("restart guidance observes active quests and every pending request through the existing Hub journey", async () => {
    await hub.quick("claude", "@familiar synthetic activity");
    const id = hub.view.selected!;
    expect(activity(hub).working).toBe(1);
    for (const requestId of ["first", "second"])
      claude.emit({ type: "approval", threadId: id, requestId, kind: "tool", title: "Synthetic request", detail: "Fixture only", canAlways: false });
    expect(activity(hub)).toEqual({ working: 1, approvals: 2, confirmation: false });
    for (const requestId of ["first", "second"]) claude.emit({ type: "approvalResolved", threadId: id, requestId });
    claude.emit({ type: "done", threadId: id, status: "completed" });
    expect(activity(hub)).toEqual({ working: 0, approvals: 0, confirmation: false });
    const ext = [...hub.external.keys()][0];
    hub.action({ type: "select", id: ext });
    await hub.prompt("Synthetic unsent handoff");
    expect(activity(hub).confirmation).toBe(true);
    expect(claude.sent).toHaveLength(1); // No real model; only the earlier fake-backend message.
  });

  it("catch-up opens the oldest pending request that the approval shortcut acts on, including older history", async () => {
    await hub.quick("claude", "@familiar review fixtures");
    const id = hub.view.selected!;
    claude.emit({ type: "approval", threadId: id, requestId: "first", kind: "tool", title: "First request", detail: "Synthetic first", canAlways: false });
    const t = hub.selectedThread()!;
    t.entries.push(...Array.from({ length: 160 }, (_, i) => ({ id: `fixture-${i}`, kind: "notice" as const, text: "Synthetic progress", at: Date.now() })));
    claude.emit({ type: "approval", threadId: id, requestId: "second", kind: "tool", title: "Second request", detail: "Synthetic second", canAlways: false });
    const item = buildModel(hub, { linked: true, fps: 30 }).attention![0];
    expect(item.excerpt).toBe("First request");
    hub.action({ type: "select", id, entry: item.entry });
    const detail = buildModel(hub, { linked: true, fps: 30 }).detail;
    expect(detail.kind === "thread" && detail.entries.some(e => e.id === item.entry)).toBe(true);
    await hub.key("approve", undefined, "legacy", OK);
    expect(claude.decisions).toEqual([{ requestId: "first", d: "allow" }]);
    expect(buildModel(hub, { linked: true, fps: 30 }).attention![0].excerpt).toBe("Second request");
  });

  it("mode cycles Ask first / Plan only from the game, never Accept edits or Auto, and is pushed to the backend; stop interrupts", async () => {
    await hub.quick("claude", "@familiar x");
    const id = hub.view.selected!;
    await hub.key("mode", undefined, "legacy", OK);
    expect(hub.threads.get(id)!.mode).toBe("plan");
    await hub.key("mode", undefined, "legacy", OK);
    expect(hub.threads.get(id)!.mode).toBe("ask");
    // A thread set to edits/auto elsewhere (control panel, desktop app) drops back to ask.
    for (const m of ["auto", "edits"] as const) {
      hub.threads.get(id)!.mode = m;
      await hub.key("mode", undefined, "legacy", OK);
      expect(hub.threads.get(id)!.mode).toBe("ask");
    }
    expect(claude.modes).toEqual(["plan", "ask", "ask", "ask"]);
    claude.emit({ type: "turnStarted", threadId: id });
    await hub.key("stop");
    expect(claude.interrupted).toEqual([id]);
  });

  it("selecting a desktop thread loads history; sending adopts and resumes it", async () => {
    const extId = [...hub.external.keys()].find((k) => k.startsWith("ext:claude:"))!;
    hub.action({ type: "select", id: extId });
    await tick();
    expect(hub.extHistory.get(extId)?.length).toBe(2);
    await hub.prompt("continue please");
    // Never continues a real desktop session silently: a confirmation is pending, nothing sent.
    expect(hub.view.confirm).toMatchObject({ extId, text: "continue please" });
    expect(claude.sent).toEqual([]);
    hub.action({ type: "adoptConfirm" }, OK);
    await tick();
    await tick();
    const t = hub.selectedThread()!;
    expect(t.origin).toBe("external");
    expect(claude.open_.get(t.id)?.resumeNativeId).toBe("ext-1");
    expect(claude.open_.get(t.id)?.fork).toBe(false); // touched an hour ago → resume, not fork
    expect(t.entries.map((e) => e.kind)).toEqual(["user", "assistant", "user"]);
    // Continued here, it's listed once (as the quest), so continuing it again doesn't ask again.
    await hub.refreshExternal();
    expect(hub.external.has(extId)).toBe(false);
  });

  it("a desktop thread open in another app is continued as a fork; a closed one in place", async () => {
    claude.extra = [
      { nativeId: "tab", cwd: path.join(projRoot, "beta"), title: "Open in a tab", updatedAt: Date.now() - 86_400_000, open: true },
      { nativeId: "shut", cwd: path.join(projRoot, "beta"), title: "Closed just now", updatedAt: Date.now() - 1000, open: false },
    ];
    await hub.refreshExternal();
    for (const [id, fork] of [["tab", true], ["shut", false]] as const) {
      hub.action({ type: "select", id: `ext:claude:${id}` });
      await tick();
      await hub.prompt("go on");
      hub.action({ type: "adoptConfirm" }, OK);
      await tick();
      await tick();
      const t = hub.selectedThread()!;
      expect(claude.open_.get(t.id)).toMatchObject({ resumeNativeId: id, fork });
    }
  });

  it("a continued desktop thread keeps the mode its app recorded; without one it takes Familiar's default", async () => {
    claude.extra = [
      { nativeId: "planned", cwd: path.join(projRoot, "beta"), title: "Planning", updatedAt: Date.now() - 86_400_000, mode: "plan" },
      { nativeId: "plain", cwd: path.join(projRoot, "beta"), title: "No mode", updatedAt: Date.now() - 86_400_000 },
    ];
    await hub.refreshExternal();
    for (const [id, mode] of [["planned", "plan"], ["plain", cfg.defaultMode]] as const) {
      hub.action({ type: "select", id: `ext:claude:${id}` });
      await tick();
      const d = buildModel(hub, { linked: true, fps: 30 }).detail;
      expect(d.kind === "thread" && d.mode).toBe(mode === "plan" ? "Plan only" : "Ask first"); // shown before sending
      await hub.prompt("go on");
      hub.action({ type: "adoptConfirm" }, OK);
      await tick();
      await tick();
      const t = hub.selectedThread()!;
      expect(t.mode).toBe(mode);
      expect(claude.open_.get(t.id)).toMatchObject({ resumeNativeId: id, mode });
    }
  });

  it("continuing a desktop thread the app holds offers Retry: once the app lets go, the same conversation continues", async () => {
    claude.extra = [{ nativeId: "tab", cwd: path.join(projRoot, "beta"), title: "Open in a tab", updatedAt: Date.now() - 86_400_000, open: true }];
    claude.held.add("tab");
    await hub.refreshExternal();
    hub.action({ type: "select", id: "ext:claude:tab" });
    await tick();
    await hub.prompt("go on");
    const card = () => {
      const d = buildModel(hub, { linked: true, fps: 30 }).detail;
      return d.kind === "thread" ? d.confirm : undefined;
    };
    expect(card()).toMatchObject({ text: "go on", fork: true, retry: true });
    hub.action({ type: "adoptRetry" }, OK); // still open in the app: nothing happens but a hint
    await tick();
    expect(card()).toMatchObject({ fork: true });
    expect(claude.open_.size).toBe(0);
    claude.held.clear(); // the player quit the app
    hub.action({ type: "adoptRetry" }, OK);
    await tick();
    await tick();
    const t = hub.selectedThread()!;
    expect(claude.open_.get(t.id)).toMatchObject({ resumeNativeId: "tab", fork: false });
    expect(claude.sent).toEqual([{ threadId: t.id, text: "go on" }]);
  });

  it("/fam suggest opens a pre-filled issue form (versions only) without corroboration", async () => {
    const opened: string[] = [];
    hub.openIssue = (url) => opened.push(url);
    hub.suggestVersions = () => ({ familiar: "0.1.0", wow: "1.60.2.70500", iface: 16002, windows: "10.0.26200" });
    await hub.key("suggest", "Let me rename quests", "full", NO_PROOF);
    expect(opened).toHaveLength(1);
    const q = new URL(opened[0]).searchParams;
    expect(q.get("suggestion")).toBe("Let me rename quests");
    expect(q.get("diagnostics")).toContain("WoW client 1.60.2.70500 (interface 16002)");
    expect(hub.toasts.at(-1)!.text).toBe("Opened a pre-filled GitHub issue in your browser. Review it and submit there; nothing is sent until you do.");
    await hub.key("suggest", "", "full", NO_PROOF);
    expect(opened).toHaveLength(1);
    expect(hub.toasts.at(-1)!.text).toMatch(/Usage: \/fam suggest/);
  });

  it("Continue in <app> hands a finished quest over: Familiar lets go first, then the app opens the same conversation", async () => {
    const opened: string[] = [];
    hub.openExternal = (url) => opened.push(url);
    await hub.quick("codex", "@familiar refactor the parser");
    const t = hub.selectedThread()!;
    expect(t.nativeId).toBeTruthy();
    const native = t.nativeId!;
    expect(codex.isOpen(t.id)).toBe(true);
    const detail = () => {
      const d = buildModel(hub, { linked: true, fps: 30 }).detail;
      return d.kind === "thread" ? d : undefined;
    };
    // While it works, the quest stays here.
    codex.emit({ type: "turnStarted", threadId: t.id });
    expect(detail()?.handOff).toBeUndefined();
    hub.action({ type: "openInApp" });
    await tick();
    expect(opened).toEqual([]);
    codex.emit({ type: "done", threadId: t.id, status: "completed" });
    expect(detail()?.handOff).toMatchObject({ app: "Codex" });
    await hub.key("open"); // /fam open, same as the button
    await tick();
    expect(codex.handedOff).toEqual([native]);
    expect(codex.isOpen(t.id)).toBe(false); // Familiar's own session closed before the app took over
    expect(opened).toEqual([`codex://open/${native}`]);
    expect(t.entries.at(-1)).toMatchObject({ kind: "notice", text: expect.stringMatching(/Codex app/) });
    // The app now has it open: the next message from the game asks instead of forking.
    codex.held.add(native);
    await hub.prompt("one more thing");
    expect(detail()?.held).toMatchObject({ text: "one more thing" });
    codex.held.clear(); // closed in the app
    hub.action({ type: "heldRetry" }, OK);
    await tick();
    await tick();
    expect(codex.open_.get(t.id)).toMatchObject({ resumeNativeId: native, fork: false });
    expect(codex.sent.at(-1)).toEqual({ threadId: t.id, text: "one more thing" });
  });

  it("a listed desktop thread opens in its own app without Familiar holding anything", async () => {
    const opened: string[] = [];
    hub.openExternal = (url) => opened.push(url);
    const extId = [...hub.external.keys()].find((k) => k.startsWith("ext:claude:"))!;
    hub.action({ type: "select", id: extId });
    await tick();
    const d = buildModel(hub, { linked: true, fps: 30 }).detail;
    expect(d.kind === "thread" && d.handOff).toMatchObject({ app: "Claude" });
    hub.action({ type: "openInApp" });
    await tick();
    expect(claude.handedOff).toEqual(["ext-1"]);
    expect(opened).toEqual(["claude://open/ext-1"]);
    expect(hub.threads.size).toBe(0); // nothing adopted
  });

  it("a quest whose conversation was reopened in the app asks before the next turn instead of forking", async () => {
    const extId = [...hub.external.keys()].find((k) => k.startsWith("ext:claude:"))!;
    hub.action({ type: "select", id: extId });
    await tick();
    await hub.prompt("first");
    hub.action({ type: "adoptConfirm" }, OK);
    await tick();
    await tick();
    const t = hub.selectedThread()!;
    const held = () => {
      const d = buildModel(hub, { linked: true, fps: 30 }).detail;
      return d.kind === "thread" ? d.held : undefined;
    };
    claude.held.add("ext-1"); // the player opened it in the Claude app again
    await hub.prompt("second");
    expect(held()).toMatchObject({ text: "second" });
    expect(claude.sent.map((s) => s.text)).toEqual(["first"]);
    expect(t.entries.filter((e) => e.kind === "user").map((e) => e.text)).toEqual(["hi", "first"]); // not added while waiting
    hub.action({ type: "heldRetry" }, OK);
    await tick();
    expect(claude.sent.map((s) => s.text)).toEqual(["first"]);
    claude.held.clear();
    hub.action({ type: "heldRetry" }, OK);
    await tick();
    await tick();
    expect(held()).toBeUndefined();
    expect(claude.sent.map((s) => s.text)).toEqual(["first", "second"]);
    expect(claude.open_.get(t.id)).toMatchObject({ resumeNativeId: "ext-1", fork: false });
    // Held again: this time the player continues as a copy.
    claude.held.add("ext-1");
    await hub.prompt("third");
    hub.action({ type: "heldCopy" }, OK);
    await tick();
    await tick();
    await tick();
    expect(claude.open_.get(t.id)).toMatchObject({ resumeNativeId: "ext-1", fork: true });
    expect(claude.sent.map((s) => s.text)).toEqual(["first", "second", "third"]);
    expect(t.entries.filter((e) => e.kind === "user").map((e) => e.text)).toEqual(["hi", "first", "second", "third"]);
  });

  it("abandon hides a quest, refuses while running, and persists across restarts", async () => {
    await hub.quick("claude", "@familiar a");
    const id = hub.view.selected!;
    claude.emit({ type: "turnStarted", threadId: id });
    hub.action({ type: "abandon", id });
    expect(hub.threads.has(id)).toBe(true);
    claude.emit({ type: "done", threadId: id, status: "completed" });
    await hub.quick("codex", "@beta b");
    hub.saveNow();
    hub.action({ type: "abandon", id });
    expect(hub.threads.has(id)).toBe(false);
    hub.saveNow();
    const hub2 = new Hub(() => cfg, { claude: new FakeBackend("claude"), codex: new FakeBackend("codex") }, () => {});
    (hub2 as any).load();
    expect([...hub2.threads.values()].map((t) => t.title)).toEqual(["b"]);
  });

  it.each([
    ["quest", "not-ready"], ["quest", "rejected"],
    ["chat", "not-ready"], ["chat", "rejected"],
  ] as const)("saves a %s first prompt through %s initialization and only retries a fresh message ID", async (kind, failure) => {
    const diagnostic = "synthetic-private-provider-diagnostic";
    const unavailable = { ready: false, error: diagnostic, models: [] };
    const status = vi.spyOn(claude, "status").mockReturnValue(unavailable);
    let finish!: () => void;
    const init = vi.spyOn(claude, "init").mockImplementation(() => new Promise((resolve, reject) => {
      finish = () => failure === "rejected" ? reject(new Error(diagnostic)) : resolve(unavailable);
    }));
    const open = vi.spyOn(claude, "open");
    if (kind === "chat") await hub.key("newChat");
    else {
      await hub.key("newClaude");
      hub.action({ type: "pick", key: hub.projects.list().find(p => p.name === "familiar")!.key });
    }
    hub.handleAddon({ t: "quests", text: "Synthetic quest: [ ] 0/1" });
    const text = "Keep my first message\nincluding this second line";
    const msg = { t: "prompt", id: "first-send", text, ctx: "Synthetic game context" };
    hub.handleAddon(msg);
    const t = hub.selectedThread()!;
    const saved = () => JSON.parse(fs.readFileSync(path.join(appData, "Familiar", "threads.json"), "utf8"));
    // No timer, resolved init, or explicit save is needed to persist accepted words and the ack.
    expect(saved().threads.find((x: any) => x.id === t.id)).toMatchObject({ status: "running", entries: [{ kind: "user", text }] });
    expect(saved().acked).toContain(msg.id);
    expect(hub.view.draft).toBeUndefined();
    hub.handleAddon(msg);
    expect(init).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(claude.sent).toEqual([]);
    finish();
    await tick();
    expect(t.status).toBe("error");
    expect(t.lastError).toMatch(/Claude couldn't start.*message is saved.*Familiars.*Ctrl\+Up/);
    expect(t.entries.at(-1)).toMatchObject({ kind: "notice", level: "error", text: t.lastError });
    expect(hub.toasts.at(-1)?.text).toBe(t.lastError);
    expect(JSON.stringify(saved())).not.toContain(diagnostic);
    expect(open).not.toHaveBeenCalled();
    expect(claude.sent).toEqual([]);
    hub.toasts = [];
    const again = new Hub(() => cfg, { claude, codex }, () => {});
    (again as any).load();
    expect(again.selectedThread()).toMatchObject({ id: t.id, status: "error", lastError: t.lastError, entries: t.entries });
    expect(buildModel(again, { linked: true, fps: 30 }).attention).toMatchObject([{ thread: t.id, label: "Needs attention" }]);
    status.mockRestore(); // The user has fixed provider setup; this alone must not resend anything.
    again.handleAddon(msg);
    await tick();
    expect(open).not.toHaveBeenCalled();
    expect(claude.sent).toEqual([]);
    expect(again.selectedThread()!.entries.filter(e => e.kind === "user")).toHaveLength(1);
    again.handleAddon({ t: "quests", text: "Synthetic quest: [ ] 0/1" });
    const retry = { ...msg, id: "manual-retry" };
    again.handleAddon(retry); // Ctrl+Up + Send produces a fresh ID, unlike an outbox resend.
    again.handleAddon(retry);
    await tick();
    await tick();
    expect(open).toHaveBeenCalledTimes(1);
    expect(claude.sent).toEqual([{ threadId: t.id, text: kind === "chat" ?
      `[Game: ${msg.ctx}]\n[Quest log, current progress:\nSynthetic quest: [ ] 0/1\n]\n\n${text}` : text }]);
    expect(again.selectedThread()).toMatchObject({ status: "running", lastError: undefined });
    expect(again.selectedThread()!.entries.filter(e => e.kind === "user")).toHaveLength(2);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it.each(["quest", "chat"] as const)("a %s preserves distinct prompts during successful slow init without duplicate sends or opens", async kind => {
    const ready = claude.status();
    const status = vi.spyOn(claude, "status").mockReturnValue({ ready: false, models: [] });
    let finish!: (status: BackendStatus) => void;
    const initializing = new Promise<BackendStatus>(resolve => { finish = resolve; });
    vi.spyOn(claude, "init").mockReturnValue(initializing);
    const open = vi.spyOn(claude, "open");
    if (kind === "chat") await hub.key("newChat");
    else {
      await hub.key("newClaude");
      hub.action({ type: "pick", key: hub.projects.list().find(p => p.name === "familiar")!.key });
    }
    const first = { t: "prompt", id: "slow-first", text: "Original first message" };
    const second = { t: "prompt", id: "slow-second", text: "A later message while starting" };
    hub.handleAddon(first);
    hub.handleAddon(first);
    const t = hub.selectedThread()!;
    hub.handleAddon(second);
    hub.handleAddon(second);
    expect(hub.selectedThread()!.id).toBe(t.id);
    expect(t.entries.filter(e => e.kind === "user").map(e => e.text)).toEqual([first.text, second.text]);
    expect(open).not.toHaveBeenCalled();
    expect(claude.sent).toEqual([]);
    status.mockReturnValue(ready);
    finish(ready);
    await tick();
    await tick();
    expect(open).toHaveBeenCalledTimes(1);
    expect(claude.sent).toEqual([
      { threadId: t.id, text: first.text },
      { threadId: t.id, text: second.text },
    ]);
    expect(t.status).toBe("running");
    expect(t.lastError).toBeUndefined();
  });

  it("a failed open leaves the quest in error (not stuck running) and Stop/abandon still work", async () => {
    codex.failOpen = true;
    await expect(hub.quick("codex", "@familiar x")).rejects.toThrow("boom");
    const t = hub.selectedThread()!;
    expect(t.status).toBe("error");
    hub.action({ type: "abandon", id: t.id });
    expect(hub.threads.has(t.id)).toBe(false);
  });

  it("two quick prompts during a slow open share one native thread", async () => {
    await hub.key("newCodex");
    const wow = hub.projects.list().find((p) => p.name === "familiar")!;
    hub.action({ type: "pick", key: wow.key });
    const first = hub.prompt("one");
    const id = hub.view.selected!;
    const second = hub.prompt("two");
    await Promise.all([first, second]);
    expect(codex.open_.size).toBe(1);
    expect(codex.sent.map((s) => s.text)).toEqual(["one", "two"]);
    expect(codex.sent.every((s) => s.threadId === id)).toBe(true);
  });

  it("Stop while the provider is still starting means the prompt is never sent; the next one is", async () => {
    // Codex/ACP startup can take most of a minute; Stop is offered the whole time.
    const ready = claude.status();
    const status = vi.spyOn(claude, "status").mockReturnValue({ ready: false, models: [] });
    let finish!: (s: BackendStatus) => void;
    vi.spyOn(claude, "init").mockReturnValue(new Promise<BackendStatus>((resolve) => { finish = resolve; }));
    await hub.key("newClaude");
    hub.action({ type: "pick", key: hub.projects.list().find((p) => p.name === "familiar")!.key });
    hub.handleAddon({ t: "prompt", id: "stop-init", text: "delete the build folder" });
    const t = hub.selectedThread()!;
    expect(buildModel(hub, { linked: true, fps: 30 }).keys.stop).toBe(true);
    await hub.key("stop");
    status.mockReturnValue(ready);
    finish(ready);
    await tick(); await tick(); await tick();
    expect(claude.sent).toEqual([]);
    expect(t.status).toBe("idle");
    expect(t.entries.at(-1)).toMatchObject({ kind: "notice", text: expect.stringMatching(/^Stopped before your message was sent/) });

    // Same while the session is still opening.
    hub.handleAddon({ t: "prompt", id: "stop-open", text: "now delete the cache" });
    await hub.key("stop");
    await tick(); await tick(); await tick();
    expect(claude.isOpen(t.id)).toBe(true);
    expect(claude.sent).toEqual([]);
    expect(t.status).toBe("idle");

    hub.handleAddon({ t: "prompt", id: "after-stop", text: "just list the folder" });
    await tick(); await tick();
    expect(claude.sent).toEqual([{ threadId: t.id, text: "just list the folder" }]);
    expect(t.status).toBe("running");
  });

  it("approve keys: selected quest first, ambiguous across quests, debounced", async () => {
    await hub.quick("claude", "@familiar a");
    const a = hub.view.selected!;
    await hub.quick("codex", "@beta b");
    const b = hub.view.selected!;
    claude.emit({ type: "approval", threadId: a, requestId: "claude:1", kind: "tool", title: "?", detail: "", canAlways: false });
    codex.emit({ type: "approval", threadId: b, requestId: "codex:s:1", kind: "command", title: "?", detail: "", canAlways: true });
    hub.view.selected = undefined;
    await hub.key("approve", undefined, "legacy", OK);
    expect(claude.decisions.length + codex.decisions.length).toBe(0); // ambiguous
    hub.select(b);
    await hub.key("approve", undefined, "legacy", OK);
    expect(codex.decisions).toEqual([{ requestId: "codex:s:1", d: "allow" }]);
    await hub.key("approve", undefined, "legacy", OK); // double press: debounced, does not approve Claude's request
    expect(claude.decisions).toEqual([]);
  });

  it("a reused request id resolves the new pending card, not the old one", async () => {
    await hub.quick("codex", "@familiar c");
    const id = hub.view.selected!;
    codex.emit({ type: "approval", threadId: id, requestId: "codex:x:1", kind: "command", title: "?", detail: "", canAlways: true });
    hub.decide(id, "codex:x:1", "deny");
    codex.emit({ type: "approval", threadId: id, requestId: "codex:x:1", kind: "command", title: "?", detail: "", canAlways: true });
    expect(hub.threads.get(id)!.status).toBe("approval");
    hub.decide(id, "codex:x:1", "allow");
    expect(hub.threads.get(id)!.entries.filter((e) => e.kind === "approval").map((e) => e.approval)).toEqual(["denied", "approved"]);
  });

  it("tool calls collapse into one expandable line (compact), or show all / none", async () => {
    await hub.quick("claude", "@familiar t");
    const id = hub.view.selected!;
    for (const [n, i] of [["Bash", 1], ["Read", 2], ["Bash", 3]] as const)
      claude.emit({ type: "tool", threadId: id, toolId: `x${i}`, phase: "started", name: n, summary: "s" });
    claude.emit({ type: "message", threadId: id, itemId: "m", text: "done" });
    const tools = () => (buildModel(hub, { linked: true, fps: 30 }).detail as any).entries.filter((e: any) => e.kind === "tool");
    expect(tools().map((e: any) => [e.name, e.text])).toEqual([["+ 3 steps", "Bash x2, Read - now: Bash: s"]]);
    hub.action({ type: "tool", id: tools()[0].id });
    expect(tools().length).toBe(4);
    cfg.toolDetail = "hidden";
    claude.emit({ type: "done", threadId: id, status: "completed" });
    expect(tools().length).toBe(0);
    cfg.toolDetail = "full";
    expect(tools().length).toBe(3);
    cfg.toolDetail = "compact";
  });

  it("desktop-thread confirmation: new quest instead, or cancel", async () => {
    const extId = [...hub.external.keys()].find((k) => k.startsWith("ext:claude:"))!;
    hub.action({ type: "select", id: extId });
    await hub.prompt("start fresh");
    hub.action({ type: "adoptNew" }, OK);
    await tick();
    await tick();
    const t = hub.selectedThread()!;
    expect(t.origin).toBe("familiar");
    expect(path.basename(t.cwd)).toBe("beta");
    expect(claude.open_.get(t.id)?.resumeNativeId).toBeUndefined();
    hub.action({ type: "select", id: extId });
    await hub.prompt("never mind");
    hub.action({ type: "adoptCancel" });
    expect(hub.view.confirm).toBeUndefined();
    expect(claude.sent.map((x) => x.text)).toEqual(["start fresh"]);
  });

  it("welcome prepares the configured Chat draft without sending or changing defaults, including repeat and Back", async () => {
    const localCfg = { ...cfg, chatAgent: "codex", chatModel: "m2" };
    hub = new Hub(() => localCfg, { claude, codex }, () => {});
    hub.addon.char = "Previous character";
    const before = JSON.stringify(localCfg);
    const init = [vi.spyOn(claude, "init"), vi.spyOn(codex, "init")];
    const unlinked = buildModel(hub, { linked: false, fps: 0 });
    expect(unlinked.detail).toMatchObject({ kind: "welcome", linked: false, linkedChar: undefined });
    expect(unlinked.status.level).toBe("off");
    const welcome = buildModel(hub, { linked: true, fps: 30 }).detail;
    if (welcome.kind !== "welcome") throw new Error("Expected welcome");
    expect(welcome).toMatchObject({ linked: true, linkedChar: "Previous character", chat: {
      id: "codex", label: "Codex", model: "m2", enabled: true, ready: true, act: { type: "newIn", key: "chats" },
    } });
    expect(unlinked.target.text).toContain("Chat");
    hub.action(welcome.chat.act);
    hub.action(welcome.chat.act);
    expect(buildModel(hub, { linked: true, fps: 30 }).detail).toMatchObject({ kind: "draft", chat: true,
      agent: "codex", model: "m2", provider: { id: "codex", ready: true } });
    await hub.key("model");
    const picker = buildModel(hub, { linked: true, fps: 30 }).detail;
    if (picker.kind !== "models") throw new Error("Expected model choices");
    expect(picker.groups.map((g) => [g.agent, g.models.map((m) => m.id)])).toEqual([
      ["claude", ["m1", "m2"]], ["codex", ["m1", "m2"]],
    ]);
    expect(picker.groups[1].models.find((m) => m.id === "m2")?.current).toBe(true);
    await hub.key("back"); // Close Model, then leave the draft.
    await hub.key("back");
    expect(buildModel(hub, { linked: true, fps: 30 }).detail.kind).toBe("welcome");
    expect(hub.threads.size).toBe(0);
    expect(claude.open_.size + codex.open_.size).toBe(0);
    expect([...claude.sent, ...codex.sent]).toEqual([]);
    expect(init.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(JSON.stringify(localCfg)).toBe(before);
  });

  it("welcome and status keep configured providers visible and distinguish disabled, unavailable and ready", () => {
    const hermes = new FakeBackend("hermes");
    const localCfg = { ...cfg, chatAgent: "claude", providers: {
      claude: { enabled: false }, codex: { enabled: true }, hermes: { enabled: true }, missing: { enabled: true },
    } };
    vi.spyOn(codex, "status").mockReturnValue({ ready: false, models: [], error: "Sign in required" });
    hub = new Hub(() => localCfg, { claude, codex, hermes }, () => {});
    let m = buildModel(hub, { linked: true, fps: 30 });
    if (m.detail.kind !== "welcome") throw new Error("Expected welcome");
    expect(m.detail.backends).toMatchObject([
      { id: "claude", enabled: false, ready: false, status: "switched off" },
      { id: "codex", enabled: true, ready: false, status: "not ready: Sign in required" },
      { id: "hermes", enabled: true, ready: true, status: "ready (test)" },
      { id: "missing", enabled: true, ready: false, status: "not available in Familiar" },
    ]);
    expect(m.detail.chat).toMatchObject({ id: "claude", enabled: false, ready: false, status: "switched off" });
    expect(m.status).toEqual({ text: "Linked  ·  Claude off  ·  Codex ✗  ·  Hermes ✓  ·  Missing ✗", level: "ok" });
    hub.action(m.detail.chat.act);
    expect(buildModel(hub, { linked: true, fps: 30 }).detail).toMatchObject({ kind: "draft", provider: { ready: false, status: "switched off" } });
    localCfg.providers.hermes.enabled = false;
    m = buildModel(hub, { linked: true, fps: 30 });
    expect(m.status.level).toBe("warn");
    expect(m.status.text).toContain("Hermes off");
    expect([...claude.sent, ...codex.sent, ...hermes.sent]).toEqual([]);
  });

  it("target line says where the next message goes", async () => {
    const m0 = buildModel(hub, { linked: true, fps: 30 });
    expect(m0.target.warn).toBe(true);
    await hub.quick("codex", "@familiar tgt");
    expect(buildModel(hub, { linked: true, fps: 30 }).target.text).toBe("Codex - tgt - familiar - Ask first");
  });

  it("backends can report a mode change", async () => {
    await hub.quick("claude", "@familiar p");
    const id = hub.view.selected!;
    claude.emit({ type: "mode", threadId: id, mode: "edits" });
    expect(hub.threads.get(id)!.mode).toBe("edits");
  });

  it("view model: quest log groups by zone, tracker shows active work", async () => {
    await hub.quick("claude", "@familiar one");
    const id = hub.view.selected!;
    claude.emit({ type: "turnStarted", threadId: id });
    claude.emit({ type: "todo", threadId: id, items: [{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }] });
    const m = buildModel(hub, { linked: true, fps: 30 });
    // The Chats zone is always first (with a hint while empty), then zones by activity.
    expect(m.list.rows[0]).toMatchObject({ kind: "zone", text: "Chats" });
    expect(m.list.rows[1]).toMatchObject({ kind: "hint", act: { type: "newIn", key: "chats" } });
    expect(m.list.rows[2]).toMatchObject({ kind: "zone", text: "familiar" });
    expect(m.list.rows[3]).toMatchObject({ kind: "thread", text: "one", selected: true });
    expect(m.tracker[0]).toMatchObject({ title: "one", activity: "Fix", progress: "1/2" });
    expect(m.detail.kind).toBe("thread");
  });

  it("the tracker shows each quest's own reported spend: dollars, else tokens, else nothing", async () => {
    await hub.quick("claude", "@familiar priced");
    const priced = hub.view.selected!;
    await hub.quick("codex", "@beta counted");
    const counted = hub.view.selected!;
    const model = () => buildModel(hub, { linked: true, fps: 30 });
    const line = (id: string) => model().tracker.find((l) => l.id === id)!;
    expect(line(priced).cost).toBeUndefined();
    claude.emit({ type: "usage", threadId: priced, costUsd: 0.1234 });
    codex.emit({ type: "usage", threadId: counted, inputTokens: 4000, outputTokens: 2000 });
    expect(line(priced).cost).toBe("$0.12");
    expect(line(counted).cost).toBe("6.0k tokens");
    claude.emit({ type: "usage", threadId: priced, costUsd: 0.004 });
    expect(line(priced).cost).toBe("<$0.01");
    const detail = model().detail;
    expect(detail.kind === "thread" && detail.usage).toBe("4.0k in · 2.0k out");
  });

  it("the Mode button's label follows what the Mode key acts on", async () => {
    const keys = () => buildModel(hub, { linked: true, fps: 30 }).keys;
    expect(keys().mode).toBeUndefined(); // welcome: the native "Mode" shows
    await hub.quick("claude", "@familiar labelled");
    const t = hub.selectedThread()!;
    expect(keys()).toMatchObject({ mode: "Ask first", modeHot: false });
    await hub.key("mode", undefined, "full", OK);
    expect(keys()).toMatchObject({ mode: "Plan only", modeHot: false });
    t.mode = "auto"; // chosen in the control panel
    expect(keys()).toMatchObject({ mode: "Auto", modeHot: true });
    await hub.key("newChat");
    expect(keys()).toMatchObject({ mode: "Chat", modeHot: false });
    hub.action({ type: "select", id: "ext:claude:ext-1" });
    expect(keys().mode).toBeUndefined(); // a desktop thread: Mode has nothing to act on
  });

  describe("which desktop threads are listed", () => {
    const betaDir = path.join(projRoot, "beta");
    const day = 86400_000;
    const ids = () => [...hub.external.keys()].filter((k) => k.startsWith("ext:claude:")).map((k) => k.slice("ext:claude:".length)).sort();

    beforeEach(async () => {
      claude.extra = [
        { nativeId: "archived", cwd: betaDir, title: "a", updatedAt: Date.now() - day, archived: true },
        { nativeId: "scheduled", cwd: betaDir, title: "s", updatedAt: Date.now() - day, automated: true },
        { nativeId: "old", cwd: betaDir, title: "o", updatedAt: Date.now() - 60 * day },
        { nativeId: "old-starred", cwd: betaDir, title: "os", updatedAt: Date.now() - 60 * day, starred: true },
        { nativeId: "old-running", cwd: betaDir, title: "or", updatedAt: Date.now() - 60 * day, running: true, archived: true },
        { nativeId: "fresh", cwd: betaDir, title: "f", updatedAt: Date.now() - day },
      ];
      await hub.refreshExternal();
    });

    it("follows desktop archive state, drops automated and old threads, keeps starred and running ones", async () => {
      expect(ids()).toEqual(["ext-1", "fresh", "old-running", "old-starred"]);
      expect(hub.external.get("ext:claude:old-starred")!.reason).toBe("pinned");
      expect(hub.external.get("ext:claude:old-running")!.reason).toBe("running");
      const old = cfg.followDesktopArchive;
      cfg.followDesktopArchive = false;
      await hub.refreshExternal();
      expect(ids()).toContain("archived");
      cfg.followDesktopArchive = old;
    });

    it("pin keeps an old thread listed; hide removes one until /fam unhide; both persist", async () => {
      claude.extra.push({ nativeId: "old2", cwd: betaDir, title: "o2", updatedAt: Date.now() - 90 * day });
      hub.pinned.add("claude:old2");
      await hub.refreshExternal();
      expect(ids()).toContain("old2");
      hub.select("ext:claude:fresh");
      await hub.key("hide");
      expect(ids()).not.toContain("fresh");
      expect(hub.view.selected).toBeUndefined();
      hub.saveNow();
      const again = new Hub(() => cfg, { claude, codex }, () => {});
      (again as any).load();
      expect([...again.hidden]).toEqual(["claude:fresh"]);
      expect([...again.pinned]).toEqual(["claude:old2"]);
      await hub.key("unhide");
      await tick();
      expect(ids()).toContain("fresh");
    });

    it("quest log: running first, pinned marked, +N more past the per-zone cap, agent filter", async () => {
      const rowsOf = () => buildModel(hub, { linked: true, fps: 30 }).list.rows;
      const betaRows = () => {
        const rows = rowsOf();
        const i = rows.findIndex((r) => r.kind === "zone" && r.text === "beta");
        const j = rows.findIndex((r, k) => k > i && r.kind === "zone");
        return rows.slice(i + 1, j < 0 ? undefined : j);
      };
      // beta has 4 claude + 1 codex desktop threads.
      expect(betaRows()[0]).toMatchObject({ kind: "ext", key: "ext:claude:old-running", status: "running" });
      expect(betaRows().find((r) => r.key === "ext:claude:old-starred")!.sub).toMatch(/^★/);
      const old = cfg.externalPerZone;
      cfg.externalPerZone = 2;
      expect(betaRows().filter((r) => r.kind === "ext")).toHaveLength(2);
      const more = betaRows().find((r) => r.kind === "hint")!;
      expect(more).toMatchObject({ text: "+3 more", act: { type: "zoneMore" } });
      hub.action(more.act as any);
      expect(betaRows().filter((r) => r.kind === "ext")).toHaveLength(5);
      cfg.externalPerZone = old;
      await hub.key("show", "codex");
      expect(rowsOf().filter((r) => r.kind === "ext").every((r) => r.agent === "codex")).toBe(true);
      expect(buildModel(hub, { linked: true, fps: 30 }).list.title).toBe("Quest Log · Codex");
      await hub.key("show", "all");
      expect(hub.view.show).toEqual([]);
    });
  });
});

describe("zones for worktrees", () => {
  it("Claude worktrees roll up to the repo; Codex worktrees fold into the project of the same name", () => {
    expect(projectRootOf(String.raw`D:\src\gamma\.claude\worktrees\merge-probe`)).toBe(String.raw`D:\src\gamma`);
    expect(projectRootOf(String.raw`\\?\D:\src\familiar`)).toBe(String.raw`D:\src\familiar`);
    // Not the user's home folder (the old bug made a home-folder zone).
    expect(projectRootOf(String.raw`D:\Users\z\.codex\worktrees\27be\beta\src`)).toBe(String.raw`D:\Users\z\.codex\worktrees\27be\beta`);
    const wt = path.join(tmp, "home", ".codex", "worktrees", "27be", "beta");
    fs.mkdirSync(wt, { recursive: true });
    const h = new Hub(() => cfg, {} as any, () => {});
    h.projects.scanRoots();
    expect(h.projects.add(wt, 5)!.name).toBe("beta");
    expect(h.projects.add(wt, 5)!.path).toBe(path.join(projRoot, "beta"));
    const lone = path.join(tmp, "home", ".codex", "worktrees", "9f00", "Elsewhere");
    fs.mkdirSync(lone, { recursive: true });
    expect(h.projects.add(lone)!.name).toBe("Elsewhere");
    // Codex desktop's project-less chats share one zone.
    const chatA = path.join(tmp, "home", "Documents", "Codex", "2026-10-06", "inspect-this-pc");
    const chatB = path.join(tmp, "home", "Documents", "Codex", "2026-09-21", "find-level-11-zone");
    for (const c of [chatA, chatB]) fs.mkdirSync(c, { recursive: true });
    expect(h.projects.add(chatA)!.name).toBe("Chats");
    expect(h.projects.add(chatB)!.key).toBe(h.projects.add(chatA)!.key);
  });
});


describe("always-on companion and offline honesty", () => {
  it("handles each prompt id once, persists the ids, and FamiliarSync can list them", async () => {
    await hub.quick("claude", "@familiar start");
    const id = hub.view.selected!;
    hub.handleAddon({ t: "prompt", id: "abc1", text: "hello" });
    hub.handleAddon({ t: "prompt", id: "abc1", text: "hello" }); // the resend of something that arrived
    await tick();
    await tick();
    expect(claude.sent.filter((s) => s.threadId === id && s.text === "hello")).toHaveLength(1);
    expect(hub.acked).toContain("abc1");
    hub.saveNow();
    const again = new Hub(() => cfg, { claude, codex }, () => {});
    (again as any).load();
    expect(again.acked).toContain("abc1");
  });

  it("pressing Stop shows as an interruption in catch-up, even before the agent confirms it", async () => {
    await hub.quick("claude", "@familiar long job");
    const id = hub.view.selected!;
    claude.emit({ type: "turnStarted", threadId: id });
    claude.emit({ type: "message", threadId: id, itemId: "m1", text: "Working on it" });
    await hub.key("stop");
    expect(hub.selectedThread()!.entries.at(-1)).toMatchObject({ kind: "notice", text: "Stopping…" });
    expect(buildModel(hub, { linked: true, fps: 30 }).attention?.find((i) => i.thread === id)).toMatchObject({ label: "Interrupted" });
  });

  it("streaming text doesn't rewrite threads.json; the finished message, approvals and the turn's end do", async () => {
    await hub.quick("claude", "@familiar stream");
    const id = hub.view.selected!;
    claude.emit({ type: "turnStarted", threadId: id });
    const saves = vi.spyOn(hub as any, "scheduleSave");
    for (let i = 0; i < 50; i++) claude.emit({ type: "delta", threadId: id, itemId: "m1", channel: "text", text: "word " });
    expect(saves).not.toHaveBeenCalled();
    for (const e of [
      { type: "message", threadId: id, itemId: "m1", text: "word ".repeat(50) },
      { type: "approval", threadId: id, requestId: "r1", kind: "command", title: "Run?", detail: "npm test", canAlways: false },
      { type: "done", threadId: id, status: "completed" },
    ] as AgentEvent[]) {
      saves.mockClear();
      claude.emit(e);
      expect(saves, e.type).toHaveBeenCalled();
    }
    saves.mockRestore();
  });

  it("quests idle for more than 90 days are pruned from Familiar's own store on the next start", async () => {
    await hub.quick("claude", "@familiar recent");
    const recent = hub.view.selected!;
    await hub.quick("claude", "@familiar ancient");
    const old = hub.view.selected!;
    hub.threads.get(old)!.updatedAt = Date.now() - 91 * 86_400_000;
    hub.saveNow();
    const again = new Hub(() => cfg, { claude, codex }, () => {});
    (again as any).load();
    expect(again.threads.has(recent)).toBe(true);
    expect(again.threads.has(old)).toBe(false);
  });

  it("a turn that was running when Familiar stopped is marked interrupted on the next start", async () => {
    await hub.quick("claude", "@familiar long job");
    const id = hub.view.selected!;
    claude.emit({ type: "turnStarted", threadId: id });
    claude.emit({ type: "tool", threadId: id, toolId: "verified", phase: "completed", name: "Read", summary: "Read fixture", ok: true });
    claude.emit({ type: "tool", threadId: id, toolId: "unfinished", phase: "started", name: "Bash", summary: "Synthetic long-running check" });
    hub.saveNow(); // saved mid-turn, then "crash"
    const again = new Hub(() => cfg, { claude, codex }, () => {});
    (again as any).load();
    const t = again.threads.get(id)!;
    expect(t.status).toBe("idle");
    expect(t.entries.at(-1)).toMatchObject({ kind: "notice", level: "error" });
    expect(t.entries.at(-1)!.text).toMatch(/^Interrupted/);
    expect(t.entries.find(e => e.id === "t:unfinished")?.status).toBe("unknown");
    expect(t.entries.find(e => e.id === "t:verified")?.status).toBe("ok");
    const detail = buildModel(again, { linked: true, fps: 30 }).detail;
    expect(detail.kind).toBe("thread");
    if (detail.kind === "thread") expect(detail.entries.find(e => e.kind === "tool")).toMatchObject({ status: "unknown", text: expect.stringContaining("outcome unknown") });
    again.saveNow();
    const third = new Hub(() => cfg, { claude, codex }, () => {});
    (third as any).load();
    expect(third.threads.get(id)!.entries.find(e => e.id === "t:unfinished")?.status).toBe("unknown");
  });

  it("a turn-ending event cannot certify a tool whose result was never observed", async () => {
    await hub.quick("claude", "@familiar synthetic job");
    const id = hub.view.selected!;
    claude.emit({ type: "tool", threadId: id, toolId: "pending", phase: "started", name: "Bash", summary: "Synthetic check" });
    claude.emit({ type: "done", threadId: id, status: "completed" });
    expect(hub.threads.get(id)!.entries.find(e => e.id === "t:pending")?.status).toBe("unknown");
  });

  it("preserves damaged store bytes and recovers valid neighbors across actual restarts", async () => {
    await hub.quick("claude", "@familiar first saved quest");
    const firstId = hub.view.selected!;
    claude.emit({ type: "message", threadId: firstId, itemId: "first", text: "First saved response" });
    claude.emit({ type: "done", threadId: firstId, status: "completed" });
    await hub.quick("claude", "@familiar later saved quest");
    const laterId = hub.view.selected!;
    claude.emit({ type: "done", threadId: laterId, status: "completed" });
    hub.saveNow();
    const file = path.join(appData, "Familiar", "threads.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const first = saved.threads.find((t: any) => t.id === firstId), later = saved.threads.find((t: any) => t.id === laterId);
    delete first.attentionSeen; // Supported legacy omission; existing migration still applies.
    first.futureOptionalField = { retained: true };
    const ambiguous = { ...first, id: "duplicate-id" };
    const source = Buffer.from(JSON.stringify({ ...saved, version: undefined, futureRoot: { retained: true },
      threads: [first, { ...first, id: "broken-middle", entries: null }, later, ambiguous, ambiguous] }, null, 2).replace(/\n/g, "\r\n"));
    fs.writeFileSync(file, source);
    const priorBackup = Buffer.from("an earlier private recovery copy");
    fs.writeFileSync(file + ".recovery", priorBackup);
    const load = () => new Hub(() => cfg, { claude, codex }, () => {});
    vi.useFakeTimers();
    try {
      const recovered = load();
      await recovered.start();
      expect([...recovered.threads.keys()]).toEqual([firstId, laterId]);
      expect(recovered.storage).toMatchObject({ level: "warn", text: expect.stringContaining("3 invalid or ambiguous") });
      expect(fs.readFileSync(file + ".recovery")).toEqual(priorBackup);
      expect(fs.readFileSync(file + ".recovery.1")).toEqual(source);
      expect(fs.readFileSync(file)).toEqual(source); // No replacement before the ordinary save.
      await vi.advanceTimersByTimeAsync(2100);
      const replacement = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(replacement.threads.map((t: any) => t.id)).toEqual([firstId, laterId]);
      expect(replacement.futureRoot).toEqual({ retained: true });
      expect(replacement.threads[0].futureOptionalField).toEqual({ retained: true });
      expect(replacement.recovery).toMatchObject({ backup: "threads.json.recovery.1", skipped: 3, recovered: 2 });
      const again = load();
      await again.start();
      await vi.advanceTimersByTimeAsync(2100);
      expect([...again.threads.keys()]).toEqual([firstId, laterId]);
      expect(again.storage?.text).toContain("Original bytes are preserved");
      expect(fs.readFileSync(file + ".recovery.1")).toEqual(source);
      expect(fs.existsSync(file + ".recovery.2")).toBe(false);

      // Invalid UTF-8 is preserved byte-for-byte, including across a restart before replacement.
      const corrupt = Buffer.from([123, 255, 0, 13, 10]);
      fs.writeFileSync(file, corrupt);
      const broken = load(); (broken as any).load();
      const repeated = load(); (repeated as any).load();
      expect(broken.threads.size).toBe(0);
      expect(repeated.storage?.level).toBe("warn");
      expect(fs.readFileSync(file + ".recovery.2")).toEqual(corrupt);
      expect(fs.existsSync(file + ".recovery.3")).toBe(false);
      expect(buildSnapshot(repeated)).toContain("Saved quests need attention");
      expect(buildSnapshot(repeated)).toContain("Original bytes are preserved");
      expect(repeated.saveNow()).toBe(true);
      expect(broken.saveNow()).toBe(false); // Its pre-replacement source changed underneath it.
      expect(broken.storage?.text).toContain("changed elsewhere");

      const nodeFs = createRequire(import.meta.url)("node:fs") as typeof fs;
      const actualWrite = nodeFs.writeFileSync;
      const newer = Buffer.from(JSON.stringify({ ...saved, newerWriter: true }));
      for (const conflict of ["changed", "disappeared"]) {
        fs.writeFileSync(file, corrupt);
        const midWrite = load(); (midWrite as any).load();
        const write = vi.spyOn(nodeFs, "writeFileSync").mockImplementation(((p: any, ...args: any[]) => {
          (actualWrite as any)(p, ...args);
          if (String(p) === file + ".tmp") {
            if (conflict === "changed") actualWrite(file, newer);
            else fs.unlinkSync(file);
          }
        }) as any);
        syncBuiltinESMExports();
        try {
          expect(midWrite.saveNow()).toBe(false);
          expect(midWrite.storage?.text).toContain("changed elsewhere");
          if (conflict === "changed") expect(fs.readFileSync(file)).toEqual(newer);
          else expect(fs.existsSync(file)).toBe(false);
          expect(fs.readFileSync(file + ".recovery.2")).toEqual(corrupt);
        } finally { write.mockRestore(); syncBuiltinESMExports(); }
      }

      const future = Buffer.from(JSON.stringify({ ...saved, version: 2 }));
      fs.writeFileSync(file, future);
      const unsupported = load(); (unsupported as any).load();
      expect(unsupported.saveNow()).toBe(false);
      expect(unsupported.storage?.text).toContain("unsupported format");
      expect(fs.readFileSync(file)).toEqual(future);
      const badMetadata = Buffer.from(JSON.stringify({ ...saved, view: { collapsed: 7 }, pinned: 42, hidden: {}, archivedInSource: false, acked: "not-an-array" }));
      fs.writeFileSync(file, badMetadata);
      const metadata = load(); (metadata as any).load();
      expect([...metadata.threads.keys()]).toEqual([firstId, laterId]);
      expect(metadata.view.collapsed.size).toBe(0);
      expect(metadata.acked).toEqual([]);
      expect(metadata.saveNow()).toBe(true);
      expect(fs.readFileSync(file + ".recovery.3")).toEqual(badMetadata);
      expect(JSON.stringify(buildModel(metadata, { linked: true, fps: 30 }).storage)).not.toContain(file);
      expect(metadata.storage?.text).not.toContain("threads.json.recovery");
      const invalidKnownFields = Buffer.from(JSON.stringify({ ...saved, threads: [
        { ...first, id: "bad-fork", fork: "false" }, first,
        { ...first, id: "bad-always", entries: [{ ...first.entries[0], canAlways: "false" }] }, later,
      ] }));
      fs.writeFileSync(file, invalidKnownFields);
      const knownFields = load(); (knownFields as any).load();
      expect([...knownFields.threads.keys()]).toEqual([firstId, laterId]);
      expect(knownFields.storage?.text).toContain("2 invalid or ambiguous");
      expect(knownFields.saveNow()).toBe(true);
      expect(fs.readFileSync(file + ".recovery.4")).toEqual(invalidKnownFields);
    } finally { vi.useRealTimers(); }
  });

  it("blocks unsafe recovery and unsaved sends without provider work or automatic retries", async () => {
    await hub.quick("claude", "@familiar saved target");
    const id = hub.view.selected!;
    claude.emit({ type: "done", threadId: id, status: "completed" });
    hub.saveNow();
    const file = path.join(appData, "Familiar", "threads.json"), healthy = fs.readFileSync(file);
    const corrupt = Buffer.from("{invalid private original bytes");
    fs.writeFileSync(file, corrupt);
    for (let i = 0; i < 100; i++) fs.writeFileSync(file + ".recovery" + (i ? "." + i : ""), "existing copy " + i);
    const load = () => new Hub(() => cfg, { claude, codex }, () => {});
    const full = load(); (full as any).load();
    expect(full.saveNow()).toBe(false);
    expect(full.storage?.level).toBe("error");
    expect(fs.readFileSync(file)).toEqual(corrupt);
    for (let i = 0; i < 100; i++) fs.unlinkSync(file + ".recovery" + (i ? "." + i : ""));

    // Inject only the specific read boundary; all writes/other reads use the actual temp profile.
    const nodeFs = createRequire(import.meta.url)("node:fs") as typeof fs;
    const actualRead = nodeFs.readFileSync;
    for (const boundary of ["source", "backup"]) {
      const read = vi.spyOn(nodeFs, "readFileSync").mockImplementation(((p: any, ...args: any[]) => {
        if (String(p) === (boundary === "source" ? file : file + ".recovery"))
          throw Object.assign(new Error("PRIVATE-IO-PAYLOAD"), { code: boundary === "source" ? "EACCES" : "EIO" });
        return (actualRead as any)(p, ...args);
      }) as any);
      syncBuiltinESMExports();
      try {
        const failed = load(); (failed as any).load();
        expect(failed.saveNow()).toBe(false);
        expect(failed.storage?.level).toBe("error");
        expect(actualRead(file)).toEqual(corrupt);
        expect(buildSnapshot(failed)).toContain("Saving is paused");
        expect(JSON.stringify(failed.storage)).not.toContain("PRIVATE-");
      } finally { read.mockRestore(); syncBuiltinESMExports(); }
    }

    fs.writeFileSync(file, healthy);
    const provider = new FakeBackend("claude");
    vi.spyOn(provider, "status").mockReturnValue({ ready: false, models: [] });
    const init = vi.spyOn(provider, "init").mockImplementation(async () => {
      expect(fs.readFileSync(file, "utf8")).toContain("EXPLICIT-RETRY"); // Saved before provider work.
      return { ready: true, models: [] };
    });
    const open = vi.spyOn(provider, "open");
    const failed = new Hub(() => cfg, { claude: provider, codex }, () => {});
    (failed as any).load();
    fs.mkdirSync(file + ".tmp");
    try {
      failed.handleAddon({ t: "prompt", id: "handled-unsent", text: "PRIVATE-UNSENT-WORDS" });
      failed.handleAddon({ t: "prompt", id: "handled-unsent", text: "PRIVATE-UNSENT-WORDS" });
      await tick(); await tick();
      expect(init).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(provider.sent).toEqual([]);
      expect(failed.acked).toContain("handled-unsent"); // Handled, not provider acceptance/durability.
      expect(failed.threads.get(id)!.entries.filter(e => e.text === "PRIVATE-UNSENT-WORDS")).toHaveLength(1);
      expect(buildSnapshot(failed)).toContain("Not sent; this message is currently only in memory");
      expect(failed.storage?.level).toBe("error");
      expect(fs.readFileSync(file)).toEqual(healthy);
    } finally { fs.rmdirSync(file + ".tmp"); }
    expect(failed.saveNow()).toBe(true);
    expect(failed.storage).toBeUndefined();
    failed.handleAddon({ t: "prompt", id: "handled-unsent", text: "PRIVATE-UNSENT-WORDS" });
    expect(provider.sent).toEqual([]);
    failed.handleAddon({ t: "prompt", id: "explicit-retry", text: "EXPLICIT-RETRY" });
    await tick(); await tick();
    expect(init).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(provider.sent).toEqual([{ threadId: id, text: "EXPLICIT-RETRY" }]);
  });

  it("quiet play retains replies and current requests until explicit catch-up, across a restart", async () => {
    const sounds: string[] = [], spoken: string[] = [];
    const beforeSpeak = cfg.speak;
    cfg.speak = true;
    hub.onSound = k => sounds.push(k);
    hub.onSpeak = text => spoken.push(text);
    await hub.key("quiet", "on");
    const ids: string[] = [];
    for (const name of ["first", "second", "pending", "expired"]) {
      await hub.quick("claude", `@familiar ${name}`);
      const id = hub.view.selected!;
      ids.push(id);
      if (ids.length <= 2) {
        claude.emit({ type: "message", threadId: id, itemId: name, text: `Saved ${name} reply` });
        claude.emit({ type: "done", threadId: id, status: "completed" });
      } else {
        claude.emit({ type: "approval", threadId: id, requestId: name, kind: "fileChange", title: `${name} request`, detail: "Synthetic only", canAlways: false });
        if (name === "expired") claude.emit({ type: "approvalResolved", threadId: id, requestId: name });
      }
    }
    const model = () => buildModel(hub, { linked: true, fps: 30 });
    expect(model().attention?.map(item => item.label).sort()).toEqual(["Needs approval", "Reply waiting", "Reply waiting", "Request expired"].sort());
    expect(hub.toasts.some(t => t.kind === "done")).toBe(false);
    expect(sounds).toEqual(["approval", "approval"]);
    expect(spoken).toEqual([]);
    hub.toasts = []; // Simulate toast expiry; the saved events remain.
    hub.action({ type: "select", id: ids[0] });
    expect(model().attention).toHaveLength(4);
    const pending = model().attention!.find(item => item.pending)!;
    hub.action({ type: "caughtUp", thread: pending.thread, entry: pending.entry, revision: pending.revision });
    expect(model().attention).toHaveLength(4); // A required request cannot be dismissed as caught up.
    await hub.key("caughtup");
    expect(model().attention).toHaveLength(3);
    hub.saveNow();
    const again = new Hub(() => cfg, { claude, codex }, () => {});
    (again as any).load();
    const restored = buildModel(again, { linked: true, fps: 30 });
    expect(restored.quiet).toBe(true);
    expect(restored.attention).toHaveLength(3);
    expect(restored.attention?.some(item => item.thread === ids[0])).toBe(false);
    expect(restored.attention?.some(item => item.pending)).toBe(false); // Restart expires old requests.
    hub.action({ type: "decide", thread: ids[3], requestId: "expired", decision: "approved" });
    expect(claude.decisions).toEqual([]);
    await hub.key("quiet", "off");
    expect(model().attention).toHaveLength(3);
    expect(hub.toasts.some(t => t.kind === "done")).toBe(false); // No notification burst on return.
    cfg.speak = beforeSpeak;
  });

  it("notices wait for the fight to end", async () => {
    const sounds: string[] = [], spoken: string[] = [];
    const beforeSpeak = cfg.speak;
    cfg.speak = true;
    hub.onSound = (k) => sounds.push(k);
    hub.onSpeak = (text) => spoken.push(text);
    try {
      await hub.quick("claude", "@familiar first");
      const first = hub.view.selected!;
      await hub.quick("codex", "@beta second");
      const second = hub.view.selected!;
      hub.toasts = []; // the Started toasts
      hub.setCombat(true);
      claude.emit({ type: "message", threadId: first, itemId: "m", text: "Done with the first one." });
      claude.emit({ type: "done", threadId: first, status: "completed" });
      codex.emit({ type: "approval", threadId: second, requestId: "r1", kind: "command", title: "Run?", detail: "npm test", canAlways: false });
      expect(hub.toasts).toEqual([]);
      expect(sounds).toEqual([]);
      expect(spoken).toEqual([]);
      // The card, the marker and the Approve glow are the model's, and keep updating.
      const m = buildModel(hub, { linked: true, fps: 30 });
      expect(m.keys.approve).toBe(true);
      expect(m.list.rows.find((r) => r.key === first)).toMatchObject({ unread: true });
      await hub.key("archived"); // a reply to the player's own command still shows
      expect(hub.toasts.map((t) => t.text)).toEqual(["Nothing is archived."]);
      hub.setCombat(false);
      expect(hub.toasts.at(-1)!.text).toBe("While you fought: 1 quest finished · 1 needs approval");
      expect(hub.toasts.some((t) => t.kind === "approval" && t.threadId === second)).toBe(true);
      expect(sounds).toEqual(["approval"]);
      expect(spoken).toEqual(["While you fought: 1 quest finished, 1 needs approval"]);
      // One held notice comes back as it was; one decided during the fight doesn't come back.
      hub.setCombat(true);
      claude.emit({ type: "done", threadId: first, status: "failed", error: "boom" });
      codex.emit({ type: "approval", threadId: second, requestId: "r2", kind: "command", title: "Again?", detail: "npm test", canAlways: false });
      for (const requestId of ["r1", "r2"]) hub.action({ type: "decide", thread: second, requestId, decision: "deny" });
      hub.setCombat(false);
      expect(hub.toasts.at(-1)).toMatchObject({ kind: "error", text: "Quest Failed · first" });
      expect(hub.toasts.filter((t) => t.kind === "approval" && t.threadId === second)).toEqual([]);
      expect(sounds).toEqual(["approval", "error"]);
    } finally {
      cfg.speak = beforeSpeak;
    }
  });

  it("catch-up acknowledgments are bound to final content, including corrections under the same item ID", async () => {
    await hub.quick("claude", "@familiar synthetic revision");
    const id = hub.view.selected!;
    const current = () => buildModel(hub, { linked: true, fps: 30 }).attention![0];
    claude.emit({ type: "message", threadId: id, itemId: "same-final", text: "First final answer" });
    claude.emit({ type: "done", threadId: id, status: "completed" });
    const old = current();
    claude.emit({ type: "message", threadId: id, itemId: "same-final", text: "Corrected final answer with a new instruction" });
    hub.action({ type: "caughtUp", thread: id, entry: old.entry, revision: old.revision });
    expect(current().excerpt).toBe("Corrected final answer with a new instruction");
    const corrected = current();
    hub.action({ type: "caughtUp", thread: id, entry: corrected.entry, revision: corrected.revision });
    expect(buildModel(hub, { linked: true, fps: 30 }).attention).toEqual([]);
    claude.emit({ type: "message", threadId: id, itemId: "same-final", text: "Another correction" });
    expect(current().excerpt).toBe("Another correction");
    hub.saveNow();
    const again = new Hub(() => cfg, { claude, codex }, () => {});
    (again as any).load();
    expect(buildModel(again, { linked: true, fps: 30 }).attention?.[0].excerpt).toBe("Another correction");
  });

  it("diagnoses catch-up attempts and actual storage outcomes locally without logging content", async () => {
    const logs: string[] = [];
    hub.log = line => logs.push(line);
    const trace = () => logs.filter(line => line.startsWith("[catch-up] ")).map(line => JSON.parse(line.slice(11)));
    const last = (event: string) => trace().findLast(r => r.event === event);
    const attention = (id: string) => buildModel(hub, { linked: true, fps: 30 }).attention!.find(a => a.thread === id)!;
    const ack = (a: any) => hub.action({ type: "caughtUp", thread: a.thread, entry: a.entry, revision: a.revision });
    const text = "PRIVATE-TRACE-TEXT " + "a".repeat(180);
    await hub.quick("claude", "@familiar PRIVATE-TRACE-TITLE");
    const id = hub.view.selected!;
    claude.emit({ type: "message", threadId: id, itemId: "PRIVATE-TRACE-ENTRY", text });
    claude.emit({ type: "done", threadId: id, status: "completed" });
    const original = attention(id);
    hub.saveNow();
    ack({ ...original, thread: "PRIVATE-MISSING-THREAD" });
    expect(last("attempt").result).toBe("missing-thread");
    await hub.quick("claude", "@familiar PRIVATE-EMPTY-TITLE");
    const pendingId = hub.view.selected!;
    ack({ thread: pendingId, entry: "PRIVATE-NO-CANDIDATE", revision: "PRIVATE-NO-REVISION" });
    expect(last("attempt").result).toBe("no-candidate");
    claude.emit({ type: "approval", threadId: pendingId, requestId: "PRIVATE-REQUEST", kind: "tool", title: "PRIVATE-APPROVAL-TITLE", detail: "PRIVATE-APPROVAL-BODY", canAlways: false });
    expect(last("transition")).toMatchObject({ sameText: null, sameNormalizedText: null, sameExcerpt: null, changedFields: null });
    ack(attention(pendingId));
    expect(last("attempt").result).toBe("pending");
    expect(attention(pendingId).pending).toBe(true);
    ack({ ...original, entry: "PRIVATE-WRONG-ENTRY" });
    expect(last("attempt").result).toBe("stale-entry");
    claude.emit({ type: "message", threadId: id, itemId: "PRIVATE-TRACE-ENTRY", text: text + " corrected" });
    ack(original);
    expect(last("attempt").result).toBe("stale-revision");
    expect(attention(id).revision).not.toBe(original.revision);
    expect(last("transition")).toMatchObject({ source: "message", change: "candidate", sameText: false, changedFields: ["text"] });
    const corrected = attention(id);
    ack(corrected);
    expect(last("attempt").result).toBe("accepted");
    expect(last("transition")).toMatchObject({ source: "caughtUp", change: "marker", sameText: true });
    expect(attention(id)).toBeUndefined();

    // Fail the real atomic writer in this test's isolated profile. The old store stays intact.
    const file = path.join(appData, "Familiar", "threads.json");
    fs.mkdirSync(file + ".tmp");
    try {
      hub.saveNow();
      expect(last("write")).toMatchObject({ write: "failed", code: "other", receipts: [{ snapshot: "acknowledged" }] });
      expect(JSON.parse(fs.readFileSync(file, "utf8")).threads.find((t: any) => t.id === id).attentionSeen).not.toBe(corrected.revision);
    } finally { fs.rmdirSync(file + ".tmp"); }
    hub.saveNow();
    expect(last("write")).toMatchObject({ write: "ok", receipts: [{ snapshot: "acknowledged" }] });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).threads.find((t: any) => t.id === id).attentionSeen).toBe(corrected.revision);
    const loaded = new Hub(() => cfg, { claude, codex }, line => logs.push(line));
    (loaded as any).load();
    const baseline = trace().findLast(r => r.event === "baseline" && r.source === "load" && r.thread === last("attempt").thread);
    expect(baseline.marker).toBe(baseline.revision);
    expect(buildModel(loaded, { linked: true, fps: 30 }).attention!.some(a => a.thread === id)).toBe(false);

    ack(corrected); // Already seen is still accepted and uses the existing save schedule.
    expect(last("attempt").result).toBe("already-seen");
    const priorAttempt = last("attempt").attempt;
    claude.emit({ type: "message", threadId: id, itemId: "PRIVATE-TRACE-ENTRY", text: text + " corrected\n  " });
    expect(last("transition")).toMatchObject({ change: "candidate", sameText: false, sameNormalizedText: true, sameExcerpt: true, changedFields: ["text"] });
    ack(attention(id));
    expect(last("superseded")).toMatchObject({ attempt: priorAttempt, by: last("attempt").attempt });
    hub.saveNow();
    expect(last("write").receipts).toHaveLength(1);
    expect(last("write").receipts[0].attempt).toBe(last("attempt").attempt);
    // Equal text in a genuinely distinct message is new attention; tracing does not deduplicate it.
    claude.emit({ type: "message", threadId: id, itemId: "PRIVATE-DISTINCT-ENTRY", text: text + " corrected\n  " });
    expect(last("transition")).toMatchObject({ change: "candidate", sameText: true, sameNormalizedText: true, sameExcerpt: true, changedFields: [] });
    expect(attention(id)).toBeDefined();
    ack(attention(id));
    // A later reply then a send implicitly catches up before the original pending write.
    claude.emit({ type: "message", threadId: id, itemId: "PRIVATE-IMPLICIT-ENTRY", text: "PRIVATE-IMPLICIT-REPLY" });
    const implicit = attention(id);
    hub.action({ type: "select", id });
    await hub.prompt("PRIVATE-NEXT-INPUT");
    expect(last("write")).toMatchObject({ write: "ok", receipts: [{ snapshot: "changed" }] });
    expect(last("write").receipts[0].written).not.toBe(last("write").receipts[0].acknowledged);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).threads.find((t: any) => t.id === id).attentionSeen).toBe(implicit.revision);
    claude.emit({ type: "done", threadId: id, status: "completed" });
    claude.emit({ type: "message", threadId: id, itemId: "PRIVATE-OMITTED-ENTRY", text: "PRIVATE-OMITTED-REPLY" });
    ack(attention(id));
    hub.action({ type: "archive", id });
    await tick();
    hub.saveNow();
    expect(last("write")).toMatchObject({ write: "ok", receipts: [{ snapshot: "omitted", written: null }] });

    const count = trace().length;
    for (let i = 0; i < 3; i++) hub.handleAddon({ t: "hello", char: "PRIVATE-CHAR", realm: "PRIVATE-REALM" });
    await hub.key("font", "100");
    expect(trace()).toHaveLength(count); // No unchanged hello/config/status noise.
    for (let i = 0; i < 34; i++) {
      const t = { ...hub.threads.get(pendingId)!, id: `PRIVATE-LIMIT-${i}`, status: "idle" as const,
        entries: [{ id: `PRIVATE-LIMIT-ENTRY-${i}`, kind: "assistant" as const, text, at: Date.now() }], attentionSeen: null };
      hub.threads.set(t.id, t); ack(attention(t.id));
    }
    expect((hub as any).catchUpTrace.size).toBe(32);
    expect((hub as any).catchUpWrites.size).toBe(32);
    expect(trace().filter(r => r.event === "coverage-limit").map(r => r.scope).sort()).toEqual(["monitor", "write"]);
    hub.saveNow();
    expect(last("write").receipts).toHaveLength(32);
    const rawAction = { type: "caughtUp", thread: id, entry: original.entry, revision: original.revision };
    const line = describeOverlayAction(rawAction);
    expect(line).toBe('[overlay] action {"type":"caughtUp"}');
    expect(describeOverlayAction({ type: "quiet", on: true })).toBe('[overlay] action {"type":"quiet","on":true}');
    const diagnosticOnly = JSON.stringify(trace()) + line;
    for (const privateValue of ["PRIVATE-", id, original.entry, original.revision, text, projRoot,
      createHash("sha256").update(text).digest("hex")]) expect(diagnosticOnly).not.toContain(privateValue);
  });

  it("replying to a quest or stopping it counts as caught up; a new reply raises a new note", async () => {
    await hub.quick("claude", "@familiar synthetic ack-on-send");
    const id = hub.view.selected!;
    const attention = () => buildModel(hub, { linked: true, fps: 30 }).attention ?? [];
    claude.emit({ type: "message", threadId: id, itemId: "r1", text: "First reply" });
    claude.emit({ type: "done", threadId: id, status: "completed" });
    expect(attention().filter(a => a.thread === id)).toHaveLength(1);
    await hub.prompt("thanks, next");
    expect(attention().filter(a => a.thread === id)).toHaveLength(0);
    claude.emit({ type: "message", threadId: id, itemId: "r2", text: "Second reply" });
    claude.emit({ type: "done", threadId: id, status: "completed" });
    expect(attention().filter(a => a.thread === id).map(a => a.excerpt)).toEqual(["Second reply"]);
    await hub.prompt("go on");
    claude.emit({ type: "done", threadId: id, status: "interrupted" });
    expect(attention().filter(a => a.thread === id)).toHaveLength(0); // "Stopped." by the player
  });

  it("answering a question doesn't leave it as an expired request", async () => {
    await hub.quick("claude", "@familiar synthetic question");
    const id = hub.view.selected!;
    claude.emit({ type: "approval", threadId: id, requestId: "q1", kind: "question", title: "Which?", detail: "", canAlways: false, options: ["A", "B"] } as any);
    hub.action({ type: "answer", thread: id, requestId: "q1", label: "A" }, OK);
    claude.emit({ type: "approvalResolved", threadId: id, requestId: "q1" });
    const t = hub.threads.get(id)!;
    expect(t.entries.find(e => e.requestId === "q1")?.approval).toBe("approved");
  });

  it("/fam autostart toggles launch-at-login through the config hook", async () => {
    let saved: any;
    hub.onConfigChanged = (c) => (saved = { ...c });
    const before = cfg.launchAtLogin;
    await hub.key("autostart", "on");
    expect(saved.launchAtLogin).toBe(true);
    await hub.key("autostart", "off");
    expect(saved.launchAtLogin).toBe(false);
    await hub.key("autostart", "");
    expect(saved.launchAtLogin).toBe(true);
    cfg.launchAtLogin = before;
  });

  it("/fam font, sound and warnings change the config and reach the overlay model", async () => {
    const { buildModel } = await import("../src/hub/viewmodel");
    const before = { fontScale: cfg.fontScale, sound: cfg.sound, raidWarnings: cfg.raidWarnings };
    hub.onConfigChanged = () => {};
    await hub.key("font", "bigger");
    await hub.key("font", "bigger");
    expect(cfg.fontScale).toBe(1.2);
    await hub.key("font", "500");
    expect(cfg.fontScale).toBe(1.6); // capped
    await hub.key("sound", "off");
    expect(cfg.sound).toBe(false);
    await hub.key("warnings", "");
    expect(cfg.raidWarnings).toBe(false);
    expect(buildModel(hub, { linked: true, fps: 30 })).toMatchObject({ fontScale: 1.6, raidWarnings: false });
    // FamiliarSync carries it too: the addon sizes its quest-list rows by it at the next login / reload.
    expect(buildSnapshot(hub)).toContain("\n  fontScale = 1.6,\n");
    Object.assign(cfg, before);
  });

  it("font size arguments", async () => {
    const { setFontScale } = await import("../src/hub/hub");
    expect(setFontScale(1, "smaller")).toBe(0.9);
    expect(setFontScale(0.8, "-")).toBe(0.8);
    expect(setFontScale(1.3, "reset")).toBe(1);
    expect(setFontScale(1, "130%")).toBe(1.3);
    expect(setFontScale(1, "1.4")).toBe(1.4);
    expect(setFontScale(1, "huge")).toBeUndefined();
    expect(setFontScale(1, "")).toBeUndefined();
  });

  it("start() leaves agent backends asleep until wake()", async () => {
    let inits = 0;
    const lazy = new FakeBackend("claude");
    lazy.init = async () => (inits++, lazy.status());
    const h = new Hub(() => cfg, { claude: lazy, codex } as any, () => {});
    await h.start();
    expect(inits).toBe(0);
    await Promise.all([h.wake(), h.wake()]);
    expect(inits).toBe(1);
    expect(h.external.size).toBeGreaterThan(0);
  });
});

describe("chat (no repo, web search only)", () => {
  const ctx = "level 20 Night Elf Rogue (Alliance) in Darkshore - Auberdine";

  it("+ Chat drafts a chat on the configured agent; the first message starts it with chat options and game context", async () => {
    await hub.key("newChat");
    expect(hub.view.draft).toMatchObject({ agent: "claude", model: "haiku", chat: true, projectKey: "chats" });
    expect(buildModel(hub, { linked: true, fps: 30 }).target.text).toBe("New chat with Claude (haiku)");
    hub.handleAddon({ t: "prompt", id: "c1", text: "where is the rogue poison quest?", ctx });
    await tick();
    await tick();
    const t = hub.selectedThread()!;
    expect(t).toMatchObject({ kind: "chat", agent: "claude", projectKey: "chats", model: "haiku" });
    const opened = claude.open_.get(t.id)!;
    expect(opened.chat?.effort).toBe("medium");
    expect(opened.chat?.instructions).toMatch(/World of Warcraft: Forever/);
    expect(path.basename(opened.cwd)).toBe("chat");
    // The model gets the context line; the transcript shows what the player typed.
    expect(claude.sent.at(-1)!.text).toBe(`[Game: ${ctx}]\n\nwhere is the rogue poison quest?`);
    expect(t.entries.find((e) => e.kind === "user")!.text).toBe("where is the rogue poison quest?");
    // Chats have no permission modes.
    await hub.key("mode");
    expect(t.mode).toBe("ask");
    expect(hub.toasts.at(-1)!.text).toMatch(/no permission modes/);
  });

  it("/fam ask continues the latest chat; /fam ask new starts another; coding quests ignore context", async () => {
    await hub.ask("first", ctx);
    const a = hub.view.selected!;
    await hub.ask("second", ctx);
    expect(hub.view.selected).toBe(a);
    await hub.ask("third", ctx, true);
    expect(hub.view.selected).not.toBe(a);
    expect([...hub.threads.values()].filter((t) => t.kind === "chat")).toHaveLength(2);
    await hub.quick("claude", "@familiar fix it");
    hub.handleAddon({ t: "prompt", text: "and the tests", ctx });
    await tick();
    expect(claude.sent.at(-1)!.text).toBe("and the tests");
    const rows = buildModel(hub, { linked: true, fps: 30 }).list.rows;
    const chats = rows.slice(1, rows.findIndex((r, i) => i > 0 && r.kind === "zone"));
    expect(chats.map((r) => r.kind)).toEqual(["thread", "thread"]);
    expect(hub.projects.list().some((p) => p.key === "chats")).toBe(false); // not offered as a project
  });
});

describe("more providers (ACP agents)", () => {
  it("Hermes threads without a folder land in Chats; the new-quest picker lists every provider", async () => {
    const hermes = new FakeBackend("hermes");
    hermes.extra = [{ nativeId: "tg1", cwd: "", title: "poison quest?", updatedAt: Date.now() - 3600_000, origin: "telegram" }];
    const h = new Hub(() => cfg, { claude, codex, hermes } as any, () => {});
    h.projects.scanRoots();
    await h.refreshExternal();
    const x = h.external.get("ext:hermes:tg1")!;
    expect(x.projectKey).toBe("chats");
    h.select("ext:hermes:tg1");
    const d = buildModel(h, { linked: true, fps: 30 });
    expect(d.detail).toMatchObject({ kind: "thread", agent: "hermes", source: "from Telegram · recent" });
    expect(d.providers.hermes).toMatchObject({ label: "Hermes", glyph: "☿" });
    // Continuing it adopts into a quest in the chat folder (Hermes then starts from a digest).
    await h.prompt("and for horde?");
    h.action({ type: "adoptConfirm" }, OK);
    await tick();
    await tick();
    const t = h.selectedThread()!;
    expect(t).toMatchObject({ agent: "hermes", nativeId: "tg1" });
    expect(path.basename(t.cwd)).toBe("chat");
    await h.key("newClaude");
    const rows = buildModel(h, { linked: true, fps: 30 }).list.rows;
    expect(rows.filter((r) => r.kind === "agent").map((r) => r.text)).toEqual(["Claude", "Codex", "Hermes"]);
    h.action(rows.find((r) => r.text === "Hermes")!.act as any);
    expect(h.view.pickAgent).toBe("hermes");
  });
});

describe("usage limits", () => {
  it("a used-up plan is a notice, not a failure", async () => {
    await hub.quick("claude", "@familiar hi");
    const id = hub.view.selected!;
    claude.emit({ type: "turnStarted", threadId: id });
    claude.emit({ type: "done", threadId: id, status: "failed", error: "API error (status 402 Payment Required): Grok Build usage balance exhausted" });
    const t = hub.threads.get(id)!;
    expect(t.status).toBe("idle");
    expect(t.entries.at(-1)).toMatchObject({ kind: "notice" });
    expect(t.entries.at(-1)!.level).not.toBe("error");
    expect(hub.toasts.at(-1)).toMatchObject({ kind: "info" });
    claude.emit({ type: "done", threadId: id, status: "failed", error: "spawn ENOENT" });
    expect(t.status).toBe("error");
  });
});

describe("model list (Model button)", () => {
  it("quests: lists that agent's models; a click sets the quest's model", async () => {
    await hub.quick("codex", "@familiar refactor");
    await hub.key("model");
    const d: any = buildModel(hub, { linked: true, fps: 30 }).detail;
    expect(d.kind).toBe("models");
    expect(d.groups.map((g: any) => g.agent)).toEqual(["codex"]);
    expect(d.effort).toBeUndefined();
    hub.action({ type: "pickModel", agent: "codex", model: "m2" });
    expect(hub.selectedThread()!.model).toBe("m2");
    expect(hub.view.picker).toBe(false);
  });

  it("chats: every chat agent's models plus effort; picks become the chat default; another agent means a new chat", async () => {
    const saved: any[] = [];
    hub.onConfigChanged = (c) => saved.push({ agent: c.chatAgent, model: c.chatModel, effort: c.chatEffort });
    const before = { a: cfg.chatAgent, m: cfg.chatModel, e: cfg.chatEffort };
    await hub.ask("hello");
    const chatId = hub.view.selected!;
    await hub.key("model");
    const d: any = buildModel(hub, { linked: true, fps: 30 }).detail;
    expect(d.groups.map((g: any) => g.agent)).toEqual(["claude", "codex"]);
    expect(d.groups[1].models.every((m: any) => m.newChat)).toBe(true);
    expect(d.effort).toMatchObject({ current: "medium", options: ["low", "medium", "high"] });
    hub.action({ type: "pickEffort", effort: "low" });
    expect(saved.at(-1)).toMatchObject({ effort: "low" });
    hub.action({ type: "pickModel", agent: "codex", model: "m1" });
    expect(saved.at(-1)).toMatchObject({ agent: "codex", model: "m1" });
    expect(hub.view.draft).toMatchObject({ chat: true, agent: "codex", model: "m1" }); // new chat, old one untouched
    expect(hub.threads.get(chatId)!.agent).toBe("claude");
    Object.assign(cfg, { chatAgent: before.a, chatModel: before.m, chatEffort: before.e });
  });
});

describe("archive", () => {
  it("archives quests and desktop threads, in the agent's app where it can, and restores them", async () => {
    codex.canArchive = true; // Codex can archive for other apps; the fake Claude can't
    await hub.quick("codex", "@familiar throwaway");
    const q = hub.view.selected!;
    hub.threads.get(q)!.nativeId = "cx-1";
    codex.emit({ type: "done", threadId: q, status: "completed" });
    hub.action({ type: "archive", id: q });
    await tick();
    expect(hub.threads.has(q)).toBe(false);
    expect(codex.archived).toEqual([["cx-1", true]]);
    expect(hub.toasts.at(-1)!.text).toMatch(/in Codex too/);
    hub.action({ type: "archive", id: "ext:claude:ext-1" });
    await tick();
    expect(hub.external.has("ext:claude:ext-1")).toBe(false);
    expect(hub.toasts.at(-1)!.text).toMatch(/in Familiar only/);
    await hub.refreshExternal();
    expect(hub.external.has("ext:claude:ext-1")).toBe(false); // stays archived
    await hub.key("unarchive");
    expect(codex.archived.at(-1)).toEqual(["cx-1", false]); // restored in Codex too
    expect(claude.archived.filter(([, on]) => !on)).toEqual([]); // nothing to restore there
    expect(hub.external.has("ext:claude:ext-1")).toBe(true);
    codex.canArchive = false;
  });

  it("won't archive a quest that is working", async () => {
    await hub.quick("claude", "@familiar busy");
    const q = hub.view.selected!;
    claude.emit({ type: "turnStarted", threadId: q });
    hub.action({ type: "archive", id: q });
    await tick();
    expect(hub.threads.has(q)).toBe(true);
    expect(hub.toasts.at(-1)!.text).toMatch(/Stop the quest/);
  });
});

describe("quest log in chats", () => {
  it("chats see the quest log when it changed since they last saw it; quests (coding) never do", async () => {
    hub.handleAddon({ t: "quests", text: "Klaven's Tower [lvl 20, id 2359]: [ ] Defias Tower Key: 0/1" });
    await hub.ask("how do I finish my quest?", "level 20 Night Elf Rogue (Alliance) in Westfall");
    expect(claude.sent.at(-1)!.text).toBe(
      "[Game: level 20 Night Elf Rogue (Alliance) in Westfall]\n[Quest log, current progress:\nKlaven's Tower [lvl 20, id 2359]: [ ] Defias Tower Key: 0/1\n]\n\nhow do I finish my quest?",
    );
    await hub.ask("and after that?");
    expect(claude.sent.at(-1)!.text).toBe("and after that?"); // unchanged log: not repeated
    hub.handleAddon({ t: "quests", text: "Klaven's Tower [lvl 20, id 2359]: [x] Defias Tower Key: 1/1" });
    await hub.ask("now?");
    expect(claude.sent.at(-1)!.text).toContain("[x] Defias Tower Key: 1/1");
    hub.handleAddon({ t: "quests" }); // unavailable / context off: do not invent an empty log
    await hub.ask("while context is off?");
    expect(claude.sent.at(-1)!.text).toBe("while context is off?");
    hub.handleAddon({ t: "quests", text: "" });
    const chat = hub.threads.get(hub.view.selected!)!;
    const previous = chat.questsSent;
    const send = vi.spyOn(claude, "send").mockRejectedValueOnce(new Error("send failed"));
    await expect(hub.ask("all done?")).rejects.toThrow("send failed");
    expect(send.mock.calls.at(-1)![1]).toContain("(no quests)");
    expect(chat.questsSent).toBe(previous); // rejected send must not consume the snapshot
    await hub.ask("try again");
    expect(claude.sent.at(-1)!.text).toBe("[Quest log, current progress:\n(no quests)\n]\n\ntry again");
    expect(chat.questsSent).toBe("");
    await hub.ask("and now?");
    expect(claude.sent.at(-1)!.text).toBe("and now?"); // successful empty log is not repeated
    await hub.ask("fresh chat", undefined, true);
    expect(claude.sent.at(-1)!.text).toContain("(no quests)"); // tracked separately per chat
    hub.handleAddon({ t: "quests", text: "A new quest: [ ] 0/1" });
    await hub.ask("next quest?");
    expect(claude.sent.at(-1)!.text).toContain("A new quest: [ ] 0/1");
    // Overlapping submissions must not suppress a return to the last accepted snapshot.
    const a = "A new quest: [ ] 0/1";
    const b = "Another quest: [ ] 0/1";
    let release!: () => void;
    send.mockImplementationOnce(async (threadId, text) => {
      claude.sent.push({ threadId, text });
      await new Promise<void>(resolve => { release = resolve; });
    });
    hub.handleAddon({ t: "quests", text: b });
    const pending = hub.ask("about B");
    await tick();
    expect(claude.sent.at(-1)!.text).toContain(b);
    hub.handleAddon({ t: "quests", text: a });
    const returning = hub.ask("back to A");
    await tick();
    expect(claude.sent.at(-1)!.text).toContain("about B"); // second submission waits
    release();
    await Promise.all([pending, returning]);
    expect(claude.sent.at(-1)!.text).toContain(a);
    expect(hub.threads.get(hub.view.selected!)!.questsSent).toBe(a);

    // A rejected submission releases the queue without consuming its snapshot.
    let reject!: (error: Error) => void;
    send.mockImplementationOnce(async () => {
      await new Promise<void>((_resolve, fail) => { reject = fail; });
    });
    hub.handleAddon({ t: "quests", text: b });
    const failed = expect(hub.ask("first attempt")).rejects.toThrow("queued send failed");
    await tick();
    const retry = hub.ask("queued retry");
    reject(new Error("queued send failed"));
    await Promise.all([failed, retry]);
    expect(claude.sent.at(-1)!.text).toContain(b);
    expect(claude.sent.at(-1)!.text).toContain("queued retry");
    await hub.quick("claude", "@familiar fix the build");
    expect(claude.sent.at(-1)!.text).toBe("fix the build");
  });
});

describe("config.json", () => {
  it("a typo in a hand edit sets the file aside and says so, instead of silently resetting every setting", () => {
    const dir = path.join(appData, "Familiar");
    const file = path.join(dir, "config.json");
    const typo = '{ "sound": false, "providers": { "gemini": { "command": "gemini", "args": ["--experimental-acp"] } }, }';
    fs.writeFileSync(file, typo, "utf8");
    const logged: string[] = [];
    const c = loadConfig((line) => logged.push(line));
    expect(c.sound).toBe(DEFAULT_CONFIG.sound);
    const aside = fs.readdirSync(dir).filter((f) => f.startsWith("config.json.bad-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), "utf8")).toBe(typo);
    expect(logged.join("\n")).toContain(aside[0]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).sound).toBe(DEFAULT_CONFIG.sound);

    saveConfig({ ...c, sound: false });
    expect(loadConfig(() => {}).sound).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("config.json")).sort()).toEqual(["config.json", aside[0]]);
  });
});

describe("Codex-only players", () => {
  it("configured claude that isn't installed falls back to the installed, signed-in codex for + Chat, /fam ask and quick; logged once", async () => {
    const lines: string[] = [];
    const cl = new FakeBackend("claude");
    const cx = new FakeBackend("codex");
    const h = new Hub(() => cfg, { claude: cl, codex: cx }, (s) => lines.push(s));
    h.available = (id) => id === "codex"; // the Familiars card's checks: Claude missing, Codex found + signed in
    h.projects.scanRoots();
    expect([cfg.defaultAgent, cfg.chatAgent]).toEqual(["claude", "claude"]); // config defaults unchanged
    h.action({ type: "newIn", key: "chats" }); // + Chat
    expect(h.view.draft).toMatchObject({ agent: "codex", chat: true, model: undefined }); // chatModel is Claude's
    h.view.draft = undefined;
    await h.ask("where is the poison quest?"); // /fam ask
    h.handleAddon({ t: "quick", id: "m-quick", agent: "nope", text: "@alpha fix the build" }); // unknown agent → default
    await tick();
    await tick();
    expect([...h.threads.values()].map((t) => t.agent)).toEqual(["codex", "codex"]);
    expect(cx.sent.map((x) => x.text)).toEqual([expect.stringContaining("where is the poison quest?"), "fix the build"]);
    expect(cl.sent).toEqual([]);
    expect(lines.filter((l) => l.includes("default agent"))).toEqual(["[hub] default agent claude unavailable, using codex"]);
  });

  it("an available configured agent wins, even while it is still starting; nothing usable keeps the configured one", () => {
    const h = new Hub(() => cfg, { claude, codex }, () => {});
    vi.spyOn(claude, "status").mockReturnValue({ ready: false, models: [] }); // starting: retried on send
    expect(h.agentOr("claude")).toBe("claude");
    expect(h.agentOr("codex")).toBe("codex");
    h.available = (id) => (id === "claude" ? false : undefined); // Claude Agent SDK present, no sign-in
    expect(h.agentOr("claude")).toBe("codex");
    vi.spyOn(codex, "status").mockReturnValue({ ready: true, account: "signed out", models: [] }); // Codex's own report
    expect(h.agentOr("claude")).toBe("claude");
  });
});

describe("physical corroboration (any addon can forge strip messages)", () => {
  const ask = async (agent: FakeBackend, requestId: string) => {
    await hub.quick(agent === claude ? "claude" : "codex", "@familiar corroborate");
    const id = hub.view.selected!;
    agent.emit({ type: "approval", threadId: id, requestId, kind: "command", title: "Run command?", detail: "npm test", canAlways: true });
    return id;
  };

  it("approve and always need proof; deny never does", async () => {
    await ask(codex, "r1");
    for (const k of ["approve", "always"]) {
      hub.handleAddon({ t: "key", k, src: "button", view: "full" });
      await tick();
      expect(codex.decisions).toEqual([]);
      expect(hub.toasts.at(-1)!.text).toMatch(/Click the request on the Glass/);
    }
    hub.handleAddon({ t: "key", k: "always", src: "bind", view: "full" }, OK);
    await tick();
    expect(codex.decisions).toEqual([{ requestId: "r1", d: "allowAlways" }]);
    (hub as any).lastDecisionAt = 0;
    codex.emit({ type: "approval", threadId: hub.view.selected!, requestId: "r2", kind: "command", title: "Again?", detail: "rm x", canAlways: true });
    hub.handleAddon({ t: "key", k: "deny", src: "slash", view: "full" });
    await tick();
    expect(codex.decisions.at(-1)).toEqual({ requestId: "r2", d: "deny" });
  });

  it("card actions that grant something need proof; Deny on the card does not", async () => {
    const id = await ask(claude, "c1");
    hub.action({ type: "decide", thread: id, requestId: "c1", decision: "allow" });
    hub.action({ type: "decide", thread: id, requestId: "c1", decision: "allow" }, NO_PROOF);
    expect(claude.decisions).toEqual([]);
    expect(hub.toasts.at(-1)!.text).toMatch(/could not be matched to your mouse/);
    hub.action({ type: "decide", thread: id, requestId: "c1", decision: "deny" });
    expect(claude.decisions).toEqual([{ requestId: "c1", d: "deny" }]);
    claude.emit({ type: "approval", threadId: id, requestId: "q1", kind: "question", title: "Which?", detail: "", canAlways: false, options: ["A", "B"] } as any);
    hub.action({ type: "answer", thread: id, requestId: "q1", label: "A" });
    expect(hub.threads.get(id)!.entries.find((e) => e.requestId === "q1")!.approval).toBe("pending");
    // Desktop-thread confirmation and held prompts: Continue / Retry / copy are refused without proof.
    hub.action({ type: "select", id: "ext:claude:ext-1" });
    await hub.prompt("Review before continuing");
    expect(hub.view.confirm).toBeTruthy();
    for (const type of ["adoptConfirm", "adoptNew", "adoptRetry"]) hub.action({ type });
    expect(hub.view.confirm).toBeTruthy();
    expect(claude.sent.map((s) => s.text)).not.toContain("Review before continuing");
  });

  it("one decision per request id, even with two proofs", async () => {
    const id = await ask(codex, "once");
    hub.action({ type: "decide", thread: id, requestId: "once", decision: "allow" }, OK);
    hub.action({ type: "decide", thread: id, requestId: "once", decision: "allowAlways" }, OK);
    expect(codex.decisions).toEqual([{ requestId: "once", d: "allow" }]);
    (hub as any).lastDecisionAt = 0;
    await hub.key("approve", undefined, "full", OK);
    expect(codex.decisions).toHaveLength(1);
    expect(hub.toasts.at(-1)!.text).toMatch(/Nothing is waiting/);
  });

  it("a fresh card can't be approved for minCardAgeMs; denying it can", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      hub.minCardAgeMs = 400;
      const id = await ask(claude, "fresh");
      hub.action({ type: "decide", thread: id, requestId: "fresh", decision: "allow" }, OK);
      expect(claude.decisions).toEqual([]);
      expect(hub.toasts.at(-1)!.text).toMatch(/just appeared/);
      vi.advanceTimersByTime(450);
      hub.action({ type: "decide", thread: id, requestId: "fresh", decision: "allow" }, OK);
      expect(claude.decisions).toEqual([{ requestId: "fresh", d: "allow" }]);
      claude.emit({ type: "approval", threadId: id, requestId: "fresh2", kind: "command", title: "Run?", detail: "x", canAlways: false });
      hub.action({ type: "decide", thread: id, requestId: "fresh2", decision: "deny" });
      expect(claude.decisions.at(-1)).toEqual({ requestId: "fresh2", d: "deny" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cut request is never approved from the game, even with proof; the control panel approves it whole", async () => {
    await hub.quick("claude", "@familiar long command");
    const id = hub.view.selected!;
    const full = "echo " + "x".repeat(5000);
    const cut = (requestId: string) => claude.emit({ type: "approval", threadId: id, requestId, kind: "tool", title: "Allow Bash?",
      detail: full.slice(0, 4000) + "\n… (1005 characters omitted from this preview)", canAlways: true, cut: true, full });
    let alerts = 0;
    hub.onCutRequest = () => alerts++;
    cut("long");
    // The toast says where to approve it, and main is asked to make the control panel easy to reach.
    expect(hub.toasts.at(-1)).toMatchObject({ kind: "approval", text: "Needs approval · Claude · familiar · Allow Bash? · Open Familiar on your PC to approve",
      generic: "Needs approval · Claude · Open Familiar on your PC to approve" });
    expect(alerts).toBe(1);
    hub.action({ type: "decide", thread: id, requestId: "long", decision: "allow" }, NO_PROOF);
    expect(hub.threads.get(id)!.entries.find((e) => e.requestId === "long")!.refused?.why).toBe("cut"); // not "click again"
    hub.action({ type: "decide", thread: id, requestId: "long", decision: "allow" }, OK);
    hub.action({ type: "decide", thread: id, requestId: "long", decision: "allowAlways" }, OK);
    await hub.key("approve", undefined, "full", OK);
    await hub.key("always", undefined, "focus", OK);
    expect(claude.decisions).toEqual([]);
    expect(hub.toasts.at(-1)!.text).toBe("Open it in full on your PC to approve.");
    const detail = buildModel(hub, { linked: true, fps: 30 }).detail;
    const card = detail.kind === "thread" ? detail.entries.find((e) => e.requestId === "long") : undefined;
    expect(card).toMatchObject({ cut: true, approval: "pending",
      refused: "Part of this request is hidden here. Approve it in full from Familiar's control panel on your PC, or Deny." });
    expect(JSON.stringify(detail)).not.toContain(full); // the Glass never gets the whole text
    // "Requests waiting on your PC": the whole request with real names; a panel click decides it.
    expect(hub.cutRequests()).toEqual([{ thread: id, questTitle: "long command", project: "familiar", agent: "Claude", requestId: "long",
      title: "Allow Bash?", full, canAlways: true, at: expect.any(Number) }]);
    expect(hub.decide(id, "long", "allow", "panel")).toEqual({ ok: true });
    expect(claude.decisions).toEqual([{ requestId: "long", d: "allow" }]);
    expect(hub.threads.get(id)!.entries.find((e) => e.requestId === "long")!.refused).toBeUndefined();
    expect(hub.cutRequests()).toEqual([]);
    expect(hub.decide(id, "long", "allow", "panel")).toEqual({ ok: false, why: "no longer pending" });
    // Deny from the card needs no proof, cut or not.
    cut("long2");
    hub.action({ type: "decide", thread: id, requestId: "long2", decision: "deny" });
    expect(claude.decisions.at(-1)).toEqual({ requestId: "long2", d: "deny" });
    // The read-it-first rule holds in the panel too.
    hub.minCardAgeMs = 60_000;
    hub.setCombat(true); // the PC alert waits for the fight like every other notice
    cut("long3");
    expect(alerts).toBe(2);
    hub.setCombat(false);
    expect(alerts).toBe(3);
    expect(hub.decide(id, "long3", "allow", "panel")).toEqual({ ok: false, why: "fresh" });
    hub.minCardAgeMs = 0;
    // The whole text is saved only while the request can still be approved.
    hub.saveNow();
    const saved = JSON.parse(fs.readFileSync(path.join(appData, "Familiar", "threads.json"), "utf8")).threads.find((t: any) => t.id === id);
    expect(saved.entries.find((e: any) => e.requestId === "long")).toMatchObject({ cut: true, approval: "approved" });
    expect(saved.entries.find((e: any) => e.requestId === "long").full).toBeUndefined();
    expect(saved.entries.find((e: any) => e.requestId === "long3").full).toBe(full);
  });

  it("a refusal is written on the card until the next decision", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const id = await ask(claude, "r1");
      const card = () => hub.threads.get(id)!.entries.find((e) => e.requestId === "r1")!;
      const line = () => {
        const d = buildModel(hub, { linked: true, fps: 30 }).detail;
        return d.kind === "thread" ? d.entries.find((e) => e.requestId === "r1")?.refused : undefined;
      };
      hub.action({ type: "decide", thread: id, requestId: "r1", decision: "allow" }, NO_PROOF);
      expect(card().refused?.why).toBe("proof");
      expect(line()).toBe("That click wasn't confirmed as yours. Click Approve again.");
      hub.handleAddon({ t: "key", k: "approve", src: "bind", view: "full" }); // no matching key press
      await tick();
      expect(card().refused?.why).toBe("proof");
      hub.handleAddon({ t: "key", k: "approve", view: "sideways" }, OK);
      await tick();
      expect(line()).toBe("Use Full view and review the request before deciding.");
      hub.minCardAgeMs = 400;
      hub.action({ type: "decide", thread: id, requestId: "r1", decision: "allow" }, OK);
      expect(line()).toBe("This request just appeared. Read it, then click again.");
      expect(claude.decisions).toEqual([]);
      vi.advanceTimersByTime(450);
      hub.action({ type: "decide", thread: id, requestId: "r1", decision: "allow" }, OK);
      expect(claude.decisions).toEqual([{ requestId: "r1", d: "allow" }]);
      expect(card().refused).toBeUndefined();
      expect(line()).toBeUndefined();
      // A request that expires takes its refusal line with it too.
      claude.emit({ type: "approval", threadId: id, requestId: "r2", kind: "command", title: "Again?", detail: "npm test", canAlways: false });
      hub.action({ type: "decide", thread: id, requestId: "r2", decision: "allow" }, NO_PROOF);
      claude.emit({ type: "approvalResolved", threadId: id, requestId: "r2" });
      expect(hub.threads.get(id)!.entries.find((e) => e.requestId === "r2")).toMatchObject({ approval: "expired" });
      expect(hub.threads.get(id)!.entries.find((e) => e.requestId === "r2")!.refused).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Mode needs a click on the Mode button", async () => {
    await hub.quick("claude", "@familiar mode");
    const t = hub.selectedThread()!;
    hub.handleAddon({ t: "key", k: "mode", src: "button", view: "full" });
    await tick();
    expect(t.mode).toBe("ask");
    expect(claude.modes).toEqual([]);
    expect(hub.toasts.at(-1)!.text).toMatch(/Mode changes need a click/);
    hub.handleAddon({ t: "key", k: "mode", src: "button", view: "full" }, OK);
    await tick();
    expect(t.mode).toBe("plan");
  });
});

describe("A Familiar Face (the tutorial quest)", () => {
  const local = () => ({ ...cfg, tutorialSeen: false });
  const tutorialOf = (h: InstanceType<typeof Hub>) => [...h.threads.values()].filter((t) => t.kind === "tutorial");

  it("first run teaches the approval path", async () => {
    const c = local();
    const sounds: string[] = [];
    let saved: any;
    const h = new Hub(() => c, { claude, codex }, () => {});
    h.minCardAgeMs = 0;
    h.onSound = (k) => sounds.push(k);
    h.onConfigChanged = (x) => (saved = { ...x });
    await h.start();
    const [t] = tutorialOf(h);
    expect(t).toMatchObject({ agent: "familiar", title: "A Familiar Face", status: "idle", mode: "ask", unread: true });
    expect(t.entries[0].text).toMatch(/^Well met, adventurer\. I'm your familiar/);
    expect(t.todos.map((x) => x.text)).toEqual(["Speak to your familiar", "Answer a practice request", "Set out on a real quest"]);
    expect(saved.tutorialSeen).toBe(true);
    const m = buildModel(h, { linked: true, fps: 30 });
    expect(m.list.rows.find((r) => r.kind === "zone" && r.key === t.projectKey)?.text).toBe("Familiar");
    expect(m.list.rows.find((r) => r.key === t.id)).toMatchObject({ agent: "familiar", unread: true, text: "A Familiar Face" });
    expect(m.providers.familiar).toEqual({ label: "Familiar", glyph: "◆" });
    expect(h.projects.list().some((p) => p.path === t.cwd)).toBe(false); // never offered as a zone
    expect(buildSnapshot(h)).toContain("[Familiar] A Familiar Face");

    h.action({ type: "select", id: t.id });
    await h.prompt("hi");
    const card = t.entries.find((e) => e.kind === "approval")!;
    expect(card).toMatchObject({ approval: "pending", title: "Practice: light the hearth", canAlways: false });
    expect(card.cut).toBeUndefined();
    expect(t.status).toBe("approval");
    expect(h.toasts.at(-1)!.text).toMatch(/^Needs approval · Familiar/);
    expect(sounds).toEqual(["approval"]);
    expect(buildModel(h, { linked: true, fps: 30 }).keys.approve).toBe(true);
    // No mode, no model, and Stop has nothing to stop.
    await h.key("mode", undefined, "full", OK);
    expect(h.toasts.at(-1)!.text).toBe("The practice quest has no mode or model. Those are for real quests.");
    await h.key("model");
    expect(h.view.picker).toBeFalsy();
    await h.key("stop");
    expect(t.status).toBe("approval");
    // The real corroboration path: refused without proof, written on the card.
    h.action({ type: "decide", thread: t.id, requestId: card.requestId, decision: "allow" });
    expect(card).toMatchObject({ approval: "pending", refused: { why: "proof" } });
    h.action({ type: "decide", thread: t.id, requestId: card.requestId, decision: "allow" }, OK);
    expect(card.approval).toBe("approved");
    expect(card.refused).toBeUndefined();
    expect(t.status).toBe("idle");
    expect(t.todos.map((x) => x.status)).toEqual(["completed", "completed", "pending"]);
    expect(t.entries.findLast((e) => e.kind === "assistant")!.text).toMatch(/^The hearth is lit/);
    expect(h.toasts.map((x) => x.text)).toContain("Quest Complete · A Familiar Face");
    expect(sounds).toEqual(["approval", "done"]);
    expect([claude.sent, codex.sent, claude.decisions, codex.decisions]).toEqual([[], [], [], []]); // nothing ran
    await h.prompt("anything else?");
    expect(t.entries.findLast((e) => e.kind === "assistant")!.text).toMatch(/^Nothing more to teach/);
    expect(t.status).toBe("idle");
    // The first real quest completes the last objective; typed with the tutorial selected, it never
    // starts in the tutorial's folder (Familiar's own data).
    await h.quick("claude", "a real one");
    expect(h.selectedThread()!.cwd).not.toBe(t.cwd);
    expect(t.todos.every((x) => x.status === "completed")).toBe(true);
    expect(t.entries.some((e) => e.kind === "notice" && e.text === "Set out on a real quest ✓")).toBe(true);
    h.saveNow();

    // Restarts never seed a second one, nor one after it was archived and threads.json removed.
    const again = new Hub(() => c, { claude, codex }, () => {});
    await again.start();
    expect(tutorialOf(again)).toHaveLength(1);
    await again.archive(t.id);
    expect(tutorialOf(again)).toHaveLength(0);
    fs.rmSync(path.join(appData, "Familiar", "threads.json"));
    const third = new Hub(() => c, { claude, codex }, () => {});
    await third.start();
    expect(tutorialOf(third)).toHaveLength(0);
    // /fam tutorial (and the welcome page's link) bring a fresh one.
    await third.key("tutorial");
    expect(tutorialOf(third)).toHaveLength(1);
    expect(third.selectedThread()).toMatchObject({ kind: "tutorial", todos: [{ status: "pending" }, { status: "pending" }, { status: "pending" }] });
    third.action({ type: "tutorial" });
    expect(tutorialOf(third)).toHaveLength(1);
  });

  it("Deny completes the practice too, and never needs proof", async () => {
    const c = local();
    const h = new Hub(() => c, { claude, codex }, () => {});
    h.minCardAgeMs = 0;
    await h.start();
    const [t] = tutorialOf(h);
    h.action({ type: "select", id: t.id });
    await h.prompt("hello there");
    const card = t.entries.find((e) => e.kind === "approval")!;
    await h.prompt("what now?"); // the card is still waiting
    expect(t.entries.findLast((e) => e.kind === "assistant")!.text).toMatch(/practice request is waiting/);
    expect(t.status).toBe("approval");
    h.handleAddon({ t: "key", k: "deny", view: "full" });
    await tick();
    expect(card.approval).toBe("denied");
    expect(t.entries.findLast((e) => e.kind === "assistant")!.text).toMatch(/^Denied — also a fine answer/);
    expect(h.toasts.map((x) => x.text)).toContain("Quest Complete · A Familiar Face");
  });

  it("an existing profile is not given the tutorial by itself", async () => {
    await hub.quick("claude", "@familiar existing work");
    hub.saveNow();
    const c = local();
    const h = new Hub(() => c, { claude, codex }, () => {});
    await h.start();
    expect(tutorialOf(h)).toHaveLength(0);
  });
});

describe("game-side budgets and the start toast", () => {
  it("every quest start shows a Started toast with its zone", async () => {
    await hub.quick("claude", "@familiar fix the login bug");
    const t = hub.selectedThread()!;
    expect(hub.toasts.some((x) => x.text === `Started: ${t.title} (familiar)` && x.threadId === t.id)).toBe(true);
  });

  it("6 quest starts per 5 minutes; the 7th is refused with a toast, and allowed again later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const before = hub.threads.size;
      for (let i = 0; i < 7; i++) hub.handleAddon({ t: "quick", agent: "codex", text: `@familiar task ${i}` });
      for (let i = 0; i < 5; i++) await tick();
      expect(hub.threads.size - before).toBe(6);
      expect(hub.toasts.some((x) => /Too many new quests in 5 minutes/.test(x.text))).toBe(true);
      vi.advanceTimersByTime(300_001);
      await hub.quick("codex", "@familiar later");
      expect(hub.threads.size - before).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("20 prompts from the game per 5 minutes; resends of one prompt count once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let i = 0; i < 3; i++) hub.handleAddon({ t: "prompt", id: "same", text: " " });
      for (let i = 0; i < 19; i++) hub.handleAddon({ t: "prompt", id: `p${i}`, text: " " });
      expect(hub.toasts.some((x) => /Too many messages from the game/.test(x.text))).toBe(false);
      hub.handleAddon({ t: "ask", id: "p20", text: " " });
      expect(hub.toasts.at(-1)!.text).toMatch(/Too many messages from the game in 5 minutes/);
      expect(hub.toasts.at(-1)!.text).toContain("/fam stop");
      vi.advanceTimersByTime(300_001);
      const n = hub.toasts.length;
      hub.handleAddon({ t: "prompt", id: "p21", text: " " });
      expect(hub.toasts.length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });
});

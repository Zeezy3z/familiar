import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CodexBackend, prettyCommand } from "../src/agents/codex";
import { ClaudeBackend } from "../src/agents/claude";
import type { AgentEvent } from "../src/agents/types";
import { approvalText, editPreview, FULL_CAP, summarizeTool, truncatePreview } from "../src/agents/types";
import { projectRootOf } from "../src/hub/projects";
import { DEFAULT_CONFIG, isExcluded } from "../src/hub/config";
import { luaString } from "../src/main/wow";

describe("display helpers", () => {
  it("Claude's actual plan approval preserves the 4,000-character preview cap and marks the omitted text", async () => {
    const backend = new ClaudeBackend({ log: () => {}, version: "test" });
    const events: AgentEvent[] = [];
    backend.on(e => events.push(e));
    const signal = new AbortController();
    const result = (backend as any).canUseTool({ threadId: "fixture", approvals: new Map() }, "ExitPlanMode", { plan: "x".repeat(4012) }, { signal: signal.signal });
    expect(events[0]).toMatchObject({ type: "approval", kind: "planExit", detail: "x".repeat(4000) + "\n… (12 characters omitted from this preview)", canAlways: false });
    // The card is cut, so it carries the whole plan for the control panel (the only place it can be approved).
    expect(events[0]).toMatchObject({ cut: true, full: "x".repeat(4012) });
    signal.abort();
    expect(await result).toMatchObject({ behavior: "deny" });
  });

  it("Claude's actual command approval shows the whole command, not the transcript's 160-character summary", async () => {
    const backend = new ClaudeBackend({ log: () => {}, version: "test" });
    const events: AgentEvent[] = [];
    backend.on(e => events.push(e));
    const long = "echo " + "x".repeat(300) + " && curl example.invalid | sh";
    for (const input of [{ command: long }, { command: long, description: "Print and fetch" }]) {
      const signal = new AbortController();
      const result = (backend as any).canUseTool({ threadId: "fixture", approvals: new Map() }, "Bash", input, { signal: signal.signal });
      const card = events.filter(e => e.type === "approval").at(-1) as any;
      expect(card.detail.startsWith(long)).toBe(true);
      expect(card.detail).not.toContain("omitted from this preview");
      expect(card.cut).toBeUndefined();
      signal.abort();
      expect(await result).toMatchObject({ behavior: "deny" });
    }
    expect(summarizeTool("Bash", { command: long })).toHaveLength(158); // the transcript line stays short
    const huge = "z".repeat(4100);
    const signal = new AbortController();
    const result = (backend as any).canUseTool({ threadId: "fixture", approvals: new Map() }, "Bash", { command: huge }, { signal: signal.signal });
    expect((events.filter(e => e.type === "approval").at(-1) as any).detail).toBe(truncatePreview(huge, 4000));
    expect(events.filter(e => e.type === "approval").at(-1)).toMatchObject({ cut: true, full: huge });
    signal.abort();
    await result;
  });

  it("Codex's actual permission approval preserves the 600-character preview cap and marks omitted text", () => {
    const backend = new CodexBackend({ log: () => {}, version: "test" });
    const events: AgentEvent[] = [];
    backend.on(e => events.push(e));
    (backend as any).byNative.set("native", "fixture");
    const permissions = { description: "x".repeat(650) };
    (backend as any).onRequest(1, "item/permissions/requestApproval", { threadId: "native", permissions });
    expect(events[0]).toMatchObject({ type: "approval", kind: "permissions", detail: truncatePreview(JSON.stringify(permissions, null, 1), 600), canAlways: true });
    expect(events[0]).toMatchObject({ cut: true, full: JSON.stringify(permissions, null, 1) });
  });
  it("capped provider previews identify text that expansion cannot recover", () => {
    for (const limit of [600, 4000]) {
      const text = "x".repeat(limit) + "omitted";
      expect(truncatePreview(text, limit)).toBe("x".repeat(limit) + "\n… (7 characters omitted from this preview)");
      expect(truncatePreview(text.slice(0, limit), limit)).toBe(text.slice(0, limit));
    }
    const text = Array.from({ length: 65 }, (_, i) => `line ${i}`).join("\n");
    const preview = editPreview("Write", { file_path: "fixture.txt", content: text })!;
    expect(preview).toContain("+line 59\n… (5 lines omitted from this preview)");
    expect(preview).not.toContain("+line 60");
    // The whole request travels with a cut card, capped (and saying so) past 200k characters.
    expect(approvalText(preview, preview)).toEqual({ detail: preview });
    expect(approvalText(preview, text)).toEqual({ detail: preview, cut: true, full: text });
    expect(approvalText("v", "v".repeat(FULL_CAP + 5)).full).toBe("v".repeat(FULL_CAP) + "\n… (truncated at 200k)");
  });

  it("Claude's actual file write approval is cut past 60 lines and carries the whole write", async () => {
    const backend = new ClaudeBackend({ log: () => {}, version: "test" });
    const events: AgentEvent[] = [];
    backend.on(e => events.push(e));
    const content = Array.from({ length: 65 }, (_, i) => `line ${i}`).join("\n");
    const signal = new AbortController();
    const result = (backend as any).canUseTool({ threadId: "fixture", approvals: new Map() }, "Write", { file_path: "fixture.txt", content }, { signal: signal.signal });
    const card = events.find(e => e.type === "approval") as any;
    expect(card.detail).toContain("(5 lines omitted from this preview)");
    expect(card.cut).toBe(true);
    expect(card.full).toContain("+line 64");
    signal.abort();
    await result;
  });
  it("prettyCommand shortens Codex shell invocations", () => {
    const raw = String.raw`"D:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -NoProfile -Command "Get-Content -LiteralPath 'D:\\src\\familiar\\companion\\package.json'"`;
    expect(prettyCommand(raw)).toBe(String.raw`Get-Content -LiteralPath 'D:\src\familiar\companion\package.json'`);
    expect(prettyCommand(String.raw`"C:\Windows\System32\cmd.exe" /c dir`)).toBe("dir");
    expect(prettyCommand("git status")).toBe("git status");
  });

  it("summarizeTool picks the meaningful field", () => {
    expect(summarizeTool("Bash", { command: "npm test", description: "run tests" })).toBe("npm test");
    expect(summarizeTool("Read", { file_path: "D:\\src\\x.ts" })).toBe("D:\\src\\x.ts");
    expect(summarizeTool("Grep", { pattern: "TODO" })).toBe("TODO");
  });
});

describe("Codex keeps Ask first", () => {
  /** A CodexBackend whose app-server is a recorder (no codex.exe, no model calls). */
  function recorded() {
    const backend = new CodexBackend({ log: () => {}, version: "test" });
    const calls: { method: string; params: any }[] = [];
    (backend as any).rpc = {
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        return method === "turn/start" ? { turn: { id: `turn${calls.length}` } } : { thread: { id: `native${calls.length}` }, model: "gpt-test" };
      },
    };
    (backend as any).st = { ready: true, models: [] };
    return { backend, calls };
  }

  it("chats start with Codex's shell switched off and any approval routed to the player", async () => {
    const { backend, calls } = recorded();
    await backend.open({ threadId: "chat1", cwd: "C:\\Familiar\\chat", mode: "ask", chat: { instructions: "chat" } });
    expect(calls[0]).toMatchObject({
      method: "thread/start",
      params: { approvalsReviewer: "user", sandbox: "read-only", config: { web_search: "live", features: { shell_tool: false, unified_exec: false } } },
    });
    expect(calls[0].params.approvalPolicy).not.toBe("never"); // with "never", nothing Codex would ask about reaches the game
  });

  it("project quests send approvals to the player, not to Codex's own reviewer, except in Auto-review", async () => {
    const { backend, calls } = recorded();
    for (const mode of ["ask", "edits", "plan", "auto"] as const) await backend.open({ threadId: mode, cwd: "D:\\src\\X", mode });
    expect(calls.map((c) => c.params.approvalsReviewer)).toEqual(["user", "user", "user", "auto_review"]);
    // Leaving Auto-review mid-quest hands approvals back to the player on the next turn.
    await backend.setMode("auto", "ask");
    await backend.send("auto", "next");
    expect(calls.at(-1)).toMatchObject({ method: "turn/start", params: { approvalsReviewer: "user" } });
  });
});

describe("one owner per thread: the agent's own app or Familiar", () => {
  it("Codex: a thread the Codex app has open is seen from its writer lock; handing over lets go of Familiar's hold", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-codex-home-"));
    const locks = path.join(home, "thread-writer-locks");
    fs.mkdirSync(locks);
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const backend = new CodexBackend({ log: () => {}, version: "test" });
      const calls: { method: string; params: any }[] = [];
      (backend as any).rpc = {
        request: async (method: string, params: any) => {
          calls.push({ method, params });
          if (method === "thread/list") return { data: [{ id: "app-thread", name: "In the app", cwd: "D:\\src\\X" }, { id: "idle-thread", name: "Idle", cwd: "D:\\src\\X" }] };
          return { thread: { id: "mine" }, model: "gpt-test" };
        },
      };
      (backend as any).st = { ready: true, models: [] };
      fs.writeFileSync(path.join(locks, "app-thread.lock"), "");
      expect(backend.heldElsewhere("app-thread")).toBe(true);
      expect(backend.heldElsewhere("idle-thread")).toBe(false);
      expect((await backend.listThreads({})).map((t) => [t.nativeId, t.open])).toEqual([["app-thread", true], ["idle-thread", false]]);
      // Familiar's own app-server takes the same lock while it has the thread: that's not "elsewhere".
      await backend.open({ threadId: "q1", cwd: "D:\\src\\X", mode: "ask" });
      fs.writeFileSync(path.join(locks, "mine.lock"), "");
      expect(backend.heldElsewhere("mine")).toBe(false);
      expect(await backend.handOff("q1", "mine")).toBe("codex://threads/mine");
      expect(calls.at(-1)).toEqual({ method: "thread/unsubscribe", params: { threadId: "mine" } });
      expect(backend.isOpen("q1")).toBe(false);
      fs.rmSync(path.join(locks, "mine.lock")); // the app-server drops its lock once unsubscribed
      expect(backend.heldElsewhere("mine")).toBe(false);
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
    }
  });

  it("Claude: handing over closes Familiar's session and links the Claude app to the same session", async () => {
    const backend = new ClaudeBackend({ log: () => {}, version: "test" });
    const id = "6f1c2c1e-0000-4000-8000-000000000001";
    await backend.open({ threadId: "q1", cwd: "D:\\src\\X", mode: "ask", resumeNativeId: id });
    expect(backend.isOpen("q1")).toBe(true);
    expect(await backend.handOff("q1", id)).toBe(`claude://resume?session=${id}`);
    expect(backend.isOpen("q1")).toBe(false);
  });
});

describe("where Claude Code lives (claude-download.ts)", () => {
  const scope = (home: string) => path.join(home, "node_modules", "@anthropic-ai");
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  function install(home: string, parts: ("sdk" | "binary")[]) {
    if (parts.includes("sdk")) {
      fs.mkdirSync(path.join(scope(home), "claude-agent-sdk"), { recursive: true });
      fs.writeFileSync(path.join(scope(home), "claude-agent-sdk", "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", exports: { ".": { types: "./sdk.d.ts", default: "./entry.mjs" } } }));
    }
    if (parts.includes("binary")) {
      fs.mkdirSync(path.join(scope(home), `claude-agent-sdk-${process.platform}-${process.arch}`), { recursive: true });
      fs.writeFileSync(path.join(scope(home), `claude-agent-sdk-${process.platform}-${process.arch}`, exe), "");
    }
  }
  async function withRoute<T>(route: "clone" | "zip" | "installed", fn: (home: string, dl: typeof import("../src/agents/claude-download")) => T | Promise<T>) {
    const dl = await import("../src/agents/claude-download");
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "familiar-claude-")));
    const before = { ...dl.companionDir };
    const local = process.env.LOCALAPPDATA;
    dl.companionDir.root = path.join(tmp, "app");
    dl.companionDir.packaged = route === "installed";
    process.env.LOCALAPPDATA = path.join(tmp, "local");
    fs.mkdirSync(dl.companionDir.root, { recursive: true });
    if (route === "zip") fs.writeFileSync(path.join(dl.companionDir.root, ".prebuilt"), "");
    try {
      return await fn(dl.claudeHome(), dl);
    } finally {
      Object.assign(dl.companionDir, before);
      if (local === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = local;
    }
  }

  it("claudeHome: the companion folder for a clone or the zip, %LOCALAPPDATA%\\Familiar\\claude for the installed app", async () => {
    await withRoute("clone", (home, dl) => expect(home).toBe(dl.companionDir.root));
    await withRoute("zip", (home, dl) => expect(home).toBe(dl.companionDir.root));
    await withRoute("installed", (home) => expect(home).toBe(path.join(process.env.LOCALAPPDATA!, "Familiar", "claude")));
  });

  it("claudeNotDownloaded checks that folder for both packages; a clone (npm ci) never downloads", async () => {
    for (const route of ["zip", "installed"] as const)
      await withRoute(route, (home, dl) => {
        expect(dl.claudeNotDownloaded(), route).toBe(dl.CLAUDE_NOT_DOWNLOADED);
        install(home, ["sdk"]);
        expect(dl.claudeNotDownloaded(), route).toBe(dl.CLAUDE_NOT_DOWNLOADED);
        install(home, ["binary"]);
        expect(dl.claudeNotDownloaded(), route).toBeUndefined();
        expect(dl.claudeStatus()).toEqual({ state: "present" });
        expect(dl.claudeExecutable()).toBe(path.join(scope(home), `claude-agent-sdk-${process.platform}-${process.arch}`, exe));
      });
    await withRoute("clone", (_home, dl) => {
      expect(dl.claudeNotDownloaded()).toBeUndefined();
      expect(dl.claudeExecutable()).toBeUndefined(); // the SDK's own lookup
    });
  });

  it("the installed app imports the downloaded SDK by file URL from its package's exports; the others by name", async () => {
    await withRoute("installed", (home, dl) => {
      install(home, ["sdk", "binary"]);
      expect(dl.claudeSdkSpecifier()).toBe(pathToFileURL(path.join(scope(home), "claude-agent-sdk", "entry.mjs")).href);
    });
    for (const route of ["clone", "zip"] as const) await withRoute(route, (_home, dl) => expect(dl.claudeSdkSpecifier()).toBe("@anthropic-ai/claude-agent-sdk"));
  });
});

describe("projects & boundaries", () => {
  it("maps worktrees to their project", () => {
    expect(projectRootOf("D:\\src\\alpha\\.claude\\worktrees\\busy-euclid")).toBe("D:\\src\\alpha");
    expect(projectRootOf("D:\\src\\alpha-worktrees\\feature-x")).toBe("D:\\src\\alpha");
    expect(projectRootOf("D:\\src\\beta")).toBe("D:\\src\\beta");
  });

  it("excludes configured paths", () => {
    const cfg = { ...DEFAULT_CONFIG, exclude: [...DEFAULT_CONFIG.exclude, "\\private-vault"] };
    for (const p of ["D:\\src\\private-vault", "D:\\src\\private-vault\\notes", "D:\\src\\alpha\\node_modules\\x", "D:\\src\\alpha\\.git\\hooks"])
      expect(isExcluded(p, cfg), p).toBe(true);
    for (const p of ["D:\\src\\alpha", "D:\\src\\alpha-worktrees", "D:\\src\\beta", "D:\\src\\alpha\\.github"]) expect(isExcluded(p, cfg), p).toBe(false);
  });
});

describe("FamiliarSync lua strings", () => {
  it("escapes quotes, backslashes, newlines, control chars and WoW pipes", () => {
    expect(luaString('a "b" \\ c\nd|e\u0001')).toBe('"a \\"b\\" \\\\ c\\nd||e\\001"');
  });
});

describe("Claude automatic retry", () => {
  it("retries a prompt that failed before anything happened, never one whose tools already ran", async () => {
    vi.useFakeTimers();
    try {
      const b = new ClaudeBackend({ log: () => {}, version: "t" });
      const events: AgentEvent[] = [];
      b.on((e) => events.push(e));
      await b.open({ threadId: "q1", cwd: "D:\src\X", mode: "ask" });
      const prompts: string[] = [];
      const turns: (() => AsyncGenerator<any>)[] = [];
      // Stand-in for the SDK query: each start plays the next scripted turn.
      (b as any).startQuery = async (l: any) => {
        l.input = { push: (m: any) => prompts.push(m.message.content), end() {} };
        l.q = turns.shift()!();
        (b as any).consume(l, l.q);
      };
      const later = () => new Promise((r) => setTimeout(r, 10)); // the API answers after the prompt went in
      const overloaded = () => new Error("API Error: 529 overloaded_error");

      turns.push(async function* () { await later(); throw overloaded(); }, async function* () { await later(); });
      await b.send("q1", "what changed?");
      await vi.advanceTimersByTimeAsync(6_000);
      expect(prompts).toEqual(["what changed?", "what changed?"]);
      expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });

      turns.push(async function* () {
        await later();
        yield { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "mv a b" } }] } };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } };
        throw overloaded();
      }, async function* () { await later(); });
      prompts.length = 0;
      await b.send("q1", "rename the files");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events.some((e) => e.type === "tool" && e.toolId === "tu1")).toBe(true);
      expect(prompts).toEqual(["rename the files"]); // `mv` already ran: sending it again would repeat it
      expect(events.at(-1)).toMatchObject({ type: "done", threadId: "q1", status: "failed", error: expect.stringContaining("529") });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Hermes bot sessions are opt-in (hermesBotSessions)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { hermesCatalog, hermesSessionShown } = await import("../src/agents/hermes");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-hermes-"));
  const db = path.join(tmp, "state.db");
  const w = new DatabaseSync(db);
  w.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, cwd TEXT, model_config TEXT, started_at REAL,
            last_activity_at REAL, archived INTEGER, pinned INTEGER, hidden INTEGER, end_reason TEXT, parent_session_id TEXT, message_count INTEGER);
          CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, active INTEGER);`);
  const s = w.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const t0 = 1791300000;
  for (const [id, src, i] of [["cli1", "cli", 1], ["desk1", "desktop", 2], ["acp1", "acp", 3], ["tg1", "telegram", 4], ["dc1", "discord", 5], ["sl1", "Slack", 6]] as const) {
    s.run(id, src, `${src} chat`, null, null, t0 + i, t0 + i, 0, 0, 0, null, null, 1);
    w.prepare("INSERT INTO messages (session_id, role, content, tool_name, active) VALUES (?,?,?,?,?)").run(id, "user", `message in ${id}`, null, 1);
  }
  w.close();

  it("the filter keeps sessions started on this PC and drops messaging gateways unless opted in", () => {
    for (const src of ["cli", "tui", "desktop", "webui", "acp", "CLI"]) expect(hermesSessionShown(src, false), src).toBe(true);
    for (const src of ["telegram", "discord", "slack", "whatsapp", "email", "api_server", "someplugin", "", null]) expect(hermesSessionShown(src, false), String(src)).toBe(false);
    expect(hermesSessionShown("telegram", true)).toBe(true);
  });

  it("off: bot sessions are neither listed nor read; on: listed and read like any session", async () => {
    const off = hermesCatalog(() => {}, db, () => false);
    expect((await off.listThreads({})).map((t) => t.nativeId)).toEqual(["acp1", "desk1", "cli1"]);
    expect(await off.readHistory!("tg1")).toEqual([]);
    expect(await off.readHistory!("cli1")).toEqual([{ kind: "user", text: "message in cli1" }]);
    const on = hermesCatalog(() => {}, db, () => true);
    expect((await on.listThreads({})).map((t) => t.nativeId)).toEqual(["sl1", "dc1", "tg1", "acp1", "desk1", "cli1"]);
    expect(await on.readHistory!("tg1")).toEqual([{ kind: "user", text: "message in tg1" }]);
  });

  it("follows config.json: off by default, on with \"hermesBotSessions\": true", async () => {
    expect(DEFAULT_CONFIG.hermesBotSessions).toBe(false);
    const before = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, "appdata");
    try {
      const cat = hermesCatalog(() => {}, db);
      expect((await cat.listThreads({})).some((t) => t.nativeId === "tg1")).toBe(false); // no config.json yet
      fs.mkdirSync(path.join(tmp, "appdata", "Familiar"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "appdata", "Familiar", "config.json"), JSON.stringify({ hermesBotSessions: true }));
      expect((await cat.listThreads({})).some((t) => t.nativeId === "tg1")).toBe(true);
      expect(fs.readdirSync(path.join(tmp, "appdata", "Familiar"))).toEqual(["config.json"]); // read-only
    } finally {
      if (before === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = before;
    }
  });
});

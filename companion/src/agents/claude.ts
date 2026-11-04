// Claude backend: Claude Code via the Agent SDK. One long-lived query (streaming input) per open
// thread; approvals arrive through canUseTool and wait for an in-game decision. Uses
// ANTHROPIC_API_KEY or the user's existing Claude Code sign-in; Familiar never sees credentials.
import { randomUUID } from "node:crypto";
import { StderrFilter } from "./acp";
import { claudeExecutable, claudeNotDownloaded, claudeSdkSpecifier } from "./claude-download";
import { readDesktopSessions, readLiveSessions } from "./claude-desktop";
import {
  AgentBackend,
  AgentEvent,
  BackendStatus,
  ChatOptions,
  Decision,
  Emitter,
  HistoryEntry,
  Mode,
  StartOptions,
  approvalDetail,
  approvalText,
  editPreview,
  summarizeTool,
  truncatePreview,
  ThreadInfo,
  TodoItem,
} from "./types";

type Sdk = typeof import("@anthropic-ai/claude-agent-sdk");
let sdkPromise: Promise<Sdk> | null = null;
// The SDK is ESM-only; load it lazily from our CommonJS bundle (by name, or for the installed app
// from the download folder: claudeSdkSpecifier). Not cached while it is still being downloaded or
// failed to load, so a download that finishes later works without a restart.
const loadSdk = (): Promise<Sdk> => {
  const missing = claudeNotDownloaded();
  if (missing) return Promise.reject(new Error(missing));
  return (sdkPromise ??= (new Function("m", "return import(m)")(claudeSdkSpecifier()) as Promise<Sdk>).catch((e) => {
    sdkPromise = null;
    throw e;
  }));
};

const PERMISSION_MODE: Record<Mode, "default" | "acceptEdits" | "plan" | "auto"> = {
  ask: "default",
  edits: "acceptEdits",
  plan: "plan",
  auto: "auto",
};

const TODO_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite", "TaskList", "TaskGet"]);
const IDLE_CLOSE_MS = 15 * 60_000;

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;
  push(v: T) {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  end() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

interface PendingApproval {
  resolve: (r: any) => void;
  input: Record<string, unknown>;
  suggestions?: any[];
  toolName: string;
  options?: string[];
  question?: string;
}

interface Live {
  threadId: string;
  nativeId?: string; // session id
  cwd: string;
  mode: Mode;
  model?: string;
  persisted: boolean; // session exists on disk (resume instead of sessionId)
  fork: boolean;
  q?: any; // Query
  input?: AsyncQueue<any>;
  running: boolean;
  approvals: Map<string, PendingApproval>;
  textBlocks: Map<string, string[]>; // message id -> unfinalized text itemIds (in order)
  curMsg?: string;
  tasks: Map<string, TodoItem>;
  diffs: Map<string, string>; // tool_use id -> edit preview shown when the tool line is expanded
  pendingCreates: Map<string, string>; // tool_use id -> subject
  todoWrite?: TodoItem[];
  idleTimer?: NodeJS.Timeout;
  /** When the last turn ended (the transcript changing after that means another app wrote to it). */
  idleSince?: number;
  retryTimer?: NodeJS.Timeout;
  lastText?: string;
  retries: number;
  producedOutput: boolean;
  chat?: ChatOptions;
}

export class ClaudeBackend implements AgentBackend {
  readonly kind = "claude" as const;
  private ev = new Emitter<AgentEvent>();
  private live = new Map<string, Live>();
  private st: BackendStatus = { ready: false, models: [] };

  constructor(private opts: { log: (s: string) => void; version: string; executable?: string; defaultModel?: string }) {}

  on(h: (e: AgentEvent) => void) {
    return this.ev.on(h);
  }
  status() {
    return this.st;
  }

  isOpen(threadId: string) {
    return this.live.has(threadId);
  }

  async init(): Promise<BackendStatus> {
    try {
      await loadSdk();
      this.st = {
        ready: true,
        account: "Claude Code",
        models: [
          { id: "default", label: "Default", isDefault: true },
          { id: "opus", label: "Opus" },
          { id: "sonnet", label: "Sonnet" },
          { id: "haiku", label: "Haiku" },
        ],
      };
    } catch (e: any) {
      this.st = { ready: false, models: [], error: String(e?.message ?? e), setup: claudeNotDownloaded() };
    }
    return this.st;
  }

  async listThreads(q: { cwd?: string; limit?: number }): Promise<ThreadInfo[]> {
    const sdk = await loadSdk();
    // includeProgrammatic:false drops SDK/headless runs (scripts, pipelines, Familiar's own quests),
    // the same set the terminal's /resume hides.
    const list = await sdk.listSessions({ ...(q.cwd ? { dir: q.cwd } : {}), limit: q.limit ?? 60, includeProgrammatic: false });
    const desktop = readDesktopSessions();
    const live = readLiveSessions();
    return list.map((s: any): ThreadInfo => {
      const d = desktop.get(s.sessionId);
      return {
        nativeId: s.sessionId,
        agent: "claude",
        cwd: s.cwd ?? q.cwd ?? "",
        projectCwd: d?.originCwd,
        title: (d?.title || s.customTitle || s.summary || s.firstPrompt || "(untitled)").split(/\r?\n/)[0].slice(0, 90),
        createdAt: s.createdAt,
        updatedAt: Math.max(s.lastModified ?? 0, d?.lastActivityAt ?? 0),
        origin: d ? "desktop" : "cli",
        archived: d?.archived,
        starred: d?.starred,
        running: !!live.get(s.sessionId)?.busy,
        open: live.has(s.sessionId),
        automated: !!d?.scheduled || d?.completedTurns === 0,
        mode: d?.mode,
      };
    });
  }

  async readHistory(nativeId: string, cwd?: string, limit = 80): Promise<HistoryEntry[]> {
    const sdk = await loadSdk();
    const msgs = await sdk.getSessionMessages(nativeId, cwd ? { dir: cwd } : {});
    const out: HistoryEntry[] = [];
    for (const m of msgs.slice(-limit)) {
      if (m.parent_tool_use_id) continue; // subagent chatter
      const msg: any = m.message;
      const content = msg?.content;
      if (m.type === "user") {
        if (typeof content === "string") out.push({ kind: "user", text: content });
        else if (Array.isArray(content)) {
          const text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
          if (text.trim()) out.push({ kind: "user", text });
        }
      } else if (m.type === "assistant" && Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "text" && b.text?.trim()) out.push({ kind: "assistant", text: b.text });
          else if (b.type === "tool_use" && !TODO_TOOLS.has(b.name)) out.push({ kind: "tool", name: b.name, summary: summarizeTool(b.name, b.input) });
        }
      }
    }
    return out;
  }

  /** Overridable in tests. */
  protected openElsewhere(nativeId: string) {
    return readLiveSessions().has(nativeId);
  }

  heldElsewhere(nativeId: string) {
    return this.openElsewhere(nativeId);
  }

  async handOff(threadId: string | undefined, nativeId: string) {
    if (threadId) await this.close(threadId);
    // The app won't take a transcript a running Claude Code process still owns: give ours a moment.
    for (let i = 0; i < 30 && readLiveSessions(undefined, true).has(nativeId) && !this.openElsewhere(nativeId); i++)
      await new Promise((r) => setTimeout(r, 100));
    return `claude://resume?session=${encodeURIComponent(nativeId)}`;
  }

  async open(o: StartOptions): Promise<string> {
    // A fork reports its new session id in system/init; until then we track the original id.
    const nativeId = o.resumeNativeId ?? randomUUID();
    const l: Live = {
      threadId: o.threadId,
      nativeId,
      cwd: o.cwd,
      mode: o.mode,
      model: o.model,
      persisted: !!o.resumeNativeId,
      fork: !!o.fork,
      chat: o.chat,
      running: false,
      approvals: new Map(),
      textBlocks: new Map(),
      tasks: new Map(),
      diffs: new Map(),
      pendingCreates: new Map(),
      retries: 0,
      producedOutput: false,
    };
    this.live.set(o.threadId, l);
    if (!o.fork) this.ev.emit({ type: "session", threadId: o.threadId, nativeId });
    return nativeId;
  }

  private async startQuery(l: Live) {
    const sdk = await loadSdk();
    l.input = new AsyncQueue();
    const stderrFilter = new StderrFilter();
    const options: any = {
      cwd: l.cwd,
      permissionMode: PERMISSION_MODE[l.mode],
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      // Web search is on in every mode: it reads the web and returns results, nothing leaves but the
      // query. WebFetch (any URL, so it can carry data out) still follows the mode.
      allowedTools: ["WebSearch"],
      env: { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", CLAUDE_AGENT_SDK_CLIENT_APP: `familiar-wow/${this.opts.version}` },
      canUseTool: (toolName: string, input: Record<string, unknown>, opts: any) => this.canUseTool(l, toolName, input, opts),
      // Warnings and errors only (the CLI prints config paths and MCP command lines at startup).
      stderr: (s: string) => {
        for (const line of stderrFilter.lines(s)) this.opts.log("[claude:stderr] " + line);
      },
    };
    const exe = this.opts.executable || claudeExecutable(); // config override, else the downloaded binary
    if (exe) options.pathToClaudeCodeExecutable = exe;
    const model = l.model ?? this.opts.defaultModel;
    if (model && model !== "default") options.model = model;
    if (l.chat) {
      // Chat: web lookups only (auto-approved), no project/user settings, our own system prompt.
      options.tools = ["WebSearch", "WebFetch"];
      options.allowedTools = ["WebSearch", "WebFetch"];
      options.settingSources = [];
      options.systemPrompt = l.chat.instructions;
      options.permissionMode = "default";
      // Haiku 4.5 and older have no effort setting; Haiku 5.5 and the 5.x Sonnets/Opuses do.
      if (l.chat.effort && !/haiku-4|haiku-3|claude-3/i.test(model ?? "")) options.effort = l.chat.effort;
    }
    if (!l.fork) {
      // The transcript on disk decides. The CLI refuses a session id that already exists, so one that
      // does is resumed, even when an earlier turn failed before init. Looked up without `dir`: the
      // dir-scoped lookup finds nothing for chat transcripts, so every later turn re-created them.
      const info = await sdk.getSessionInfo(l.nativeId!).catch(() => undefined);
      l.persisted = !!info;
    }
    if (l.persisted && !l.fork && this.openElsewhere(l.nativeId!)) {
      // The desktop app or a terminal opened it since Familiar last did, and it owns writing to
      // it now: continue a copy rather than write a branch it won't see.
      l.fork = true;
      this.ev.emit({
        type: "notice",
        threadId: l.threadId,
        message: "This conversation is open in another app (the desktop app or a terminal), so Familiar continues a copy (fork). Close it there to keep working in the same conversation.",
      });
    }
    if (l.persisted) {
      options.resume = l.nativeId;
      if (l.fork) options.forkSession = true;
    } else {
      options.sessionId = l.nativeId;
    }
    l.q = sdk.query({ prompt: l.input, options });
    this.consume(l, l.q);
  }

  private async consume(l: Live, q: any) {
    try {
      for await (const m of q) this.onMessage(l, m);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      this.opts.log(`[claude] query error (${l.threadId}): ${msg}`);
      if (l.q !== q) return; // superseded
      l.q = undefined;
      l.input = undefined;
      const transient = /oauth|refresh|ECONNRESET|overloaded|529|socket hang up|rate.?limit/i.test(msg);
      if (l.running && transient && !l.producedOutput && l.retries < 3 && l.lastText) {
        const delay = [5_000, 15_000, 30_000][l.retries++];
        // Info, not an error: Familiar retries by itself, so it isn't something to catch up on.
        this.ev.emit({ type: "notice", threadId: l.threadId, message: `Claude hiccup (${msg.slice(0, 80)}); retrying in ${delay / 1000}s...` });
        l.retryTimer = setTimeout(() => {
          l.retryTimer = undefined;
          if (!this.live.has(l.threadId) || l.q) return; // closed, or a newer send already restarted it
          this.startQuery(l)
            .then(() => l.input!.push(userMessage(l.lastText!)))
            .catch((err) => {
              l.running = false;
              this.ev.emit({ type: "done", threadId: l.threadId, status: "failed", error: String(err?.message ?? err).slice(0, 400) });
            });
        }, delay);
        return;
      }
      if (l.running) {
        l.running = false;
        this.ev.emit({ type: "done", threadId: l.threadId, status: "failed", error: msg.slice(0, 400) });
      }
      return;
    }
    if (l.q === q) {
      l.q = undefined;
      l.input = undefined;
      if (l.running) {
        l.running = false;
        this.ev.emit({ type: "done", threadId: l.threadId, status: "completed" });
      }
    }
  }

  private onMessage(l: Live, m: any) {
    const threadId = l.threadId;
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          l.persisted = true;
          if (m.session_id && m.session_id !== l.nativeId) {
            l.nativeId = m.session_id;
            l.fork = false;
          }
          this.ev.emit({ type: "session", threadId, nativeId: m.session_id, model: m.model });
        }
        break;
      case "stream_event": {
        const e = m.event;
        if (m.parent_tool_use_id) break;
        if (e?.type === "message_start") l.curMsg = e.message?.id;
        else if (e?.type === "content_block_start" && e.content_block?.type === "text" && l.curMsg) {
          const itemId = `${l.curMsg}:${e.index}`;
          const arr = l.textBlocks.get(l.curMsg) ?? [];
          arr.push(itemId);
          l.textBlocks.set(l.curMsg, arr);
        } else if (e?.type === "content_block_delta" && l.curMsg) {
          if (e.delta?.type === "text_delta") {
            l.producedOutput = true;
            this.ev.emit({ type: "delta", threadId, itemId: `${l.curMsg}:${e.index}`, channel: "text", text: e.delta.text });
          } else if (e.delta?.type === "thinking_delta") {
            this.ev.emit({ type: "delta", threadId, itemId: `${l.curMsg}:${e.index}:think`, channel: "reasoning", text: e.delta.thinking ?? "" });
          }
        }
        break;
      }
      case "assistant": {
        if (m.parent_tool_use_id) break;
        const msg = m.message;
        if (m.error && msg?.model === "<synthetic>") break;
        for (const b of msg?.content ?? []) {
          if (b.type === "text") {
            const arr = l.textBlocks.get(msg.id) ?? [];
            const itemId = arr.shift() ?? `${msg.id}:x${Math.random().toString(36).slice(2, 7)}`;
            l.producedOutput = true;
            this.ev.emit({ type: "message", threadId, itemId, text: b.text ?? "" });
          } else if (b.type === "tool_use") {
            this.onToolUse(l, b);
          }
        }
        break;
      }
      case "user": {
        const content = m.message?.content;
        if (!Array.isArray(content) || m.parent_tool_use_id) break;
        for (const b of content) {
          if (b.type !== "tool_result") continue;
          const subject = l.pendingCreates.get(b.tool_use_id);
          if (subject !== undefined) {
            l.pendingCreates.delete(b.tool_use_id);
            const id = m.tool_use_result?.task?.id ?? b.tool_use_id;
            l.tasks.set(String(id), { id: String(id), text: subject, status: "pending" });
            this.emitTodos(l);
            continue;
          }
          const text = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join("\n") : String(b.content ?? "");
          const diff = l.diffs.get(b.tool_use_id);
          l.diffs.delete(b.tool_use_id);
          const output = diff && !b.is_error ? diff : tail(text);
          this.ev.emit({ type: "tool", threadId, toolId: b.tool_use_id, phase: "completed", name: "", summary: "", ok: !b.is_error, output });
        }
        break;
      }
      case "result": {
        l.retries = 0;
        const failed = !!m.is_error;
        // A message sent mid-turn is queued by the CLI: another turn (and result) follows.
        const more = (m.queued_turn_count ?? 0) > 0 && !failed;
        if (more) {
          this.ev.emit({ type: "usage", threadId, inputTokens: m.usage?.input_tokens, outputTokens: m.usage?.output_tokens, costUsd: m.total_cost_usd });
          break;
        }
        l.running = false;
        this.ev.emit({
          type: "usage",
          threadId,
          inputTokens: m.usage?.input_tokens,
          outputTokens: m.usage?.output_tokens,
          costUsd: m.total_cost_usd,
        });
        this.ev.emit({
          type: "done",
          threadId,
          status: m.terminal_reason?.startsWith?.("aborted") ? "interrupted" : failed ? "failed" : "completed",
          error: failed ? String(m.errors?.join?.("; ") || m.result || m.subtype).slice(0, 400) : undefined,
          durationMs: m.duration_ms,
        });
        l.idleSince = Date.now();
        this.armIdle(l);
        break;
      }
    }
  }

  private onToolUse(l: Live, b: any) {
    // The tool may already have run (a Bash command, an edit): resending the prompt would repeat it.
    l.producedOutput = true;
    const input = b.input ?? {};
    if (b.name === "TaskCreate") {
      l.pendingCreates.set(b.id, String(input.subject ?? input.description ?? "task"));
      return;
    }
    if (b.name === "TaskUpdate") {
      const id = String(input.taskId ?? input.id ?? input.task_id ?? "");
      const t = l.tasks.get(id);
      if (t) {
        if (input.status === "deleted") l.tasks.delete(id);
        else {
          if (input.status) t.status = input.status;
          if (input.subject) t.text = input.subject;
        }
        this.emitTodos(l);
      }
      return;
    }
    if (b.name === "TodoWrite" && Array.isArray(input.todos)) {
      l.todoWrite = input.todos.map((t: any) => ({ text: t.content ?? t.activeForm ?? "", status: t.status ?? "pending" }));
      this.emitTodos(l);
      return;
    }
    if (TODO_TOOLS.has(b.name)) return;
    this.ev.emit({ type: "tool", threadId: l.threadId, toolId: b.id, phase: "started", name: b.name, summary: summarizeTool(b.name, input) });
    const diff = editPreview(b.name, input);
    if (diff) l.diffs.set(b.id, diff);
  }

  private emitTodos(l: Live) {
    const items = l.todoWrite ?? [...l.tasks.values()];
    this.ev.emit({ type: "todo", threadId: l.threadId, items });
  }

  private canUseTool(l: Live, toolName: string, input: Record<string, unknown>, opts: any): Promise<any> {
    const requestId = `claude:${opts?.toolUseID ?? randomUUID()}`;
    // Which tool asked, in which mode (no content): answers "why did Auto ask?" from the log.
    this.opts.log(`[claude] approval asked (${l.threadId}): ${toolName} in ${l.mode} mode`);
    return new Promise((resolve) => {
      const pending: PendingApproval = { resolve, input, suggestions: opts?.suggestions, toolName };
      let kind: "tool" | "question" | "planExit" = "tool";
      let title = opts?.title ?? `Allow ${opts?.displayName ?? toolName}?`;
      // The card's text within its limits, or (Infinity) the whole request for the control panel.
      const describe = (chars: number, lines: number) => {
        const diff = editPreview(toolName, input, lines);
        if (diff) return diff;
        const body = approvalDetail(toolName, input, chars);
        if (toolName === "Bash" && (input as any).description) return `${body}\n# ${(input as any).description}`;
        return opts?.description ? `${opts.description}\n${body}` : body;
      };
      let text = approvalText(describe(4000, 60), describe(Infinity, Infinity));
      if (toolName === "AskUserQuestion") {
        const q = (input as any).questions?.[0];
        kind = "question";
        title = q?.question ?? "Claude has a question";
        pending.question = q?.question;
        pending.options = (q?.options ?? []).map((o: any) => o.label ?? String(o));
        text = { detail: (q?.options ?? []).map((o: any) => `• ${o.label}${o.description ? " — " + o.description : ""}`).join("\n") };
      } else if (toolName === "ExitPlanMode") {
        kind = "planExit";
        title = "Approve the plan and start implementing?";
        const plan = String((input as any).plan ?? "");
        text = approvalText(truncatePreview(plan, 4000), plan);
      }
      l.approvals.set(requestId, pending);
      opts?.signal?.addEventListener?.("abort", () => {
        if (l.approvals.delete(requestId)) {
          resolve({ behavior: "deny", message: "aborted" });
          this.ev.emit({ type: "approvalResolved", threadId: l.threadId, requestId });
        }
      });
      this.ev.emit({
        type: "approval",
        threadId: l.threadId,
        requestId,
        kind,
        title,
        ...text,
        canAlways: kind === "tool" && !opts?.suppressAlwaysAllowRule && (opts?.suggestions?.length ?? 0) > 0,
        ...(pending.options ? { options: pending.options } : {}),
      } as AgentEvent);
    });
  }

  /** Answer a pending AskUserQuestion with one of its option labels. */
  answerQuestion(threadId: string, requestId: string, label: string) {
    const l = this.live.get(threadId);
    const a = l?.approvals.get(requestId);
    if (!l || !a) return;
    l.approvals.delete(requestId);
    a.resolve({ behavior: "allow", updatedInput: { ...a.input, answers: { [a.question ?? ""]: label } } });
    this.ev.emit({ type: "approvalResolved", threadId, requestId });
  }

  respondApproval(threadId: string, requestId: string, d: Decision) {
    const l = this.live.get(threadId);
    const a = l?.approvals.get(requestId);
    if (!l || !a) return;
    if (a.options && (d === "allow" || d === "allowAlways")) {
      return this.answerQuestion(threadId, requestId, a.options[0]);
    }
    l.approvals.delete(requestId);
    if (d === "allow") a.resolve({ behavior: "allow", updatedInput: a.input });
    else if (d === "allowAlways") {
      const perms = (a.suggestions ?? []).map((s: any) => ({ ...s, destination: "session" }));
      a.resolve({ behavior: "allow", updatedInput: a.input, updatedPermissions: perms });
      if (a.toolName === "ExitPlanMode") {
        this.setMode(threadId, "edits");
        this.ev.emit({ type: "mode", threadId, mode: "edits" });
      }
    } else a.resolve({ behavior: "deny", message: "Denied by the user (from World of Warcraft).", interrupt: d === "denyAndStop" });
    this.ev.emit({ type: "approvalResolved", threadId, requestId });
  }

  async send(threadId: string, text: string) {
    const l = this.live.get(threadId);
    if (!l) throw new Error("thread not open");
    if (l.idleTimer) clearTimeout(l.idleTimer);
    if (l.retryTimer) {
      clearTimeout(l.retryTimer);
      l.retryTimer = undefined;
    }
    l.lastText = text;
    l.producedOutput = false;
    if (l.q && !l.running && (await this.changedElsewhere(l))) this.dropQuery(l);
    if (!l.q) await this.startQuery(l);
    if (!l.running) {
      l.running = true;
      this.ev.emit({ type: "turnStarted", threadId });
    }
    l.input!.push(userMessage(text));
  }

  async interrupt(threadId: string) {
    const l = this.live.get(threadId);
    if (!l) return;
    if (l.retryTimer) {
      // Stopped during a retry backoff: cancel the retry and end the turn.
      clearTimeout(l.retryTimer);
      l.retryTimer = undefined;
      if (l.running) {
        l.running = false;
        this.ev.emit({ type: "done", threadId, status: "interrupted" });
      }
      return;
    }
    if (!l.q) return;
    for (const [rid, a] of l.approvals) {
      a.resolve({ behavior: "deny", message: "Interrupted by the user.", interrupt: true });
      this.ev.emit({ type: "approvalResolved", threadId, requestId: rid });
    }
    l.approvals.clear();
    await l.q.interrupt().catch(() => {});
  }

  async setMode(threadId: string, mode: Mode) {
    const l = this.live.get(threadId);
    if (!l) return;
    l.mode = mode;
    await l.q?.setPermissionMode(PERMISSION_MODE[mode]).catch((e: any) => this.opts.log("[claude] setPermissionMode: " + e));
  }

  async setModel(threadId: string, model: string) {
    const l = this.live.get(threadId);
    if (!l) return;
    l.model = model;
    await l.q?.setModel(model === "default" ? undefined : model).catch((e: any) => this.opts.log("[claude] setModel: " + e));
  }

  private armIdle(l: Live) {
    if (l.idleTimer) clearTimeout(l.idleTimer);
    l.idleTimer = setTimeout(() => {
      if (l.running || l.approvals.size) return;
      this.dropQuery(l);
    }, IDLE_CLOSE_MS);
  }

  private dropQuery(l: Live) {
    const q = l.q;
    l.q = undefined;
    l.input?.end();
    l.input = undefined;
    try {
      q?.close();
    } catch {
      /* ignore */
    }
  }

  /** Whether the conversation moved on outside Familiar since its last turn (continued in the
   * desktop app or a terminal, or open there now): the next turn then reloads it from disk (or
   * forks) instead of answering from a stale copy. */
  private async changedElsewhere(l: Live): Promise<boolean> {
    if (!l.persisted || l.fork || !l.nativeId) return false;
    if (this.openElsewhere(l.nativeId)) return true;
    if (!l.idleSince) return false;
    const sdk = await loadSdk();
    const info: any = await sdk.getSessionInfo(l.nativeId, { dir: l.cwd }).catch(() => undefined);
    return (info?.lastModified ?? 0) > l.idleSince + 2_000;
  }

  async close(threadId: string) {
    const l = this.live.get(threadId);
    if (!l) return;
    this.live.delete(threadId);
    if (l.idleTimer) clearTimeout(l.idleTimer);
    if (l.retryTimer) clearTimeout(l.retryTimer);
    l.input?.end();
    try {
      l.q?.close();
    } catch {
      /* ignore */
    }
  }

  async shutdown() {
    for (const id of [...this.live.keys()]) await this.close(id);
  }
}

function userMessage(text: string) {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
}

function tail(s?: string, n = 1200) {
  if (!s) return undefined;
  return s.length > n ? "…" + s.slice(-n) : s;
}

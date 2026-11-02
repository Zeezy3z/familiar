// Agent Client Protocol backend: any ACP agent (Hermes, Grok Build, Gemini CLI, ...) started as a
// child process speaking JSON-RPC over stdio, through the official SDK. One process per provider;
// one ACP session per quest. Capabilities differ per agent (listing, resume, fork, modes, models),
// so everything optional is checked against what the agent advertised.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { providerLabel } from "./providers";
import {
  AgentBackend,
  AgentEvent,
  BackendStatus,
  Decision,
  editPreview,
  Emitter,
  HistoryEntry,
  Mode,
  StartOptions,
  ThreadInfo,
  TodoItem,
} from "./types";
import { resolveCommand } from "./which";

/** Extra knowledge about a harness's own session store (listing threads started elsewhere). */
export interface AcpCatalog {
  listThreads(q: { cwd?: string; limit?: number }): Promise<ThreadInfo[]>;
  readHistory?(nativeId: string, limit?: number): Promise<HistoryEntry[]>;
  /** False for sessions the agent can't resume over ACP (e.g. Hermes desktop/Telegram sessions):
   * those continue as a new session that starts from a digest of their transcript. */
  canResume?(nativeId: string): boolean;
  /** Archive in the harness's own store (ACP has no archive method). */
  archive?(nativeId: string, archived: boolean): Promise<boolean>;
}

export interface AcpOptions {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  log: (s: string) => void;
  version: string;
  catalog?: AcpCatalog;
  /** The agent denies an unanswered permission request after this many seconds (shown in game). */
  approvalTimeoutSec?: number;
  /** Tests: talk to an in-process agent instead of spawning one. */
  connect?: () => { input: WritableStream<Uint8Array>; output: ReadableStream<Uint8Array>; kill(): void };
}

interface Live {
  threadId: string;
  sessionId: string;
  cwd: string;
  mode: Mode;
  running: boolean;
  queue: string[];
  replaying: boolean;
  msgSeq: number;
  msgId?: string;
  msgText: string;
  thoughtId?: string;
  tools: Map<string, string>; // toolCallId -> display name
  modes?: acp.SessionModeState | null;
  config?: acp.SessionConfigOption[] | null;
  /** Unstable ACP model state ({ currentModelId, availableModels }) some agents return instead. */
  models?: { currentModelId?: string; availableModels?: { modelId: string; name?: string }[] } | null;
  /** Chat instructions, sent once in front of the first message (ACP has no system prompt). */
  preface?: string;
  /** Chats run in the agent's plan/read-only mode, or its ask mode when it has none. */
  chat: boolean;
}

interface PendingApproval {
  threadId: string;
  sessionId: string;
  options: acp.PermissionOption[];
  resolve: (r: acp.RequestPermissionResponse) => void;
}

/** Modes that would let the agent act without asking. Familiar never selects them. */
const UNSAFE_MODE = /yolo|bypass|danger|full.?access|always.?approve|auto.?approve|no.?approv|unrestricted|skip.?perm|dont.?ask|don't.?ask|never.?ask/i;
const UNSAFE_COMMAND = /^\/(always-?approve|yolo|dangerously\S*|bypass\S*|auto-?approve|dont-?ask|permissions?\s+(off|bypass|yolo))\b/i;
const MODE_WANT: Record<Mode, RegExp> = {
  ask: /^(default|ask|normal|standard|manual|code|agent)\b/i,
  edits: /accept.?edits|auto.?edits?|^edits?$/i,
  plan: /plan|read.?only|architect|ask.?only/i,
  auto: /auto.?review|review/i,
};

const isUnsafe = (m: acp.SessionMode) => UNSAFE_MODE.test(`${m.id} ${m.name} ${m.description ?? ""}`);

export function pickMode(available: acp.SessionMode[], mode: Mode): string | undefined {
  const safe = available.filter((m) => !isUnsafe(m));
  const want = MODE_WANT[mode];
  return safe.find((m) => want.test(m.id) || want.test(m.name))?.id ?? (mode === "ask" ? safe[0]?.id : undefined);
}

export class AcpBackend implements AgentBackend {
  readonly kind: string;
  private ev = new Emitter<AgentEvent>();
  private st: BackendStatus = { ready: false, models: [] };
  private conn: acp.ClientSideConnection | null = null;
  private kill: (() => void) | null = null;
  private caps: acp.AgentCapabilities = {};
  private starting: Promise<BackendStatus> | null = null;
  private live = new Map<string, Live>(); // hub thread id -> live
  private bySession = new Map<string, Live>();
  private approvals = new Map<string, PendingApproval>();
  private reqSeq = 0;

  constructor(private o: AcpOptions) {
    this.kind = o.id;
  }

  private get label() {
    return providerLabel(this.o.id);
  }

  on(h: (e: AgentEvent) => void) {
    return this.ev.on(h);
  }
  status() {
    return this.st;
  }
  isOpen(threadId: string) {
    return this.live.has(threadId);
  }

  init(): Promise<BackendStatus> {
    if (this.st.ready && this.conn) return Promise.resolve(this.st);
    this.starting ??= this.connect()
      .catch((e) => {
        this.st = { ready: false, models: [], error: String(e?.message ?? e) };
        return this.st;
      })
      .finally(() => (this.starting = null));
    return this.starting;
  }

  private async connect(): Promise<BackendStatus> {
    let io: { input: WritableStream<Uint8Array>; output: ReadableStream<Uint8Array>; kill(): void };
    if (this.o.connect) io = this.o.connect();
    else {
      const exe = resolveCommand(this.o.command);
      if (!exe) throw new Error(`${this.o.command} is not installed (not found on PATH)`);
      const shim = /\.(cmd|bat)$/i.test(exe);
      const child = spawn(shim ? process.env.ComSpec ?? "cmd.exe" : exe, shim ? ["/d", "/s", "/c", exe, ...(this.o.args ?? [])] : this.o.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: safeEnv({ ...process.env, ...this.o.env }),
      });
      const quiet = new StderrFilter();
      child.stderr.on("data", (d) => {
        for (const line of quiet.lines(String(d))) this.o.log(`[${this.o.id}:stderr] ${line}`);
      });
      child.on("error", (e) => this.o.log(`[${this.o.id}] ${e}`));
      child.on("exit", (code) => this.onExit(code));
      io = {
        input: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        output: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        kill: () => child.kill(),
      };
    }
    this.kill = io.kill;
    const conn = new acp.ClientSideConnection(
      () => ({
        requestPermission: (p: acp.RequestPermissionRequest) => this.onPermission(p),
        sessionUpdate: (n: acp.SessionNotification) => this.onUpdate(n),
      }),
      acp.ndJsonStream(io.input, io.output),
    );
    const init = await withTimeout(
      conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "familiar_wow", title: "Familiar (WoW)", version: this.o.version },
      }),
      45_000,
      "initialize",
    );
    this.conn = conn;
    this.caps = init.agentCapabilities ?? {};
    const agent = init.agentInfo ? `${init.agentInfo.title ?? init.agentInfo.name} ${init.agentInfo.version ?? ""}`.trim() : this.label;
    this.st = { ready: true, account: agent, models: this.st.models };
    this.o.log(`[${this.o.id}] ACP v${init.protocolVersion} ready (${agent}); caps ${JSON.stringify(this.caps).slice(0, 300)}`);
    return this.st;
  }

  private onExit(code: number | null) {
    this.o.log(`[${this.o.id}] agent exited (${code})`);
    this.conn = null;
    this.st = { ...this.st, ready: false, error: `${this.label} exited` };
    for (const l of this.live.values()) {
      if (l.running) this.ev.emit({ type: "done", threadId: l.threadId, status: "failed", error: `${this.label} exited` });
    }
    for (const [rid, a] of this.approvals) {
      a.resolve({ outcome: { outcome: "cancelled" } });
      this.ev.emit({ type: "approvalResolved", threadId: a.threadId, requestId: rid });
    }
    this.approvals.clear();
    this.live.clear();
    this.bySession.clear();
  }

  private async ensure(): Promise<acp.ClientSideConnection> {
    if (!this.conn) await this.init();
    if (!this.conn) throw new Error(this.st.error ?? `${this.label} is unavailable`);
    return this.conn;
  }

  // ---- threads ---------------------------------------------------------------------------------
  async listThreads(q: { cwd?: string; limit?: number }): Promise<ThreadInfo[]> {
    if (this.o.catalog) return this.o.catalog.listThreads(q);
    if (!this.caps.sessionCapabilities?.list) return [];
    const conn = await this.ensure();
    const out: ThreadInfo[] = [];
    let cursor: string | undefined;
    do {
      const r = await conn.listSessions({ ...(q.cwd ? { cwd: q.cwd } : {}), ...(cursor ? { cursor } : {}) });
      for (const s of r.sessions)
        out.push({
          nativeId: s.sessionId,
          agent: this.o.id,
          cwd: s.cwd,
          title: (s.title || "(untitled)").split(/\r?\n/)[0].slice(0, 90),
          updatedAt: s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0,
          origin: "cli",
        });
      cursor = r.nextCursor ?? undefined;
    } while (cursor && out.length < (q.limit ?? 100));
    return out;
  }

  async archive(nativeId: string, archived: boolean): Promise<boolean> {
    return this.o.catalog?.archive ? this.o.catalog.archive(nativeId, archived) : false;
  }

  async readHistory(nativeId: string, _cwd?: string, limit = 80): Promise<HistoryEntry[]> {
    return this.o.catalog?.readHistory ? this.o.catalog.readHistory(nativeId, limit) : [];
  }

  async open(o: StartOptions): Promise<string> {
    const conn = await this.ensure();
    const base = { cwd: o.cwd, mcpServers: [] as acp.McpServer[] };
    const l: Live = {
      threadId: o.threadId,
      sessionId: o.resumeNativeId ?? "",
      cwd: o.cwd,
      mode: o.mode,
      running: false,
      queue: [],
      replaying: false,
      msgSeq: 0,
      msgText: "",
      tools: new Map(),
      preface: o.chat?.instructions,
      chat: !!o.chat,
    };
    let resp: { modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null; models?: any };
    if (o.resumeNativeId) {
      const sc = this.caps.sessionCapabilities as any;
      if (o.fork && sc?.fork) {
        const r = await conn.unstable_forkSession({ sessionId: o.resumeNativeId, ...base });
        l.sessionId = r.sessionId;
        resp = r;
      } else if (this.o.catalog?.canResume && !this.o.catalog.canResume(o.resumeNativeId)) {
        // Not resumable over ACP (resuming an unknown id would silently start an empty session):
        // continue in a new session that starts from a digest of the transcript.
        const hist = (await this.o.catalog.readHistory?.(o.resumeNativeId, 40).catch(() => [])) ?? [];
        const r = await conn.newSession(base);
        l.sessionId = r.sessionId;
        resp = r;
        l.preface = [l.preface, digest(hist)].filter(Boolean).join("\n\n");
        this.ev.emit({
          type: "notice",
          threadId: o.threadId,
          message: `${this.label} can't resume this conversation from outside its own app, so it continues as a new ${this.label} session that starts from a summary of it.`,
        });
      } else if (sc?.resume || this.caps.loadSession) {
        // Both replay the conversation as updates before answering; Familiar already shows it.
        l.replaying = true;
        this.bySession.set(l.sessionId, l);
        try {
          resp = sc?.resume
            ? await conn.resumeSession({ sessionId: o.resumeNativeId, ...base })
            : await conn.loadSession({ sessionId: o.resumeNativeId, ...base });
        } finally {
          l.replaying = false;
        }
      } else throw new Error(`${this.label} can't continue an existing session`);
    } else {
      const r = await conn.newSession(base);
      l.sessionId = r.sessionId;
      resp = r;
    }
    l.modes = resp.modes;
    l.config = resp.configOptions;
    l.models = resp.models;
    this.live.set(o.threadId, l);
    this.bySession.set(l.sessionId, l);
    this.learnModels(l);
    // Ask first can't depend on the agent's own default: never keep a session that skips approvals.
    const modeError = await this.applyMode(l, wanted(l)).then(() => undefined, (e) => e);
    const unsafe = this.unsafeMode(l);
    if (unsafe) {
      await this.close(o.threadId);
      throw new Error(
        `${this.label} is in its "${unsafe}" mode, which acts without asking, and Familiar couldn't move it to a mode that asks before acting${modeError ? ` (${modeError.message ?? modeError})` : ""}.`,
      );
    }
    if (modeError) this.o.log(`[${this.o.id}] mode: ${modeError}`);
    if (o.model) await this.setModel(o.threadId, o.model).catch((e) => this.o.log(`[${this.o.id}] model: ${e}`));
    this.ev.emit({ type: "session", threadId: o.threadId, nativeId: l.sessionId, model: this.currentModel(l) });
    return l.sessionId;
  }

  async send(threadId: string, text: string): Promise<void> {
    const l = this.live.get(threadId);
    if (!l) throw new Error("thread not open");
    // Agents' own slash commands that switch approvals off (Grok /always-approve, Hermes /yolo)
    // must not be reachable from the game.
    if (UNSAFE_COMMAND.test(text.trim())) {
      this.ev.emit({ type: "error", threadId, message: `Not sent: "${text.trim().split(/\s/)[0]}" would let ${this.label} act without asking. Familiar keeps approvals on.` });
      this.ev.emit({ type: "done", threadId, status: "failed", error: "approval bypass refused" });
      return;
    }
    if (l.running) {
      // ACP has no steering: run it as the next turn.
      l.queue.push(text);
      return;
    }
    this.runTurn(l, text);
  }

  private runTurn(l: Live, text: string) {
    const conn = this.conn;
    if (!conn) {
      this.ev.emit({ type: "done", threadId: l.threadId, status: "failed", error: `${this.label} is not running` });
      return;
    }
    const body = l.preface ? `${l.preface}\n\n---\n\n${text}` : text;
    l.preface = undefined;
    l.running = true;
    const started = Date.now();
    this.ev.emit({ type: "turnStarted", threadId: l.threadId });
    conn
      .prompt({ sessionId: l.sessionId, prompt: [{ type: "text", text: body }] })
      .then((r) => {
        this.flushMessage(l);
        if (r.usage) this.ev.emit({ type: "usage", threadId: l.threadId, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens });
        const status = r.stopReason === "cancelled" ? "interrupted" : r.stopReason === "refusal" ? "failed" : "completed";
        this.ev.emit({
          type: "done",
          threadId: l.threadId,
          status,
          error: r.stopReason === "refusal" ? `${this.label} refused` : r.stopReason === "max_tokens" ? "stopped at the token limit" : undefined,
          durationMs: Date.now() - started,
        });
      })
      .catch((e) => {
        this.flushMessage(l);
        // JSON-RPC errors carry the real reason in data ("usage balance exhausted", auth...).
        const why = e?.data?.message ?? (typeof e?.data === "string" ? e.data : undefined) ?? e?.message ?? e;
        this.ev.emit({ type: "done", threadId: l.threadId, status: "failed", error: String(why).slice(0, 400) });
      })
      .finally(() => {
        l.running = false;
        this.cancelApprovals(l.threadId);
        const next = l.queue.shift();
        if (next !== undefined && this.live.has(l.threadId)) this.runTurn(l, next);
      });
  }

  async interrupt(threadId: string) {
    const l = this.live.get(threadId);
    if (!l || !this.conn) return;
    l.queue = [];
    this.cancelApprovals(threadId);
    await this.conn.cancel({ sessionId: l.sessionId }).catch(() => {});
  }

  // ---- approvals -------------------------------------------------------------------------------
  private onPermission(p: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const l = this.bySession.get(p.sessionId);
    if (!l || l.replaying) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    this.flushMessage(l);
    const requestId = `${this.o.id}:${++this.reqSeq}`;
    const tc = p.toolCall;
    const diff = (tc.content ?? []).find((c: any) => c.type === "diff") as any;
    const detail = diff
      ? editPreview("Edit", { file_path: diff.path, old_string: diff.oldText ?? "", new_string: diff.newText ?? "" }) ?? ""
      : rawSummary(tc.rawInput) || contentText(tc.content) || "";
    const kind = tc.kind === "edit" || tc.kind === "delete" || tc.kind === "move" ? "fileChange" : tc.kind === "execute" ? "command" : "tool";
    return new Promise((resolve) => {
      this.approvals.set(requestId, { threadId: l.threadId, sessionId: p.sessionId, options: p.options, resolve });
      this.ev.emit({
        type: "approval",
        threadId: l.threadId,
        requestId,
        kind,
        title: (tc.title || "Allow this?") + (this.o.approvalTimeoutSec ? ` (${this.label} says no by itself after ${this.o.approvalTimeoutSec}s)` : ""),
        detail,
        canAlways: p.options.some((o) => o.kind === "allow_always"),
      });
    });
  }

  respondApproval(_threadId: string, requestId: string, d: Decision) {
    const a = this.approvals.get(requestId);
    if (!a) return;
    this.approvals.delete(requestId);
    const want: acp.PermissionOptionKind[] =
      d === "allow" ? ["allow_once"] : d === "allowAlways" ? ["allow_always", "allow_once"] : ["reject_once", "reject_always"];
    // "Always" means for this session where the agent offers that (it may also offer "forever").
    const ranked = [...a.options].sort((x, y) => Number(/session/i.test(y.optionId + y.name)) - Number(/session/i.test(x.optionId + x.name)));
    const opt = want.map((k) => ranked.find((o) => o.kind === k)).find(Boolean);
    a.resolve(opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } });
    this.ev.emit({ type: "approvalResolved", threadId: a.threadId, requestId });
    if (d === "denyAndStop") this.interrupt(a.threadId).catch(() => {});
  }

  private cancelApprovals(threadId: string) {
    for (const [rid, a] of this.approvals) {
      if (a.threadId !== threadId) continue;
      this.approvals.delete(rid);
      a.resolve({ outcome: { outcome: "cancelled" } });
      this.ev.emit({ type: "approvalResolved", threadId, requestId: rid });
    }
  }

  // ---- streaming updates -----------------------------------------------------------------------
  private onUpdate(n: acp.SessionNotification) {
    const l = this.bySession.get(n.sessionId);
    if (!l || l.replaying) return;
    const u: any = n.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = u.content?.type === "text" ? u.content.text : "";
        if (!text) break;
        // A new messageId (when the agent sends them) starts a new bubble.
        if (u.messageId && l.msgId && !l.msgId.endsWith(`:${u.messageId}`)) this.flushMessage(l);
        if (!l.msgId) l.msgId = `${l.sessionId}:m${++l.msgSeq}${u.messageId ? `:${u.messageId}` : ""}`;
        l.msgText += text;
        this.ev.emit({ type: "delta", threadId: l.threadId, itemId: l.msgId, channel: "text", text });
        break;
      }
      case "agent_thought_chunk": {
        const text = u.content?.type === "text" ? u.content.text : "";
        if (!text) break;
        l.thoughtId ??= `${l.sessionId}:t${++l.msgSeq}`;
        this.ev.emit({ type: "delta", threadId: l.threadId, itemId: l.thoughtId, channel: "reasoning", text });
        break;
      }
      case "tool_call": {
        this.flushMessage(l);
        const name = toolName(u);
        l.tools.set(u.toolCallId, name);
        this.ev.emit({ type: "tool", threadId: l.threadId, toolId: u.toolCallId, phase: "started", name, summary: toolSummary(u) });
        if (u.status === "completed" || u.status === "failed") this.toolDone(l, u);
        break;
      }
      case "tool_call_update":
        if (u.status === "completed" || u.status === "failed") this.toolDone(l, u);
        break;
      case "plan": {
        const items: TodoItem[] = (u.entries ?? []).map((e: any) => ({
          text: String(e.content ?? ""),
          status: e.status === "completed" ? "completed" : e.status === "in_progress" ? "in_progress" : "pending",
        }));
        this.ev.emit({ type: "todo", threadId: l.threadId, items });
        break;
      }
      case "usage_update":
        this.ev.emit({
          type: "usage",
          threadId: l.threadId,
          contextWindow: u.size,
          inputTokens: u.used,
          costUsd: u.cost?.currency === "USD" ? u.cost.amount : undefined,
        });
        break;
      case "current_mode_update":
        if (l.modes) l.modes.currentModeId = u.currentModeId;
        else l.modes = { currentModeId: u.currentModeId, availableModes: [] };
        this.revertUnsafeMode(l);
        break;
      case "config_option_update":
        l.config = u.configOptions ?? l.config;
        this.learnModels(l);
        break;
      case "session_info_update":
        if (u.title) this.ev.emit({ type: "title", threadId: l.threadId, title: String(u.title).slice(0, 90) });
        break;
    }
  }

  private toolDone(l: Live, u: any) {
    const name = l.tools.get(u.toolCallId) ?? toolName(u);
    l.tools.delete(u.toolCallId);
    this.ev.emit({
      type: "tool",
      threadId: l.threadId,
      toolId: u.toolCallId,
      phase: "completed",
      name,
      summary: u.title ? toolSummary(u) : "",
      output: tail(contentText(u.content) || rawSummary(u.rawOutput)),
      ok: u.status !== "failed",
    });
  }

  private flushMessage(l: Live) {
    if (l.msgId && l.msgText) this.ev.emit({ type: "message", threadId: l.threadId, itemId: l.msgId, text: l.msgText });
    l.msgId = undefined;
    l.msgText = "";
    l.thoughtId = undefined;
  }

  // ---- modes and models ------------------------------------------------------------------------
  async setMode(threadId: string, mode: Mode) {
    const l = this.live.get(threadId);
    if (!l) return;
    l.mode = mode;
    await this.applyMode(l, mode);
  }

  /** Use the agent's safe mode for `mode`, or its ask mode when it has none. Throws when every
   * mode it offers acts without asking. */
  private async applyMode(l: Live, mode: Mode, announce = true) {
    const available = l.modes?.availableModes ?? [];
    if (!available.length || !this.conn) return;
    const exact = pickMode(available, mode);
    const id = exact ?? pickMode(available, "ask");
    if (!id) throw new Error(`it offers no other mode: ${available.map((m) => m.name || m.id).join(", ")}`);
    if (!exact && announce)
      this.ev.emit({ type: "error", threadId: l.threadId, message: `${this.label} has no "${mode}" mode; using ${modeName(l, id)}, which asks first.` });
    if (id === l.modes!.currentModeId) return;
    await this.conn.setSessionMode({ sessionId: l.sessionId, modeId: id });
    l.modes!.currentModeId = id;
  }

  /** The current mode's name when it lets the agent act without asking. */
  private unsafeMode(l: Live): string | undefined {
    const id = l.modes?.currentModeId;
    if (!id) return undefined;
    const m = l.modes?.availableModes?.find((x) => x.id === id) ?? { id, name: id };
    return isUnsafe(m) ? m.name || m.id : undefined;
  }

  /** The agent moved itself to a mode that skips approvals: move it back. If it won't go, stop the
   * turn and close the session (the next message reopens it, which fails while it stays unsafe). */
  private revertUnsafeMode(l: Live) {
    const unsafe = this.unsafeMode(l);
    if (!unsafe) return;
    this.ev.emit({ type: "error", threadId: l.threadId, message: `${this.label} switched itself to ${unsafe}, which acts without asking. Familiar is switching it back to a mode that asks first.` });
    this.applyMode(l, wanted(l), false)
      .then(() => {
        if (this.unsafeMode(l)) throw new Error(`still in ${this.unsafeMode(l)}`);
      })
      .catch((e) => {
        this.o.log(`[${this.o.id}] mode revert: ${e}`);
        if (this.live.get(l.threadId) !== l) return;
        this.ev.emit({ type: "error", threadId: l.threadId, message: `${this.label} wouldn't leave ${unsafe}, so Familiar stopped this turn and closed the session.` });
        this.interrupt(l.threadId).catch(() => {}); // sends the cancel before close() drops the session
        this.close(l.threadId).catch(() => {});
      });
  }

  async setModel(threadId: string, model: string) {
    const l = this.live.get(threadId);
    if (!l || !this.conn) return;
    const opt = modelOption(l.config);
    if (opt) {
      const r = await this.conn.setSessionConfigOption({ sessionId: l.sessionId, configId: opt.id, value: model } as any);
      l.config = (r as any)?.configOptions?.length ? (r as any).configOptions : l.config;
    } else if (l.models?.availableModels?.length) {
      await this.conn.request("session/set_model", { sessionId: l.sessionId, modelId: model });
      l.models.currentModelId = model;
    }
  }

  private currentModel(l: Live): string | undefined {
    const opt = modelOption(l.config) as any;
    return opt?.currentValue ? String(opt.currentValue) : l.models?.currentModelId;
  }

  private learnModels(l: Live) {
    const opt = modelOption(l.config) as any;
    const flat: { value: string; name?: string }[] = [];
    if (opt) {
      for (const o of opt.options ?? []) {
        if (Array.isArray(o.options)) flat.push(...o.options);
        else flat.push(o);
      }
    } else for (const m of l.models?.availableModels ?? []) flat.push({ value: m.modelId, name: m.name });
    const current = opt?.currentValue ?? l.models?.currentModelId;
    if (flat.length)
      this.st = { ...this.st, models: flat.map((m) => ({ id: String(m.value), label: m.name ?? String(m.value), isDefault: m.value === current })) };
  }

  async close(threadId: string) {
    const l = this.live.get(threadId);
    if (!l) return;
    this.live.delete(threadId);
    this.bySession.delete(l.sessionId);
    this.cancelApprovals(threadId);
    if ((this.caps.sessionCapabilities as any)?.close && this.conn) await this.conn.closeSession({ sessionId: l.sessionId }).catch(() => {});
  }

  async shutdown() {
    this.kill?.();
    this.kill = null;
    this.conn = null;
  }
}

/** The mode Familiar wants for this session: chats read-only ("plan"), quests their in-game mode. */
function wanted(l: Live): Mode {
  return l.chat ? "plan" : l.mode;
}

function modeName(l: Live, id: string): string {
  const m = l.modes?.availableModes?.find((x) => x.id === id);
  return m?.name || id;
}

function modelOption(config?: acp.SessionConfigOption[] | null) {
  return (config ?? []).find((c: any) => c.type === "select" && (c.category === "model" || c.id === "model"));
}

const KIND_NAME: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Mode",
};

function toolName(u: any): string {
  return u.name || KIND_NAME[u.kind] || "Tool";
}

function toolSummary(u: any): string {
  const t = String(u.title ?? "").split(/\r?\n/)[0];
  return t.length > 160 ? t.slice(0, 157) + "…" : t;
}

function contentText(content: any[] | undefined | null): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c.type === "content" && c.content?.type === "text" ? c.content.text : c.type === "diff" ? `${c.path}` : ""))
    .filter(Boolean)
    .join("\n");
}

function rawSummary(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 1).slice(0, 1500);
  } catch {
    return "";
  }
}

function tail(s?: string, n = 1200) {
  if (!s) return undefined;
  return s.length > n ? "…" + s.slice(-n) : s;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000}s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Never hand an agent an "approve everything" switch through the environment (HERMES_YOLO_MODE...). */
function safeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!/yolo|always.?approve|dangerously/i.test(k)) out[k] = v;
  return out;
}

/** A compact transcript the agent reads before continuing a conversation it can't resume. */
export function digest(hist: HistoryEntry[], maxChars = 6000): string {
  if (!hist.length) return "";
  const lines: string[] = [];
  for (const h of hist) {
    if (h.kind === "user") lines.push(`User: ${h.text.trim()}`);
    else if (h.kind === "assistant") lines.push(`You: ${h.text.trim()}`);
    else lines.push(`(tool ${h.name}: ${h.summary})`);
  }
  let body = lines.join("\n\n");
  if (body.length > maxChars) body = "…" + body.slice(-maxChars);
  return `This continues an earlier conversation you had with the user (most recent part below). Pick up where it left off.\n\n--- earlier conversation ---\n${body}\n--- end ---`;
}

/** Agents' stderr is chatty (Hermes logs every plugin at INFO): keep warnings and errors, one log
 * line per line, without colour codes, and collapse repeats. */
export class StderrFilter {
  private last = "";
  private repeats = 0;
  lines(chunk: string): string[] {
    const out: string[] = [];
    for (const raw of chunk.split(/\r?\n/)) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!line || /^(\S+\s+){0,3}\[?(INFO|DEBUG|TRACE)\]?\b/.test(line)) continue;
      if (line === this.last) {
        if (++this.repeats === 1) out.push("(repeating)");
        continue;
      }
      this.last = line;
      this.repeats = 0;
      out.push(line.length > 400 ? line.slice(0, 397) + "..." : line);
    }
    return out;
  }
}

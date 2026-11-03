// Codex backend: drives `codex.exe app-server` (the Codex desktop app's bundled binary or the Codex
// CLI) over JSON-RPC (one JSON object per line on stdio). Uses the user's existing ChatGPT login.
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
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
  ThreadInfo,
  TodoItem,
  truncatePreview,
} from "./types";
import { resolveCommand } from "./which";
import { StderrFilter } from "./acp";

/** The codex.exe to run, first found of: the `codexExe` override; `codex` on PATH — a winget/scoop
 * .exe as is, npm's codex.cmd shim resolved to the real binary in its package (spawn can't run a
 * .cmd without a shell); the newest one bundled with the desktop app. */
export function findCodexExe(override?: string): string | undefined {
  if (override && isFile(override)) return override;
  const cli = resolveCommand("codex");
  if (cli && /\.exe$/i.test(cli)) return cli;
  if (cli && /\.(cmd|bat)$/i.test(cli)) {
    const real = npmCodexExe(path.dirname(cli));
    if (real) return real;
  }
  return desktopCodexExe();
}

/** `npm i -g @openai/codex`: <shim dir>/node_modules/@openai/codex/node_modules/@openai/
 * codex-win32-<arch>/vendor/<target triple>/bin/codex.exe. */
function npmCodexExe(shimDir: string): string | undefined {
  const scope = path.join(shimDir, "node_modules", "@openai", "codex", "node_modules", "@openai");
  for (const arch of process.arch === "arm64" ? ["arm64", "x64"] : ["x64", "arm64"]) {
    const vendor = path.join(scope, `codex-win32-${arch}`, "vendor");
    for (const triple of readdir(vendor)) {
      const p = path.join(vendor, triple, "bin", "codex.exe");
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

/** Newest codex.exe shipped with the desktop app (its hash folder changes on update). */
function desktopCodexExe(): string | undefined {
  const base = path.join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  let best: { p: string; t: number } | undefined;
  for (const d of readdir(base)) {
    const p = path.join(base, d, "codex.exe");
    if (isFile(p)) {
      const t = fs.statSync(p).mtimeMs;
      if (!best || t > best.t) best = { p, t };
    }
  }
  return best?.p;
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return []; // not installed
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };

class Rpc {
  proc: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  onNotify: (method: string, params: any) => void = () => {};
  onRequest: (id: number | string, method: string, params: any) => void = () => {};
  onExit: (code: number | null) => void = () => {};

  constructor(exe: string, log: (s: string) => void) {
    this.proc = spawn(exe, ["app-server"], { stdio: "pipe", windowsHide: true, env: process.env });
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        log("[codex] non-json: " + line.slice(0, 200));
        return;
      }
      if (msg.id !== undefined && msg.method) this.onRequest(msg.id, msg.method, msg.params);
      else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      } else if (msg.method) this.onNotify(msg.method, msg.params);
    });
    const stderrFilter = new StderrFilter();
    this.proc.stderr.on("data", (d) => {
      for (const line of stderrFilter.lines(String(d))) log("[codex:stderr] " + line);
    });
    this.proc.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error("codex app-server exited"));
      this.pending.clear();
      this.onExit(code);
    });
  }

  request<T = any>(method: string, params: any, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: timeout`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params?: any) {
    this.write(params === undefined ? { method } : { method, params });
  }
  respond(id: number | string, result: any) {
    this.write({ id, result });
  }
  respondError(id: number | string, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }
  private write(o: any) {
    if (!this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(o) + "\n");
  }
  kill() {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

// approvalsReviewer is always sent: left out, Codex uses the user's own config.toml setting, which
// can hand approvals to its reviewer subagent instead of the player.
function modeParams(mode: Mode) {
  switch (mode) {
    case "ask":
      return { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    case "edits":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
    case "plan":
      return { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    case "auto":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
  }
}

/** Codex tools a chat never gets: the shell (both implementations) and the plugin, app, browser and
 * desktop-control tools. Codex has no approval policy that sends every command to the player
 * ("untrusted" still runs read-only commands, and reads can reach any file), so the shell is
 * switched off instead. MCP servers from the user's own Codex config are not switched off. */
const CHAT_TOOLS_OFF = { shell_tool: false, unified_exec: false, plugins: false, apps: false, browser_use: false, computer_use: false };

const PLAN_INSTRUCTIONS = "[Plan only: investigate and propose a concrete plan; do not modify files or run commands that change state.]";

interface Live {
  threadId: string;
  nativeId: string;
  cwd: string;
  mode: Mode;
  model?: string;
  turnId?: string;
  modeDirty: boolean;
  chat?: ChatOptions;
  releaseTimer?: NodeJS.Timeout;
}

/** How long a finished thread stays loaded here. Loaded, Familiar is its writer and the Codex app
 * can't continue it ("active writer"); released, the next turn here resumes it again (~1 s). */
const RELEASE_MS = 30_000;

interface PendingApproval {
  rpcId: number | string;
  threadId: string;
  method: string;
}

export class CodexBackend implements AgentBackend {
  readonly kind = "codex" as const;
  private rpc: Rpc | null = null;
  private ev = new Emitter<AgentEvent>();
  private live = new Map<string, Live>(); // hub threadId -> live
  private byNative = new Map<string, string>(); // nativeId -> hub threadId
  private approvals = new Map<string, PendingApproval>();
  private st: BackendStatus = { ready: false, models: [] };
  private starting: Promise<BackendStatus> | null = null;
  private spawn = "0"; // per app-server process; JSON-RPC ids restart at 1 on every spawn

  constructor(private opts: { exe?: string; log: (s: string) => void; version: string }) {}

  on(h: (e: AgentEvent) => void) {
    return this.ev.on(h);
  }
  status() {
    return this.st;
  }

  isOpen(threadId: string) {
    return this.live.has(threadId);
  }

  /** The Codex app-server that has a thread loaded holds `<CODEX_HOME>/thread-writer-locks/<id>.lock`
   * (any other writer gets "active writer"). A lock Familiar's own app-server holds isn't elsewhere. */
  heldElsewhere(nativeId: string) {
    if (this.byNative.has(nativeId)) return false;
    return fs.existsSync(path.join(codexHome(), "thread-writer-locks", `${nativeId}.lock`));
  }

  async handOff(threadId: string | undefined, nativeId: string) {
    if (threadId) await this.close(threadId); // unsubscribes, so this app-server drops the lock
    return `codex://threads/${encodeURIComponent(nativeId)}`;
  }

  init(): Promise<BackendStatus> {
    if (this.starting) return this.starting;
    this.starting = this.doInit().catch((e) => {
      this.st = { ready: false, models: [], error: String(e?.message ?? e) };
      this.starting = null;
      return this.st;
    });
    return this.starting;
  }

  private async doInit(): Promise<BackendStatus> {
    const exe = findCodexExe(this.opts.exe);
    if (!exe) throw new Error("codex.exe not found (install the Codex app or run: npm i -g @openai/codex)");
    const rpc = new Rpc(exe, this.opts.log);
    this.rpc = rpc;
    this.spawn = Date.now().toString(36);
    rpc.onNotify = (m, p) => this.onNotify(m, p);
    rpc.onRequest = (id, m, p) => this.onRequest(id, m, p);
    rpc.onExit = (code) => {
      this.opts.log(`[codex] app-server exited (${code})`);
      this.rpc = null;
      this.starting = null;
      this.st = { ...this.st, ready: false, error: "app-server exited" };
      for (const l of this.live.values()) {
        if (l.turnId) this.ev.emit({ type: "done", threadId: l.threadId, status: "failed", error: "Codex app-server exited" });
      }
      for (const [rid, a] of this.approvals) this.ev.emit({ type: "approvalResolved", threadId: a.threadId, requestId: rid });
      this.live.clear();
      this.byNative.clear();
      this.approvals.clear();
    };
    await rpc.request("initialize", {
      clientInfo: { name: "familiar_wow", title: "Familiar (WoW)", version: this.opts.version },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ["mcpServer/startupStatus/updated", "account/rateLimits/updated", "remoteControl/status/changed"],
      },
    });
    rpc.notify("initialized");
    let account: string | undefined;
    try {
      const a = await rpc.request("account/read", {});
      account = a?.account ? `${a.account.type}${a.account.planType ? " " + a.account.planType : ""}` : "signed out";
    } catch (e: any) {
      account = "unknown";
    }
    let models: BackendStatus["models"] = [];
    try {
      const m = await rpc.request("model/list", { limit: 50 });
      models = (m?.data ?? [])
        .filter((x: any) => !x.hidden)
        .map((x: any) => ({ id: x.id ?? x.model, label: x.displayName ?? x.model, isDefault: !!x.isDefault }));
    } catch {
      /* optional */
    }
    this.st = { ready: true, account, models };
    return this.st;
  }

  private async ensure(): Promise<Rpc> {
    if (!this.rpc || !this.st.ready) await this.init();
    if (!this.rpc) throw new Error(this.st.error ?? "codex unavailable");
    return this.rpc;
  }

  async archive(nativeId: string, archived: boolean): Promise<boolean> {
    const rpc = await this.ensure();
    await rpc.request(archived ? "thread/archive" : "thread/unarchive", { threadId: nativeId });
    return true;
  }

  async listProjects() {
    const rpc = await this.ensure();
    try {
      const r = await rpc.request("project/list", { limit: 100, sortKey: "recencyAt" });
      return (r?.data ?? [])
        .filter((p: any) => p.roots?.[0]?.path)
        .map((p: any) => ({ name: p.name, path: p.roots[0].path, lastActivity: toMs(p.recencyAt) }));
    } catch {
      return [];
    }
  }

  async listThreads(q: { cwd?: string; limit?: number }): Promise<ThreadInfo[]> {
    const rpc = await this.ensure();
    // Interactive (desktop + CLI) and not archived: the threads the Codex app itself lists.
    // `codex exec` one-shots, sub-agents and reviews are other source kinds and stay out.
    const r = await rpc.request("thread/list", {
      limit: q.limit ?? 40,
      sortKey: "updated_at",
      sortDirection: "desc",
      useStateDbOnly: true,
      archived: false,
      sourceKinds: ["vscode", "cli"],
      ...(q.cwd ? { cwd: q.cwd } : {}),
    });
    return (r?.data ?? []).map((t: any) => ({ ...threadInfo(t), open: this.heldElsewhere(t.id) }));
  }

  async readHistory(nativeId: string, _cwd?: string, limit = 12): Promise<HistoryEntry[]> {
    const rpc = await this.ensure();
    const r = await rpc.request("thread/turns/list", { threadId: nativeId, limit, sortDirection: "desc", itemsView: "full" });
    const turns = (r?.data ?? []).slice().reverse();
    const out: HistoryEntry[] = [];
    for (const turn of turns) {
      for (const it of turn.items ?? []) {
        const e = itemToHistory(it);
        if (e) out.push(e);
      }
    }
    return out;
  }

  async open(o: StartOptions): Promise<string> {
    const rpc = await this.ensure();
    const mp = modeParams(o.mode);
    let res: any;
    const common = o.chat
      ? {
          // Chat: live web search, no shell, read-only sandbox, standing chat instructions. Anything
          // Codex still asks about comes to the game as an approval card.
          cwd: o.cwd,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "read-only",
          developerInstructions: o.chat.instructions,
          config: { web_search: "live", features: CHAT_TOOLS_OFF },
          ...(o.model ? { model: o.model } : {}),
        }
      : {
          cwd: o.cwd,
          approvalPolicy: mp.approvalPolicy,
          approvalsReviewer: mp.approvalsReviewer,
          sandbox: mp.sandbox,
          ...(o.model ? { model: o.model } : {}),
        };
    if (o.resumeNativeId && o.fork) {
      res = await rpc.request("thread/fork", { threadId: o.resumeNativeId });
      res = await rpc.request("thread/resume", { threadId: res.thread.id, ...common, excludeTurns: true });
    } else if (o.resumeNativeId) {
      try {
        res = await rpc.request("thread/resume", { threadId: o.resumeNativeId, ...common, excludeTurns: true });
      } catch (e: any) {
        // Another Codex (usually the desktop app) has this thread open and owns writing to it:
        // continue a copy instead of failing.
        if (!/active writer/i.test(String(e?.message ?? e))) throw e;
        const forked = await rpc.request("thread/fork", { threadId: o.resumeNativeId });
        res = await rpc.request("thread/resume", { threadId: forked.thread.id, ...common, excludeTurns: true });
        this.ev.emit({
          type: "notice",
          threadId: o.threadId,
          message: "Codex has this conversation open (probably in its desktop app), so Familiar continues a copy (fork). Replies show here.",
        });
      }
    } else {
      res = await rpc.request("thread/start", {
        ...common,

      });
    }
    const nativeId: string = res.thread.id;
    this.live.set(o.threadId, { threadId: o.threadId, nativeId, cwd: o.cwd, mode: o.mode, model: res.model, modeDirty: false, chat: o.chat });
    this.byNative.set(nativeId, o.threadId);
    this.ev.emit({ type: "session", threadId: o.threadId, nativeId, model: res.model });
    return nativeId;
  }

  async send(threadId: string, text: string): Promise<void> {
    const rpc = await this.ensure();
    const l = this.live.get(threadId);
    if (!l) throw new Error("thread not open");
    if (l.releaseTimer) clearTimeout(l.releaseTimer);
    // Plan mode: read-only sandbox plus a per-turn note (developer instructions would stick forever).
    const body = l.mode === "plan" && !l.chat ? `${PLAN_INSTRUCTIONS}\n\n${text}` : text;
    const input = [{ type: "text", text: body, text_elements: [] }];
    if (l.turnId) {
      await rpc.request("turn/steer", { threadId: l.nativeId, input, expectedTurnId: l.turnId });
      return;
    }
    const mp = modeParams(l.mode);
    const params: any = { threadId: l.nativeId, input };
    if (l.chat?.effort) params.effort = l.chat.effort;
    if (l.modeDirty && !l.chat) {
      params.approvalPolicy = mp.approvalPolicy;
      params.sandboxPolicy = mp.sandboxPolicy;
      params.approvalsReviewer = mp.approvalsReviewer;
      l.modeDirty = false;
    }
    if (l.model) params.model = l.model;
    const r = await rpc.request("turn/start", params);
    l.turnId = r?.turn?.id ?? l.turnId;
  }

  async interrupt(threadId: string) {
    const l = this.live.get(threadId);
    if (!l?.turnId || !this.rpc) return;
    await this.rpc.request("turn/interrupt", { threadId: l.nativeId, turnId: l.turnId }).catch(() => {});
  }

  respondApproval(_threadId: string, requestId: string, d: Decision) {
    const a = this.approvals.get(requestId);
    if (!a || !this.rpc) return;
    this.approvals.delete(requestId);
    const decision = d === "allow" ? "accept" : d === "allowAlways" ? "acceptForSession" : d === "deny" ? "decline" : "cancel";
    if (a.method === "item/permissions/requestApproval") {
      this.rpc.respond(a.rpcId, d === "allow" || d === "allowAlways" ? { permissions: {}, scope: d === "allowAlways" ? "session" : "turn" } : { permissions: {}, scope: "turn" });
    } else if (a.method === "mcpServer/elicitation/request") {
      this.rpc.respond(a.rpcId, { action: d === "allow" || d === "allowAlways" ? "accept" : d === "deny" ? "decline" : "cancel", content: null, _meta: null });
    } else {
      this.rpc.respond(a.rpcId, { decision });
    }
    this.ev.emit({ type: "approvalResolved", threadId: a.threadId, requestId });
  }

  async setMode(threadId: string, mode: Mode) {
    const l = this.live.get(threadId);
    if (l) {
      l.mode = mode;
      l.modeDirty = true;
    }
  }

  async setModel(threadId: string, model: string) {
    const l = this.live.get(threadId);
    if (l) l.model = model;
  }

  async close(threadId: string) {
    const l = this.live.get(threadId);
    if (!l) return;
    if (l.releaseTimer) clearTimeout(l.releaseTimer);
    this.live.delete(threadId);
    this.byNative.delete(l.nativeId);
    await this.rpc?.request("thread/unsubscribe", { threadId: l.nativeId }).catch(() => {});
  }

  async shutdown() {
    this.rpc?.kill();
    this.rpc = null;
  }

  // ---- inbound -------------------------------------------------------------------------------
  private hub(nativeId?: string): string | undefined {
    return nativeId ? this.byNative.get(nativeId) : undefined;
  }

  private onNotify(method: string, p: any) {
    const threadId = this.hub(p?.threadId ?? p?.thread?.id);
    if (!threadId) return;
    const l = this.live.get(threadId);
    switch (method) {
      case "turn/started":
        if (l) l.turnId = p.turn?.id;
        this.ev.emit({ type: "turnStarted", threadId });
        break;
      case "turn/completed": {
        if (l) {
          l.turnId = undefined;
          if (l.releaseTimer) clearTimeout(l.releaseTimer);
          l.releaseTimer = setTimeout(() => {
            if (this.live.get(threadId) === l && !l.turnId && ![...this.approvals.values()].some((a) => a.threadId === threadId)) void this.close(threadId);
          }, RELEASE_MS);
        }
        const st = p.turn?.status;
        this.ev.emit({
          type: "done",
          threadId,
          status: st === "interrupted" ? "interrupted" : st === "failed" ? "failed" : "completed",
          error: p.turn?.error ? String(p.turn.error.message ?? p.turn.error) : undefined,
          durationMs: p.turn?.durationMs,
        });
        break;
      }
      case "item/agentMessage/delta":
        this.ev.emit({ type: "delta", threadId, itemId: p.itemId, channel: "text", text: p.delta ?? "" });
        break;
      case "item/reasoning/summaryTextDelta":
        this.ev.emit({ type: "delta", threadId, itemId: p.itemId, channel: "reasoning", text: p.delta ?? "" });
        break;
      case "item/started":
      case "item/completed": {
        const it = p.item;
        if (!it) break;
        if (it.type === "agentMessage" && method === "item/completed") {
          this.ev.emit({ type: "message", threadId, itemId: it.id, text: it.text ?? "" });
        } else if (TOOL_TYPES.has(it.type)) {
          const t = toolOf(it);
          this.ev.emit({
            type: "tool",
            threadId,
            toolId: it.id,
            phase: method === "item/started" ? "started" : "completed",
            name: t.name,
            summary: t.summary,
            output: method === "item/completed" ? t.output : undefined,
            ok: method === "item/completed" ? t.ok : undefined,
          });
        }
        break;
      }
      case "turn/plan/updated": {
        const items: TodoItem[] = (p.plan ?? []).map((s: any) => ({
          text: s.step,
          status: s.status === "inProgress" ? "in_progress" : s.status === "completed" ? "completed" : "pending",
        }));
        this.ev.emit({ type: "todo", threadId, items, explanation: p.explanation ?? undefined });
        break;
      }
      case "thread/tokenUsage/updated": {
        const u = p.tokenUsage;
        this.ev.emit({
          type: "usage",
          threadId,
          inputTokens: u?.total?.inputTokens ?? u?.last?.inputTokens,
          outputTokens: u?.total?.outputTokens ?? u?.last?.outputTokens,
          contextWindow: u?.modelContextWindow,
        });
        break;
      }
      case "thread/name/updated":
        if (p.name) this.ev.emit({ type: "title", threadId, title: p.name });
        break;
      case "error":
        if (!p.willRetry) this.ev.emit({ type: "error", threadId, message: String(p.error?.message ?? p.error ?? "error") });
        break;
      case "serverRequest/resolved":
        for (const [rid, a] of this.approvals) {
          if (String(a.rpcId) === String(p.requestId)) {
            this.approvals.delete(rid);
            this.ev.emit({ type: "approvalResolved", threadId: a.threadId, requestId: rid });
          }
        }
        break;
    }
  }

  private onRequest(id: number | string, method: string, p: any) {
    const threadId = this.hub(p?.threadId);
    const requestId = `codex:${this.spawn}:${id}`;
    if (!threadId) {
      this.rpc?.respondError(id, "unknown thread");
      return;
    }
    switch (method) {
      case "item/commandExecution/requestApproval":
        this.approvals.set(requestId, { rpcId: id, threadId, method });
        this.ev.emit({
          type: "approval",
          threadId,
          requestId,
          kind: "command",
          title: "Run command?",
          detail: [p.command ?? "(command)", p.reason ? `Reason: ${p.reason}` : "", p.cwd ? `in ${p.cwd}` : ""].filter(Boolean).join("\n"),
          canAlways: true,
        });
        break;
      case "item/fileChange/requestApproval":
        this.approvals.set(requestId, { rpcId: id, threadId, method });
        this.ev.emit({
          type: "approval",
          threadId,
          requestId,
          kind: "fileChange",
          title: "Apply file changes?",
          detail: [p.reason ?? "", p.grantRoot ? `Grant write access under ${p.grantRoot}` : ""].filter(Boolean).join("\n") || "Codex wants to edit files.",
          canAlways: true,
        });
        break;
      case "item/permissions/requestApproval":
      case "mcpServer/elicitation/request":
        this.approvals.set(requestId, { rpcId: id, threadId, method });
        this.ev.emit({
          type: "approval",
          threadId,
          requestId,
          kind: "permissions",
          title: method === "mcpServer/elicitation/request" ? "Tool needs input" : "Grant permissions?",
          detail: truncatePreview(JSON.stringify(p?.permissions ?? p?.message ?? p, null, 1), 600),
          canAlways: method === "item/permissions/requestApproval",
        });
        break;
      default:
        // Unknown server requests must be answered or the turn hangs.
        this.rpc?.respondError(id, `familiar does not support ${method}`);
    }
  }
}

/** Shorten `"C:\...\pwsh.exe" -NoProfile -Command "..."` style commands for display. */
export function prettyCommand(cmd: string): string {
  // Codex reports some paths with doubled backslashes; collapse them for display.
  let c = String(cmd ?? "").replace(/\\\\/g, "\\");
  c = c.replace(/^"?[A-Za-z]:\\[^"]*?\\(pwsh|powershell|cmd|bash|sh)(?:\.exe)?"?\s+/i, "$1 ");
  c = c.replace(/^(?:pwsh|powershell) (?:-NoLogo |-NoProfile |-NonInteractive )*-Command /i, "");
  c = c.replace(/^cmd \/[cC] /i, "");
  if (/^"(.*)"$/s.test(c)) c = c.slice(1, -1);
  return c;
}

const TOOL_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall", "imageView"]);

function toolOf(it: any): { name: string; summary: string; output?: string; ok?: boolean } {
  switch (it.type) {
    case "commandExecution":
      return {
        name: "Shell",
        summary: prettyCommand(it.command ?? "").slice(0, 160),
        output: tail(it.aggregatedOutput),
        ok: it.exitCode === undefined || it.exitCode === null ? it.status !== "failed" : it.exitCode === 0,
      };
    case "fileChange": {
      const files = (it.changes ?? []).map((c: any) => `${c.kind?.type ?? "edit"} ${path.basename(c.path ?? "")}`);
      return { name: "Edit", summary: files.join(", ").slice(0, 160) || "files", ok: it.status !== "failed", output: tail((it.changes ?? []).map((c: any) => c.diff ?? "").join("\n")) };
    }
    case "mcpToolCall":
      return { name: `${it.server}.${it.tool}`, summary: JSON.stringify(it.arguments ?? {}).slice(0, 160), ok: !it.error, output: tail(it.error ? String(it.error.message ?? it.error) : JSON.stringify(it.result ?? "")) };
    case "webSearch":
      // The query is often only known once the search ran (action.query / queries / opened url).
      return {
        name: "Web search",
        summary: String(it.query || it.action?.query || it.action?.queries?.join(" · ") || it.action?.url || ""),
        ok: true,
      };
    default:
      return { name: it.type, summary: "", ok: it.status !== "failed" };
  }
}

function itemToHistory(it: any): HistoryEntry | null {
  if (it.type === "userMessage") {
    const text = (it.content ?? []).map((c: any) => c.text ?? "").join("");
    return { kind: "user", text };
  }
  if (it.type === "agentMessage") return { kind: "assistant", text: it.text ?? "" };
  if (TOOL_TYPES.has(it.type)) {
    const t = toolOf(it);
    return { kind: "tool", name: t.name, summary: t.summary, ok: t.ok, output: t.output };
  }
  return null;
}

function threadInfo(t: any): ThreadInfo {
  const title = t.name || firstLine(t.preview);
  return {
    nativeId: t.id,
    agent: "codex",
    cwd: String(t.cwd ?? "").replace(/^\\\\\?\\/, ""),
    title: title || "(untitled)",
    createdAt: toMs(t.createdAt),
    updatedAt: toMs(t.recencyAt ?? t.updatedAt) ?? 0,
    model: t.model,
    origin: t.source === "cli" ? "cli" : t.source === "vscode" ? "desktop" : typeof t.source === "string" ? t.source : undefined,
    running: t.status?.type === "active",
    // listThreads fills this in from the writer locks (heldElsewhere).
    open: false,
    automated: !!t.parentThreadId || !!t.ephemeral || !title,
  };
}

function toMs(v: any): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? undefined : n;
}

function firstLine(s?: string) {
  return (s ?? "").split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 80);
}

function tail(s?: string, n = 1200) {
  if (!s) return undefined;
  return s.length > n ? "…" + s.slice(-n) : s;
}

/** Where Codex keeps its state (rollouts, writer locks): CODEX_HOME, else ~/.codex. */
function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

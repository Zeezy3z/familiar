// Unified agent backend interface. Both Claude (Agent SDK) and Codex (app-server) adapt to this.

/** Provider id: "claude", "codex", or an ACP agent id ("hermes", "grok", ...). See providers.ts. */
export type AgentKind = string;

/** Permission posture, cycled in-game. Mapped per backend (see claude.ts / codex.ts). */
export type Mode = "ask" | "edits" | "plan" | "auto";
export const MODES: Mode[] = ["ask", "edits", "plan", "auto"];
/** Modes the in-game Mode key cycles through. Accept edits and Auto are chosen only in the control panel. */
export const GAME_MODES: Mode[] = ["ask", "plan"];
export const MODE_LABEL: Record<Mode, string> = {
  ask: "Ask first",
  edits: "Accept edits",
  plan: "Plan only",
  auto: "Auto",
};

export type Decision = "allow" | "allowAlways" | "deny" | "denyAndStop";

export interface ThreadInfo {
  nativeId: string;
  agent: AgentKind;
  cwd: string;
  title: string;
  createdAt?: number;
  updatedAt: number;
  model?: string;
  origin?: string; // "desktop" | "cli" | ...
  /** Folder the thread belongs to when cwd is a worktree of it (zone grouping only). */
  projectCwd?: string;
  /** Archived in the agent's own desktop app. */
  archived?: boolean;
  /** Starred/pinned in the agent's own desktop app. */
  starred?: boolean;
  /** Working right now in another process (desktop app, CLI). */
  running?: boolean;
  /** Open in another process right now (a desktop-app tab, a terminal), which owns writing to it,
   * so continuing it elsewhere needs a copy (fork). Undefined: the agent can't tell. */
  open?: boolean;
  /** Not something the user started by hand: scheduled task, script, sub-agent, empty session. */
  automated?: boolean;
  /** The mode the agent's own app last used for it, made safe for the game (modes that skip asking
   * become Ask first). Absent: none recorded, so Familiar's default applies. */
  mode?: Mode;
}

export interface TodoItem {
  id?: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export type HistoryEntry =
  | { kind: "user"; text: string; at?: number }
  | { kind: "assistant"; text: string; at?: number }
  | { kind: "tool"; name: string; summary: string; ok?: boolean; output?: string };

export type AgentEvent =
  | { type: "session"; threadId: string; nativeId: string; model?: string }
  | { type: "turnStarted"; threadId: string }
  | { type: "delta"; threadId: string; itemId: string; channel: "text" | "reasoning"; text: string }
  | { type: "message"; threadId: string; itemId: string; text: string }
  | {
      type: "tool";
      threadId: string;
      toolId: string;
      phase: "started" | "completed";
      name: string;
      summary: string;
      output?: string;
      ok?: boolean;
    }
  | { type: "todo"; threadId: string; items: TodoItem[]; explanation?: string }
  | {
      type: "approval";
      threadId: string;
      requestId: string;
      kind: "command" | "fileChange" | "tool" | "question" | "permissions" | "planExit";
      title: string;
      detail: string;
      canAlways: boolean;
      options?: string[]; // multiple-choice answers (Claude AskUserQuestion)
      /** `detail` is a cut preview: the whole request is `full`, and only the control panel approves it. */
      cut?: boolean;
      full?: string;
    }
  | { type: "approvalResolved"; threadId: string; requestId: string }
  | { type: "usage"; threadId: string; inputTokens?: number; outputTokens?: number; contextWindow?: number; costUsd?: number }
  | { type: "title"; threadId: string; title: string }
  | { type: "mode"; threadId: string; mode: Mode }
  | { type: "done"; threadId: string; status: "completed" | "interrupted" | "failed"; error?: string; durationMs?: number }
  | { type: "error"; threadId?: string; message: string }
  | { type: "notice"; threadId: string; message: string };

export interface StartOptions {
  threadId: string; // hub id, used to tag events
  cwd: string;
  mode: Mode;
  model?: string;
  resumeNativeId?: string; // continue an existing session/thread
  fork?: boolean; // fork instead of resume (safe when the original may be live elsewhere)
  /** A chat (no repo): web search, no shell or project files, these standing instructions. */
  chat?: ChatOptions;
}

export interface ChatOptions {
  instructions: string;
  /** Reasoning effort ("low", "medium", ...); ignored by models without an effort setting. */
  effort?: string;
}

export interface BackendStatus {
  ready: boolean;
  account?: string; // plan label only; never email/tokens
  models: { id: string; label: string; isDefault?: boolean }[];
  error?: string;
  /** Why it can't start, in Familiar's own words, safe to show and save as is (unlike error). */
  setup?: string;
}

export interface AgentBackend {
  readonly kind: AgentKind;
  init(): Promise<BackendStatus>;
  status(): BackendStatus;
  listThreads(q: { cwd?: string; limit?: number }): Promise<ThreadInfo[]>;
  listProjects?(): Promise<{ name: string; path: string; lastActivity?: number }[]>;
  readHistory(nativeId: string, cwd?: string, limit?: number): Promise<HistoryEntry[]>;
  /** Whether the backend currently holds this thread open (false after a backend restart). */
  isOpen(threadId: string): boolean;
  /** Whether the agent's own app (or a terminal) has this conversation open right now and owns
   * writing to it. Absent: the agent can't tell. */
  heldElsewhere?(nativeId: string): boolean;
  /** "Continue in <app>": let go of Familiar's own session for the quest (if any), then return the
   * link that opens the same conversation in the agent's own app. Absent: the agent has no app. */
  handOff?(threadId: string | undefined, nativeId: string): Promise<string>;
  /** Open (start or resume) a thread. Returns the native id once known. */
  open(o: StartOptions): Promise<string>;  send(threadId: string, text: string): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  respondApproval(threadId: string, requestId: string, d: Decision): void;
  answerQuestion?(threadId: string, requestId: string, label: string): void;
  setMode(threadId: string, mode: Mode): Promise<void>;
  setModel(threadId: string, model: string): Promise<void>;
  close(threadId: string): Promise<void>;
  /** Archive (or restore) a session in the agent's own app. Resolves true when the app recorded
   * it; absent or false when the agent has no way for other apps to archive. */
  archive?(nativeId: string, archived: boolean): Promise<boolean>;
  shutdown(): Promise<void>;
  on(h: (e: AgentEvent) => void): () => void;
}

export class Emitter<T> {
  private hs = new Set<(e: T) => void>();
  on(h: (e: T) => void) {
    this.hs.add(h);
    return () => this.hs.delete(h);
  }
  emit(e: T) {
    for (const h of this.hs) {
      try {
        h(e);
      } catch (err) {
        console.error("[emitter]", err);
      }
    }
  }
}

/** The most of a cut request an approval event carries for the control panel. */
export const FULL_CAP = 200_000;

/** An approval event's text: the card's `preview` and, when that is not the whole request, `cut`
 * plus the whole text (`full`, itself capped at FULL_CAP and saying so). A cut request is approved
 * only in the control panel, where `full` is shown; the game can only deny it. */
export function approvalText(preview: string, whole: string): { detail: string; cut?: true; full?: string } {
  if (preview === whole) return { detail: preview };
  return { detail: preview, cut: true, full: whole.length > FULL_CAP ? `${whole.slice(0, FULL_CAP)}\n… (truncated at 200k)` : whole };
}

/** Keep provider preview limits explicit; expanding Glass cannot restore the omitted text. */
export function truncatePreview(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (${text.length - maxChars} characters omitted from this preview)` : text;
}

/** Unified-diff-ish preview of a Claude Edit/MultiEdit/Write tool call (for approvals and expansion). */
export function editPreview(name: string, input: any, maxLines = 60): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const lines: string[] = [];
  const add = (prefix: string, text: string) => {
    for (const l of String(text ?? "").split(/\r?\n/)) lines.push(prefix + l);
  };
  if (name === "Edit" && input.old_string !== undefined) {
    add("-", input.old_string);
    add("+", input.new_string);
  } else if (name === "MultiEdit" && Array.isArray(input.edits)) {
    for (const e of input.edits) {
      add("-", e.old_string);
      add("+", e.new_string);
      lines.push("…");
    }
  } else if (name === "Write" && typeof input.content === "string") {
    add("+", input.content);
  } else return undefined;
  const head = `${input.file_path ?? ""}`;
  const body = lines.length > maxLines ? [...lines.slice(0, maxLines), `… (${lines.length - maxLines} lines omitted from this preview)`] : lines;
  return [head, ...body].join("\n");
}

/** The field that says what a tool call does (command, path, query...), in full. */
function toolText(name: string, input: any): string {
  if (!input || typeof input !== "object") return name;
  const s =
    input.command ??
    input.cmd ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.url ??
    input.query ??
    input.description ??
    input.subject ??
    input.prompt;
  return typeof s === "string" ? s : Array.isArray(s) ? s.join(" ") : JSON.stringify(input);
}

/** One-line description of a tool call for the transcript. */
export function summarizeTool(name: string, input: any): string {
  const text = toolText(name, input);
  return text.length > 160 ? text.slice(0, 157) + "…" : text;
}

/** What an approval card shows for a tool call: the whole request, never the transcript's short
 * summary; past `maxChars` the cut is marked (truncatePreview), so the card can warn about it. */
export function approvalDetail(name: string, input: any, maxChars = 4000): string {
  return truncatePreview(toolText(name, input), maxChars);
}

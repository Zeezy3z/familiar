// The Hub: single source of truth for quests (threads), zones (projects), selection, approvals and
// toasts. Addon events come in (from the Runestrip), agent events come in (from backends), and a
// render model goes out to the Glass overlay and the native snapshot writer.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { attentionEntry, attentionRevision } from "./attention";
import { INTERRUPTED_NOTE, STOPPED_NOTE, STOPPING_NOTE } from "../shared/notes";
import {
  AgentBackend,
  AgentEvent,
  AgentKind,
  Decision,
  HistoryEntry,
  GAME_MODES,
  Mode,
  MODE_LABEL,
  ThreadInfo,
  TodoItem,
} from "../agents/types";
import { appDataDir, Config, isExcluded, normPath } from "./config";
import { redact } from "../main/log-file";
import { NO_PROOF, Proof } from "../main/physical";
import { storageCode, ThreadStore } from "./storage";
import { providerLabel } from "../agents/providers";
import { ClaudeBackend } from "../agents/claude";
import { CodexBackend } from "../agents/codex";
import { providerAvailable } from "../agents/setup";
import { CHAT_INSTRUCTIONS, withGameContext } from "./chat";
import { CHATS_KEY, Project, ProjectRegistry, projectRootOf } from "./projects";
import { SUGGEST_TOAST, suggestionUrl, type SuggestVersions } from "./suggest";
import { TUTORIAL_AGENT, TUTORIAL_NO_MODE, tutorialDecide, tutorialReply, tutorialSetOut, tutorialThread } from "./tutorial";

export type EntryKind = "user" | "assistant" | "reasoning" | "tool" | "approval" | "notice";

export interface Entry {
  id: string;
  kind: EntryKind;
  text: string;
  at: number;
  streaming?: boolean;
  // tool
  name?: string;
  status?: "running" | "ok" | "error" | "unknown";
  output?: string;
  // approval
  requestId?: string;
  title?: string;
  approval?: "pending" | "approved" | "denied" | "always" | "expired";
  canAlways?: boolean;
  options?: string[];
  /** approval: the card's text is a cut preview; `full` is the whole request, approved only on the PC. */
  cut?: boolean;
  full?: string;
  /** approval: why the last approving click or key was refused (shown on the card until a decision). */
  refused?: { why: Refusal; at: number };
  level?: "info" | "error";
}

/** Why the hub refused an approving decision: no proof of real input, a card too fresh to have
 * been read, a cut request (approved only in the control panel), or an unknown view context. */
export type Refusal = "proof" | "fresh" | "cut" | "view";
/** Where a decision came from: the game (Glass card, keys) or the desktop control panel. */
export type DecisionOrigin = "game" | "panel";

export type ThreadStatus = "idle" | "running" | "approval" | "error" | "new";

export interface Thread {
  id: string;
  agent: AgentKind;
  nativeId?: string;
  cwd: string;
  projectKey: string;
  title: string;
  status: ThreadStatus;
  mode: Mode;
  model?: string;
  entries: Entry[];
  todos: TodoItem[];
  todoNote?: string;
  createdAt: number;
  updatedAt: number;
  unread: boolean;
  /** Revision of the last saved attention event explicitly acknowledged in catch-up notes. */
  attentionSeen?: string | null;
  origin: "familiar" | "external";
  /** "chat": no repo, web search only (the Chats zone). "tutorial": A Familiar Face, answered by
   * the hub itself (hub/tutorial.ts), no backend. */
  kind?: "chat" | "tutorial";
  /** The quest log this chat's model last saw (it is only re-sent when it changed). */
  questsSent?: string;
  /** The desktop/CLI session this quest continues (a fork has its own id): that session's entry
   * is no longer listed separately, so continuing asks only once. */
  adoptedFrom?: string;
  /** The next backend open must continue a copy rather than the original native session. */
  fork?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; contextWindow?: number; costUsd?: number };
  lastError?: string;
}

export interface ExternalThread extends ThreadInfo {
  projectKey: string;
  /** Why it is listed: pinned (in Familiar or starred in the desktop app), running now, or recent. */
  reason: "pinned" | "running" | "recent";
}

export interface Toast {
  id: number;
  text: string;
  kind: "done" | "approval" | "error" | "info";
  at: number;
  threadId?: string;
  /** Text shown instead in private mode (no project, title, command or reply). Without it,
   * private mode shows a generic line per kind (see privateToast in viewmodel.ts). */
  generic?: string;
  /** approval: the request it is about (main raises one Windows notice per request). */
  requestId?: string;
}

export interface View {
  list: "quests" | "pick";
  pickAgent: AgentKind;
  selected?: string; // hub thread id, or "ext:<agent>:<nativeId>"
  draft?: { agent: AgentKind; cwd: string; projectKey: string; mode: Mode; model?: string; chat?: boolean };
  collapsed: Set<string>;
  expanded: Set<string>; // tool and approval-preview entry ids
  native: boolean;
  /** A message waiting for the user to confirm continuing a desktop-app conversation. */
  confirm?: { extId: string; text: string };
  /** A message held back because the agent's own app has the quest's conversation open: the player
   * quits that app and retries, or continues as a copy. */
  held?: { threadId: string; text: string; ctx?: string };
  /** How many of the latest entries to render per quest / desktop thread ("Load earlier" grows it). */
  window: Record<string, number>;
  /** Quest log shows only these agents (empty = all). */
  show: AgentKind[];
  /** Zones whose desktop threads are all shown (the "+N more" row was clicked). */
  zoneAll: Set<string>;
  /** The model list (Model button) is open in the details pane. */
  picker?: boolean;
}

/** A pending approval as the control panel lists it ("Requests waiting"). */
export interface PendingRequest {
  thread: string;
  questTitle: string;
  project: string;
  /** The agent's label ("Claude"). */
  agent: string;
  requestId: string;
  title: string;
  /** What the in-game card shows (a preview when `cut`). */
  detail: string;
  /** The whole request, when the in-game card shows only part of it. */
  full?: string;
  /** Too long for the in-game card: approved only here, never from the game. */
  cut: boolean;
  canAlways: boolean;
  at: number;
}

export interface AddonInfo {
  addon?: string;
  build?: string;
  iface?: number;
  char?: string;
  realm?: string;
  syncAt?: number;
  /** The player's quest log as the addon last sent it (one line per quest, with progress). */
  quests?: string;
}

const MAX_ENTRIES = 400;
/** Game-side budgets (any addon can draw strip frames): quests started, and prompts sent, per 5 minutes. */
const START_BUDGET = { max: 6, perMs: 300_000 };
const PROMPT_BUDGET = { max: 20, perMs: 300_000 };
// Temporary local diagnosis of repeated catch-up cards. Content digests stay in memory only;
// log records contain opaque identities and equality flags, never transcript text.
const CATCH_UP_TRACE_LIMIT = 32;
const CATCH_UP_TRACE_FIELDS = ["kind", "text", "title", "approval", "level"] as const;
const CATCH_UP_TRACE_SOURCES = new Set(["message", "done", "approval", "approvalResolved", "error", "notice", "note", "send", "caughtUp", "decide", "key", "action", "archive"]);
type CatchUpTraceState = {
  entry?: string; revision?: string; marker: string | null;
  text?: string; normalized?: string; excerpt?: string; fields?: string[];
};
const traceDigest = (text: string) => createHash("sha256").update(text).digest("hex");
const traceToken = (value: unknown) => typeof value === "string" ? traceDigest(value).slice(0, 16) : null;
const traceIdentity = (s: CatchUpTraceState) => ({ entry: traceToken(s.entry), revision: traceToken(s.revision), marker: traceToken(s.marker) });
const traceErrorCode = storageCode;
/** Familiar's own copy of a quest idle this long is dropped at the next start (the conversation
 * itself stays in the agent's own store). */
const PRUNE_AFTER_MS = 90 * 86_400_000;
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Whether continuing a desktop/CLI thread needs a copy: it's working right now, or another app
 * has it open. Agents that can't tell whether it's open fall back to "used in the last 10 minutes". */
export function mustFork(x: { running?: boolean; open?: boolean; updatedAt: number }, now = Date.now()) {
  return !!x.running || (x.open ?? now - x.updatedAt < 10 * 60_000);
}

export const FONT_MIN = 0.8,
  FONT_MAX = 1.6;

/** The font scale after "/fam font <arg>": bigger/smaller (10% steps), reset, or a percent
 * (80-160; a factor like 1.2 works too). Undefined: not understood. */
export function setFontScale(cur: number, arg = ""): number | undefined {
  const a = arg.trim().toLowerCase();
  let s: number;
  if (a === "bigger" || a === "+" || a === "up" || a === "larger") s = cur + 0.1;
  else if (a === "smaller" || a === "-" || a === "down") s = cur - 0.1;
  else if (a === "reset" || a === "default") s = 1;
  else if (/^\d+(\.\d+)?%?$/.test(a)) {
    const n = parseFloat(a);
    s = n > 4 ? n / 100 : n;
  } else return undefined;
  return Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, s)) * 10) / 10;
}

/** Where a cut request is approved, said on its approval toast. */
export const CUT_TOAST = "Open Familiar on your PC to approve";

const FORK_NOTE = "This conversation is open in another app (the desktop app or a terminal), which owns writing to it, so Familiar continues a copy (fork). Close it there to keep working in the same conversation.";

export class Hub {
  threads = new Map<string, Thread>();
  external = new Map<string, ExternalThread>(); // key ext:<agent>:<nativeId>
  extHistory = new Map<string, HistoryEntry[]>();
  extHistoryState = new Map<string, { loading: boolean; error?: string; entries: number; generation: number }>();
  /** The one history read per desktop thread; a newer request waits for it, then reads afresh. */
  private historyReads = new Map<string, Promise<void>>();
  private historyGeneration = 0;
  view: View = { list: "quests", pickAgent: "claude", collapsed: new Set(), expanded: new Set(), native: false, window: {}, show: [], zoneAll: new Set() };
  /** Desktop/CLI threads the user pinned or hid from the game ("<agent>:<nativeId>"). */
  pinned = new Set<string>();
  hidden = new Set<string>();
  /** Of the archived ("hidden") threads, those the agent's own app archived too (so restoring
   * them restores it there as well). */
  archivedInSource = new Set<string>();
  /** Ids of addon messages already handled (newest last). Written to FamiliarSync so the addon can
   * drop them from its outbox; also makes a resend of something that did arrive a no-op. */
  acked: string[] = [];
  toasts: Toast[] = [];
  /** In combat (setCombat): quests' notices and the last speech, released when the fight ends. */
  private combat = false;
  private held: Toast[] = [];
  private heldSpeech?: string;
  private heldPcAlert = false;
  addon: AddonInfo = {};
  private viewKeys = false; // monotonic for this Hub lifetime; old hellos cannot downgrade safety
  projects: ProjectRegistry;
  private listeners = new Set<(why: string) => void>();
  private toastSeq = 1;
  private saveTimer?: NodeJS.Timeout;
  private catchUpTrace = new Map<string, CatchUpTraceState>();
  private catchUpWrites = new Map<string, { attempt: number; marker: string }>();
  private catchUpTraceLimits = new Set<"monitor" | "write">();
  private catchUpAttempt = 0;
  /** Opens an agent app's link ("Continue in <app>"); main sets it to the shell. */
  openExternal: (url: string) => void = () => {};
  /** "Suggest a change": opens our pre-filled new-issue form (main gates the URL prefix). */
  openIssue: (url: string) => void = () => {};
  /** Versions for a suggestion (main: install probe + os.release); never paths or names. */
  suggestVersions: () => SuggestVersions = () => ({});
  private threadStore: ThreadStore;
  get storage() { return this.threadStore.warning; }
  notice?: { text: string; at: number };
  onSound: (kind: "done" | "approval" | "error") => void = () => {};
  onConfigChanged: (c: Config) => void = () => {};
  onSpeak: (text: string) => void = () => {};
  /** A request too long for the in-game card is waiting (main: flash the panel / a tray notice). */
  onCutRequest: () => void = () => {};
  /** A toast was raised (after a fight, for held ones): main's Windows notice (notices.ts). */
  onToast: (x: Toast) => void = () => {};
  /** This companion's version (main's VERSION), compared with the addon's on hello. */
  version = "";

  constructor(
    public cfg: () => Config,
    public backends: Record<AgentKind, AgentBackend>,
    public log: (s: string) => void,
  ) {
    this.projects = new ProjectRegistry(cfg);
    this.threadStore = new ThreadStore(path.join(appDataDir(), "threads.json"));
    for (const b of Object.values(backends)) b.on((e) => this.onAgent(b.kind, e));
  }

  // ---- lifecycle ------------------------------------------------------------------------------
  /** "Use in Familiar" for a provider (control panel); off = not started, listed or offered. */
  enabled(id: AgentKind): boolean {
    return this.cfg().providers?.[id]?.enabled !== false;
  }

  /** Installed and signed in, by the Familiars card's file checks, for the Claude and Codex
   * backends (the Agent SDK starts without a login, so readiness can't tell). undefined: can't
   * tell, assume yes — ACP agents exist only when installed. Not readiness: a backend that is
   * still starting or failed to start is retried when a message is sent. */
  available: (id: AgentKind) => boolean | undefined = (id) => {
    const b = this.backends[id];
    return b instanceof ClaudeBackend || b instanceof CodexBackend ? providerAvailable(id) : undefined;
  };
  private fallbackLogged = new Set<string>();

  /** Whether a provider can take a new quest or chat: switched on, installed and signed in. */
  private usable(id: AgentKind): boolean {
    const b = this.backends[id];
    if (!b || !this.enabled(id)) return false;
    return b.status().account !== "signed out" && this.available(id) !== false;
  }

  /** The configured agent (defaultAgent, chatAgent) when it can run; otherwise the first provider
   * that is installed and signed in (claude, codex, then ACP agents), so a Codex-only player's
   * + Chat and /fam ask work. Switched off in the control panel, or nothing else usable: the
   * configured one, so the draft says why. */
  agentOr(want: AgentKind): AgentKind {
    if (!this.enabled(want) || this.usable(want)) return want;
    const alt = [...new Set(["claude", "codex", ...Object.keys(this.backends)])].find((id) => id !== want && this.usable(id));
    if (!alt) return want;
    if (!this.fallbackLogged.has(`${want}>${alt}`)) {
      this.fallbackLogged.add(`${want}>${alt}`);
      this.log(`[hub] default agent ${want} unavailable, using ${alt}`);
    }
    return alt;
  }

  /** A provider installed or switched on while Familiar runs. */
  addBackend(id: AgentKind, b: AgentBackend) {
    if (this.backends[id]) return;
    this.backends[id] = b;
    b.on((e) => this.onAgent(b.kind, e));
    if (this.waking) b.init().then(() => this.refreshExternal()).catch((e) => this.log(`[${id}] init: ${e}`));
    this.changed("providers");
  }

  /** Load state. Agent backends (the Codex app-server, the SDK) start later, in wake(), so the
   * companion idles cheaply in the tray until the game is running. */
  async start() {
    this.projects.scanRoots();
    this.load();
    for (const t of this.threads.values()) if (t.kind !== "tutorial") this.projects.add(t.cwd, t.updatedAt);
    // A Familiar Face, once, on a first run (no saved quests yet); /fam tutorial brings it back.
    const c = this.cfg();
    if (!c.tutorialSeen && this.threadStore.firstRun) {
      this.addTutorial();
      c.tutorialSeen = true;
      this.onConfigChanged(c);
    }
    setInterval(() => this.pruneToasts(), 1000);
    this.changed("start");
  }

  // ---- A Familiar Face (hub/tutorial.ts) -------------------------------------------------------
  private addTutorial(): Thread {
    const t = tutorialThread(uid("q"), appDataDir(), this.addon.char || "adventurer", uid);
    this.threads.set(t.id, t);
    return t;
  }

  /** /fam tutorial, or the welcome page's link: the tutorial quest, a fresh one if it was archived. */
  private openTutorial() {
    const t = [...this.threads.values()].find((x) => x.kind === "tutorial") ?? this.addTutorial();
    this.select(t.id);
  }

  /** The tutorial's lines take the same path as an agent's events (toasts, chimes, markers). */
  private play(t: Thread, events: AgentEvent[]) {
    for (const e of events) this.onAgent(TUTORIAL_AGENT, e);
    this.refreshStatus(t); // a practice card still waiting keeps its "!"
    if (t.status === "running") t.status = "idle";
  }

  private waking?: Promise<void>;
  /** Start the agent backends and the desktop-thread listing (idempotent). */
  wake(): Promise<void> {
    this.waking ??= (async () => {
      await Promise.all(
        Object.values(this.backends)
          .filter((b) => this.enabled(b.kind))
          .map((b) => b.init().catch((e) => this.log(`[${b.kind}] init: ${e}`))),
      );
      await this.refreshExternal().catch((e) => this.log("[hub] external: " + e));
      setInterval(() => this.refreshExternal().catch(() => {}), 120_000);
    })();
    return this.waking;
  }

  /** Desktop/CLI threads worth listing. Mirrors what the agents' own apps show: not archived (when
   * followDesktopArchive), started by a person (no scheduled tasks, scripts, sub-agents, empty
   * sessions), active within externalDays - except pinned/starred and running threads, which are
   * always listed. Hidden threads never are. */
  async refreshExternal() {
    const c = this.cfg();
    const since = Date.now() - c.externalDays * 86400_000;
    const found = new Map<string, ExternalThread>();
    const known = new Set([...this.threads.values()].flatMap((t) => [`${t.agent}:${t.nativeId}`, `${t.agent}:${t.adoptedFrom}`]));
    for (const b of Object.values(this.backends)) {
      if (!b.status().ready || !this.enabled(b.kind)) continue;
      let list: ThreadInfo[] = [];
      try {
        list = await b.listThreads({ limit: 200 });
      } catch (e) {
        this.log(`[${b.kind}] listThreads: ${e}`);
        continue;
      }
      for (const t of list) {
        const ref = `${t.agent}:${t.nativeId}`;
        if ((t.cwd && isExcluded(t.cwd, c)) || known.has(ref) || this.hidden.has(ref)) continue;
        if (!t.cwd && (t.agent === "claude" || t.agent === "codex")) continue; // folder-less: Hermes desktop/bot chats
        if ([...this.threads.values()].some((h) => h.agent === t.agent && h.nativeId === t.nativeId)) continue; // adopted meanwhile
        const reason = this.pinned.has(ref) || t.starred ? "pinned" : t.running ? "running" : t.updatedAt >= since ? "recent" : undefined;
        if (!reason) continue;
        if (reason === "recent" && t.automated) continue;
        if (t.archived && c.followDesktopArchive && reason !== "running") continue;
        // Threads without a folder (Hermes desktop/bot conversations) live in the Chats zone.
        const proj = t.projectCwd || t.cwd ? this.projects.add(t.projectCwd ?? t.cwd, t.updatedAt) : this.projects.chats(t.updatedAt);
        if (!proj) continue;
        found.set(`ext:${ref}`, { ...t, projectKey: proj.key, reason });
      }
      if (b.listProjects) {
        for (const p of await b.listProjects().catch(() => [])) if (!isExcluded(p.path, c)) this.projects.add(p.path, p.lastActivity ?? 0);
      }
    }
    this.external = found;
    // History is only kept for desktop threads still listed.
    for (const id of [...this.extHistory.keys(), ...this.extHistoryState.keys()])
      if (!found.has(id) && id !== this.view.selected) (this.extHistory.delete(id), this.extHistoryState.delete(id));
    const selected = this.view.selected;
    if (selected && found.has(selected) && !this.extHistory.has(selected) && !this.extHistoryState.has(selected))
      this.loadExtHistory(selected, this.view.window[selected] ?? 150);
    this.changed("external");
  }

  /** Folder a new quest "in the same zone as <cwd>" starts in (worktrees map to their project). */
  private zonePath(cwd: string): string {
    return this.projects.add(cwd)?.path ?? projectRootOf(cwd);
  }

  on(h: (why: string) => void) {
    this.listeners.add(h);
    return () => this.listeners.delete(h);
  }

  changed(why: string) {
    this.traceCatchUpChanges(why);
    for (const h of this.listeners) h(why);
    // Streaming text isn't saved token by token: the finished message, approvals and the turn's
    // end are (each schedules a save), and the user's own words are saved at once.
    if (why !== "hover" && why !== "delta") this.scheduleSave();
  }

  // ---- persistence ----------------------------------------------------------------------------
  private logCatchUp(record: Record<string, unknown>) {
    try { this.log("[catch-up] " + JSON.stringify(record)); } catch { /* Diagnosis must not change behavior. */ }
  }

  private catchUpLimit(scope: "monitor" | "write") {
    if (this.catchUpTraceLimits.has(scope)) return;
    this.catchUpTraceLimits.add(scope);
    this.logCatchUp({ event: "coverage-limit", scope, limit: CATCH_UP_TRACE_LIMIT });
  }

  private catchUpState(t: Thread | undefined, before?: CatchUpTraceState): CatchUpTraceState {
    const e = t && attentionEntry(t);
    const entry = e?.id, revision = e && attentionRevision(e), marker = t?.attentionSeen ?? null;
    // Identity/marker-only ticks reuse cached content digests, including long completed replies.
    if (before && before.entry === entry && before.revision === revision) return { ...before, marker };
    const excerpt = e && (e.kind === "approval" ? e.title ?? e.text : e.text);
    return { entry, revision, marker, ...(e ? {
      text: traceDigest(e.text), normalized: traceDigest(e.text.replace(/\s+/g, " ").trim()),
      excerpt: traceDigest(excerpt!.slice(0, 160) + (excerpt!.length > 160 ? "…" : "")),
      fields: CATCH_UP_TRACE_FIELDS.map(key => traceDigest(JSON.stringify(e[key]) ?? "undefined")),
    } : {}) };
  }

  private monitorCatchUp(t: Thread, source: "load" | "attempt") {
    if (this.catchUpTrace.has(t.id)) return;
    if (this.catchUpTrace.size >= CATCH_UP_TRACE_LIMIT) return this.catchUpLimit("monitor");
    const current = this.catchUpState(t);
    this.catchUpTrace.set(t.id, current);
    this.logCatchUp({ event: "baseline", source, thread: traceToken(t.id), ...traceIdentity(current) });
  }

  private traceCatchUpChanges(source: string) {
    if (!CATCH_UP_TRACE_SOURCES.has(source)) return; // No delta, render, status or periodic hello noise.
    for (const [id, before] of this.catchUpTrace) {
      const t = this.threads.get(id), after = this.catchUpState(t, before);
      const candidate = before.entry !== after.entry || before.revision !== after.revision;
      const marker = before.marker !== after.marker;
      if (candidate || marker) {
        const comparable = before.entry !== undefined && after.entry !== undefined;
        this.logCatchUp({ event: "transition", source, thread: traceToken(id),
          change: candidate ? marker ? "candidate-and-marker" : "candidate" : "marker",
          before: traceIdentity(before), after: traceIdentity(after),
          sameText: comparable ? before.text === after.text : null,
          sameNormalizedText: comparable ? before.normalized === after.normalized : null,
          sameExcerpt: comparable ? before.excerpt === after.excerpt : null,
          changedFields: comparable ? CATCH_UP_TRACE_FIELDS.filter((_, i) => before.fields?.[i] !== after.fields?.[i]) : null,
        });
        this.catchUpTrace.set(id, after);
      }
      if (!t) this.catchUpTrace.delete(id);
    }
  }

  private queueCatchUpWrite(thread: string, attempt: number, marker: string) {
    const previous = this.catchUpWrites.get(thread);
    if (previous) this.logCatchUp({ event: "superseded", thread: traceToken(thread), attempt: previous.attempt, by: attempt });
    else if (this.catchUpWrites.size >= CATCH_UP_TRACE_LIMIT) return this.catchUpLimit("write");
    this.catchUpWrites.set(thread, { attempt, marker });
  }

  private load() {
    try {
      const data = this.threadStore.read();
      if (this.storage?.level === "error") this.logCatchUp({ event: "load-unavailable", code: this.threadStore.code });
      for (const t of data.threads ?? []) {
        if (isExcluded(t.cwd, this.cfg())) continue;
        if (Date.now() - (t.updatedAt ?? 0) > PRUNE_AFTER_MS) continue;
        // A turn that was running when Familiar stopped did not finish; say so instead of
        // letting it look complete.
        const cut = t.status === "running" || t.status === "approval";
        if (t.attentionSeen === undefined) {
          const e = attentionEntry(t);
          t.attentionSeen = cut || t.unread || !e ? null : attentionRevision(e);
        }
        t.status = t.status === "new" ? "new" : t.lastError ? "error" : "idle";
        for (const e of t.entries) {
          e.streaming = false;
          if (e.kind === "approval" && e.approval === "pending") settle(e, "expired");
          if (e.kind === "tool" && e.status === "running") e.status = "unknown";
        }
        if (cut)
          t.entries.push({ id: uid("n"), kind: "notice", text: INTERRUPTED_NOTE, at: Date.now(), level: "error" });
        this.threads.set(t.id, t);
      }
      if (data.view) {
        this.view.selected = data.view.selected;
        this.view.collapsed = new Set(data.view.collapsed ?? []);
        this.view.pickAgent = data.view.pickAgent ?? "claude";
        this.view.show = Array.isArray(data.view.show) ? data.view.show : [];
      }
      this.pinned = new Set(data.pinned ?? []);
      this.hidden = new Set(data.hidden ?? []);
      this.archivedInSource = new Set(data.archivedInSource ?? []);
      this.acked = Array.isArray(data.acked) ? data.acked.slice(-100) : [];
      // Baseline is after the existing startup recovery above, not the pre-normalization disk state.
      for (const t of this.threads.values()) this.monitorCatchUp(t, "load");
    } catch (e) {
      this.threadStore.blockUnexpectedLoad(); // Never replace partial state after an unexpected load failure.
      this.logCatchUp({ event: "load-unavailable", code: traceErrorCode(e) });
      /* first run */
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, 2000);
  }

  saveNow(): boolean {
    const threads = [...this.threads.values()].map((t) => ({
      ...t,
      // A cut request's whole text is only needed while it can still be approved (pending requests
      // expire on the next start anyway); a quest full of large file writes must not bloat the file.
      entries: t.entries.slice(-MAX_ENTRIES).map((e) => {
        if (e.output && e.output.length > 2000) e = { ...e, output: e.output.slice(-2000) };
        if (e.full !== undefined && e.approval !== "pending") e = { ...e, full: undefined };
        return e;
      }),
    }));
    const data = {
      version: 1,
      threads,
      view: { selected: this.view.selected, collapsed: [...this.view.collapsed], pickAgent: this.view.pickAgent, show: this.view.show },
      pinned: [...this.pinned],
      hidden: [...this.hidden],
      archivedInSource: [...this.archivedInSource],
      acked: this.acked,
    };
    const receipts = [...this.catchUpWrites].map(([id, receipt]) => ({ id, ...receipt,
      written: threads.find(t => t.id === id)?.attentionSeen ?? null, included: threads.some(t => t.id === id),
    }));
    const beforeWarning = JSON.stringify(this.storage);
    const write = this.threadStore.write(data) ? "ok" : "failed";
    const code = write === "failed" ? this.threadStore.code : undefined;
    if (write === "failed") this.log("[hub] save failed: " + code);
    if (beforeWarning !== JSON.stringify(this.storage)) for (const h of this.listeners) h("storage");
    // "ok" means the existing atomic write returned, not fsync or read-back verification.
    if (receipts.length) this.logCatchUp({ event: "write", write, ...(code ? { code } : {}), receipts: receipts.map(r => ({
      attempt: r.attempt, thread: traceToken(r.id), acknowledged: traceToken(r.marker),
      written: traceToken(r.written), snapshot: !r.included ? "omitted" : r.marker === r.written ? "acknowledged" : "changed",
    })) });
    if (write === "ok") for (const r of receipts)
      if (this.catchUpWrites.get(r.id)?.attempt === r.attempt) this.catchUpWrites.delete(r.id);
    return write === "ok";
  }

  // ---- addon events ---------------------------------------------------------------------------
  /** How long a request must have been on the Glass before an approving decision counts (tests set 0):
   * no bait-and-switch of a fresh card under a click meant for something else. */
  minCardAgeMs = 400;

  /** Messages from the game are untrusted input (any addon can draw strip frames). `proof` is main's
   * evidence that the player physically did this (see main/physical.ts); only main creates it. */
  handleAddon(msg: any, proof: Proof = NO_PROOF) {
    const prompting = msg.t === "prompt" || msg.t === "quick" || msg.t === "ask";
    if (prompting && typeof msg.id === "string" && msg.id) {
      if (this.acked.includes(msg.id)) return; // a resend of something that already arrived
      this.acked.push(msg.id);
      if (this.acked.length > 100) this.acked.splice(0, this.acked.length - 100);
    }
    if (prompting && !this.within("prompt", PROMPT_BUDGET.max, PROMPT_BUDGET.perMs)) {
      this.log("[hub] prompt budget exceeded (20 / 5 min)");
      return this.toast("Too many messages from the game in 5 minutes; waiting a bit. If you didn't send them, an addon may be: /fam stop, then disable addons.", "error");
    }
    switch (msg.t) {
      case "quests":
        this.addon.quests = typeof msg.text === "string" ? msg.text.slice(0, 12000) : undefined;
        break;
      case "hello":
        if (msg.viewKeys === 1) this.viewKeys = true;
        this.addon = { ...this.addon, addon: msg.addon, build: msg.build, iface: msg.iface, char: msg.char, realm: msg.realm, syncAt: msg.syncAt };
        this.changed("hello");
        break;
      case "prompt":
        this.prompt(String(msg.text ?? ""), ctxOf(msg)).catch((e) => this.fail(e));
        break;
      case "ask":
        this.ask(String(msg.text ?? ""), ctxOf(msg), !!msg.new).catch((e) => this.fail(e));
        break;
      case "quick":
        this.quick(this.backends[msg.agent] ? String(msg.agent) : this.agentOr(this.cfg().defaultAgent), String(msg.text ?? "")).catch((e) => this.fail(e));
        break;
      case "key": {
        const supplied = Object.hasOwn(msg, "view");
        if (supplied) this.viewKeys = true;
        const view = supplied ? (msg.view === "full" || msg.view === "focus" ? msg.view : null) : this.viewKeys ? null : "legacy";
        this.key(String(msg.k), msg.a === undefined ? undefined : String(msg.a), view, proof).catch((e) => this.fail(e));
        break;
      }
    }
  }

  private fail(e: any) {
    // The toast is painted over the game (visible on stream); scrub paths and secrets like the log does.
    const text = redact(String(e?.message ?? e));
    this.log("[hub] " + text);
    this.toast(text, "error");
  }

  async key(k: string, arg?: string, view: unknown = "legacy", proof: Proof = NO_PROOF) {
    const t = this.selectedThread();
    switch (k) {
      case "open":
        return this.action({ type: "openInApp" });
      case "pin":
        return this.action({ type: "pin", id: this.view.selected });
      case "hide":
      case "archive":
        return this.action({ type: "archive", id: this.view.selected });
      case "autostart": {
        const c = this.cfg();
        const a = (arg ?? "").toLowerCase();
        c.launchAtLogin = a === "on" ? true : a === "off" ? false : !c.launchAtLogin;
        this.onConfigChanged(c);
        this.toast(c.launchAtLogin ? "Familiar will start with Windows (in the tray)." : "Familiar will no longer start with Windows.", "info");
        break;
      }
      case "font": {
        const c = this.cfg();
        const s = setFontScale(c.fontScale, arg);
        if (s === undefined) return this.toast(`Font size ${Math.round(c.fontScale * 100)}% - /fam font bigger | smaller | reset | 80-160`, "info");
        c.fontScale = s;
        this.onConfigChanged(c);
        this.toast(`Font size: ${Math.round(s * 100)}%`, "info");
        break;
      }
      case "sound":
      case "warnings": {
        const c = this.cfg();
        const field = k === "sound" ? "sound" : "raidWarnings";
        const a = (arg ?? "").toLowerCase();
        c[field] = a === "on" ? true : a === "off" ? false : !c[field];
        this.onConfigChanged(c);
        if (k === "sound") this.toast(c.sound ? "Sounds on." : "Sounds off.", "info");
        else this.toast(c.raidWarnings ? "Notices show as raid warnings (middle of the screen)." : "Notices show at the top of the Familiar window.", "info");
        break;
      }
      case "quiet": {
        const a = (arg ?? "").toLowerCase();
        this.setQuiet(a === "on" ? true : a === "off" ? false : !this.cfg().quiet);
        break;
      }
      case "private": {
        const a = (arg ?? "").toLowerCase();
        this.setPrivate(a === "on" ? true : a === "off" ? false : !this.cfg().privateMode);
        break;
      }
      case "stream": {
        const a = (arg ?? "").toLowerCase();
        this.setStream(a === "on" ? true : a === "off" ? false : !this.cfg().blurTranscript);
        break;
      }
      case "tutorial":
        this.openTutorial();
        break;
      case "caughtup": {
        const t = this.selectedThread();
        const e = t && attentionEntry(t);
        if (t && e) this.action({ type: "caughtUp", thread: t.id, entry: e.id, revision: attentionRevision(e) });
        break;
      }
      case "unhide":
      case "unarchive":
        await this.unarchiveAll();
        break;
      case "hidden":
      case "archived":
        this.toast(this.hidden.size ? `${this.hidden.size} archived thread${this.hidden.size > 1 ? "s" : ""} - /fam unarchive restores them.` : "Nothing is archived.", "info");
        break;
      case "suggest": {
        // Only opens a browser page the user must submit there, so no physical corroboration.
        const url = suggestionUrl(arg ?? "", this.suggestVersions());
        if (!url) return this.toast("Usage: /fam suggest <your idea> (up to 500 characters)", "info");
        this.openIssue(url);
        this.toast(SUGGEST_TOAST, "info");
        break;
      }
      case "show": {
        const want = (arg ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
        const kinds = Object.keys(this.backends) as AgentKind[];
        const pick = kinds.filter((x) => want.includes(x));
        if (want.length && !want.includes("all") && !pick.length) return this.toast(`Show what? ${["all", ...kinds].join(", ")}`, "info");
        this.view.show = want.includes("all") ? [] : pick;
        this.toast(this.view.show.length ? `Quest Log: ${this.view.show.map(agentName).join(" + ")} only` : "Quest Log: all agents", "info");
        break;
      }
      case "newChat":
        this.beginChatDraft();
        break;
      case "newClaude":
      case "newCodex":
        if (!this.enabled(k === "newClaude" ? "claude" : "codex"))
          return this.toast(`${agentName(k === "newClaude" ? "claude" : "codex")} is switched off in Familiar's control panel.`, "info");
        this.view.list = "pick";
        this.view.pickAgent = k === "newClaude" ? "claude" : "codex";
        this.view.draft = undefined;
        break;
      case "back":
        if (this.view.picker) {
          this.view.picker = false;
          break;
        }
        this.view.list = "quests";
        this.view.draft = undefined;
        break;
      case "approve":
      case "deny":
      case "always": {
        if (view !== "legacy" && view !== "full" && view !== "focus") {
          const shown = this.pendingApproval(true);
          if (typeof shown === "object") refuse(shown.entry, "view");
          return this.toast("Unknown view context. Use Full view and review the request before deciding.", "info");
        }
        // Approving needs a real click on the button or the registered Approve key; denying never does.
        if (k !== "deny" && !proof.ok) {
          this.log(`[hub] ${k} refused: ${proof.why ?? "no proof"}`);
          // The card the key would have acted on (not a desktop-thread or held-message prompt).
          const prompting = (this.view.confirm && this.view.selected === this.view.confirm.extId) || (this.view.held && this.view.selected === this.view.held.threadId);
          const target = prompting ? undefined : this.pendingApproval(view === "focus");
          if (typeof target === "object") refuse(target.entry, "proof");
          return this.toast("Not approved. Click the request on the Glass, or press the Approve key set in Familiar's control panel.", "info");
        }
        // Debounce: a double-press must not approve the next queued request unseen.
        if (Date.now() - this.lastDecisionAt < 900) return;
        if (this.view.confirm && this.view.selected === this.view.confirm.extId) {
          this.lastDecisionAt = Date.now();
          this.action({ type: k === "deny" ? "adoptCancel" : "adoptConfirm" }, proof);
          return;
        }
        if (this.view.held && this.view.selected === this.view.held.threadId) {
          this.lastDecisionAt = Date.now();
          this.action({ type: k === "deny" ? "heldCancel" : "heldRetry" }, proof);
          return;
        }
        const target = this.pendingApproval(view === "focus");
        if (target === "elsewhere") return this.toast("Another conversation needs review. Use Full view to open its request before deciding.", "info");
        if (target === "ambiguous") return this.toast("Several quests are waiting for approval - open one to choose.", "info");
        if (!target) return this.toast("Nothing is waiting for approval.", "info");
        this.decide(target.thread.id, target.entry.requestId!, k === "approve" ? "allow" : k === "deny" ? "deny" : "allowAlways");
        return;
      }
      case "stop":
        if (t && t.kind !== "tutorial" && (t.status === "running" || t.status === "approval")) {
          // Before the provider has opened the quest, interrupt has nothing to stop: sendTo sees this.
          this.stops.set(t.id, (this.stops.get(t.id) ?? 0) + 1);
          await this.backends[t.agent].interrupt(t.id);
          this.note(t, STOPPING_NOTE);
        }
        break;
      case "mode": {
        if (this.view.draft?.chat || (!this.view.draft && t?.kind === "chat"))
          return this.toast("Chats have no permission modes: they can only search the web.", "info");
        if (!this.view.draft && t?.kind === "tutorial") return this.toast(TUTORIAL_NO_MODE, "info");
        // The game only cycles Ask first <-> Plan only; from Accept edits or Auto the key goes to Ask.
        const target = this.view.draft ?? t;
        if (!target) return this.toast("Select a quest first.", "info");
        if (!proof.ok) {
          this.log(`[hub] mode refused: ${proof.why ?? "no proof"}`);
          return this.toast("Mode changes need a click on the Mode button.", "info");
        }
        const fromPanelOnly = !GAME_MODES.includes(target.mode);
        const mode: Mode = fromPanelOnly ? "ask" : nextOf(GAME_MODES, target.mode);
        target.mode = mode;
        if (t && !this.view.draft) await this.backends[t.agent].setMode(t.id, mode);
        this.toast(fromPanelOnly ? "Switched to Ask first. Accept edits and Auto are set in the control panel." : `Mode: ${MODE_LABEL[mode]}`, "info");
        break;
      }
      case "model":
        // Opens (or closes) the model list in the details pane; a click there picks one.
        if (!this.view.draft && !t) return this.toast("Select a quest or chat first.", "info");
        if (!this.view.draft && t?.kind === "tutorial") return this.toast(TUTORIAL_NO_MODE, "info");
        this.view.picker = !this.view.picker;
        break;
      case "native":
        this.view.native = !this.view.native;
        break;
      case "tools": {
        const order = ["compact", "full", "hidden"] as const;
        const c = this.cfg();
        c.toolDetail = order[(order.indexOf(c.toolDetail) + 1) % order.length];
        this.onConfigChanged(c);
        this.toast(`Tool calls: ${c.toolDetail === "compact" ? "grouped" : c.toolDetail === "full" ? "every step" : "hidden"}`, "info");
        break;
      }
      case "next":
      case "prev":
        this.cycleSelection(k === "next" ? 1 : -1);
        break;
    }
    this.changed("key");
  }

  // ---- overlay actions (hit-tested by the renderer) -------------------------------------------
  /** Overlay actions that grant an agent something: only with proof of a real click on the Glass.
   * Denying a card ("decide" with deny / denyAndStop) is the fail-safe direction and never needs it. */
  private static CORROBORATED_ACTIONS = new Set(["decide", "answer", "adoptConfirm", "adoptNew", "adoptRetry", "heldRetry", "heldCopy"]);

  action(a: { type: string; [k: string]: any }, proof: Proof = NO_PROOF) {
    const denying = a.type === "decide" && (a.decision === "deny" || a.decision === "denyAndStop");
    if (Hub.CORROBORATED_ACTIONS.has(a.type) && !denying && !proof.ok) {
      this.log(`[hub] action ${a.type} refused: ${proof.why ?? "no proof"}`);
      if (typeof a.requestId === "string") refuse(this.threads.get(String(a.thread))?.entries.find((x) => x.requestId === a.requestId && x.approval === "pending"), "proof");
      return this.toast("That click could not be matched to your mouse. Click it again.", "info");
    }
    switch (a.type) {
      case "select": {
        this.select(a.id);
        const t = this.selectedThread();
        const entry = t && attentionEntry(t);
        if (t && entry && entry.id === a.entry) {
          const needed = t.entries.length - t.entries.indexOf(entry);
          this.view.window[t.id] = Math.max(this.view.window[t.id] ?? 150, needed);
        }
        break;
      }
      case "zone":
        if (this.view.collapsed.has(a.key)) this.view.collapsed.delete(a.key);
        else this.view.collapsed.add(a.key);
        break;
      case "pick": {
        const proj = this.projects.get(a.key);
        if (proj) this.beginDraft(this.agentOr(this.view.pickAgent), proj);
        break;
      }
      case "newIn": {
        if (a.key === CHATS_KEY) {
          this.beginChatDraft();
          break;
        }
        const proj = this.projects.get(a.key);
        if (proj) {
          this.view.list = "pick";
          this.beginDraft(a.agent ?? this.agentOr(this.cfg().defaultAgent), proj);
        }
        break;
      }
      case "tool":
        if (this.view.expanded.has(a.id)) this.view.expanded.delete(a.id);
        else this.view.expanded.add(a.id);
        break;
      case "approvalPreview": {
        const t = this.selectedThread();
        if (!t || t.id !== a.thread || !t.entries.some(e => e.id === a.id && e.kind === "approval")) return;
        if (this.view.expanded.has(a.id)) this.view.expanded.delete(a.id);
        else this.view.expanded.add(a.id);
        break; // Read-only, including after a request expires or is resolved.
      }
      case "quiet":
        if (typeof a.on === "boolean") this.setQuiet(a.on);
        return;
      case "caughtUp": {
        const t = this.threads.get(String(a.thread));
        const e = t && attentionEntry(t);
        if (t) this.monitorCatchUp(t, "attempt");
        const attempt = ++this.catchUpAttempt, before = t?.attentionSeen;
        const revision = e && attentionRevision(e);
        const result = !t ? "missing-thread" : !e ? "no-candidate" : e.approval === "pending" ? "pending" :
          e.id !== a.entry ? "stale-entry" : a.revision !== revision ? "stale-revision" : before === a.revision ? "already-seen" : "accepted";
        if (t && e && e.id === a.entry && a.revision === attentionRevision(e) && e.approval !== "pending") {
          t.attentionSeen = a.revision;
          this.queueCatchUpWrite(t.id, attempt, a.revision);
          this.logCatchUp({ event: "attempt", attempt, result, thread: traceToken(a.thread),
            requestedEntry: traceToken(a.entry), currentEntry: traceToken(e.id), requestedRevision: traceToken(a.revision), currentRevision: traceToken(revision),
            before: traceToken(before), after: traceToken(t.attentionSeen) });
          this.changed("caughtUp");
        } else {
          this.logCatchUp({ event: "attempt", attempt, result, thread: traceToken(a.thread),
            requestedEntry: traceToken(a.entry), currentEntry: traceToken(e?.id), requestedRevision: traceToken(a.revision), currentRevision: traceToken(revision),
            before: traceToken(before), after: traceToken(t?.attentionSeen) });
        }
        return;
      }
      case "stop": {
        const selected = this.selectedThread();
        if (!selected || selected.id !== a.thread || (selected.status !== "running" && selected.status !== "approval")) return;
        this.key("stop").catch((e) => this.fail(e));
        return;
      }
      case "decide":
        this.decide(a.thread, a.requestId, a.decision as Decision);
        return;
      case "answer": {
        const t = this.threads.get(a.thread);
        if (!t) return;
        // Mark it answered first, so the backend's approvalResolved doesn't call it "expired".
        const q = t.entries.find((x) => x.requestId === a.requestId && x.approval === "pending");
        if (q) settle(q, "approved");
        this.backends[t.agent]?.answerQuestion?.(t.id, a.requestId, a.label);
        return;
      }
      case "tutorial": // the welcome page's "Replay A Familiar Face"
        this.openTutorial();
        break;
      case "agent":
        this.view.pickAgent = a.agent;
        if (this.view.draft) this.view.draft.agent = a.agent;
        break;
      case "abandon":
      case "archive":
        this.archive(String(a.id ?? "")).catch((e) => this.fail(e));
        return;
      case "adoptConfirm": {
        const c = this.view.confirm;
        if (!c) break;
        this.view.confirm = undefined;
        this.adopt(c.extId)
          .then((t) => (t ? this.sendTo(t, c.text) : this.toast("That desktop conversation is no longer listed.", "error")))
          .catch((e) => this.fail(e));
        break;
      }
      case "adoptNew": {
        const c = this.view.confirm;
        const x = c && this.external.get(c.extId);
        if (!c || !x) break;
        this.view.confirm = undefined;
        let t: Thread;
        try {
          t =
            x.projectKey === CHATS_KEY
              ? this.createChat(c.text)
              : this.createThread(x.agent, this.projects.get(x.projectKey)?.path ?? this.zonePath(x.cwd), this.cfg().defaultMode, undefined, c.text);
        } catch (e) {
          this.fail(e);
          break;
        }
        this.sendTo(t, c.text).catch((e) => this.fail(e));
        break;
      }
      case "adoptCancel":
        if (this.view.confirm) this.toast("Not sent.", "info");
        this.view.confirm = undefined;
        break;
      case "adoptRetry": {
        // The player quit the app that had this conversation open: continue it in place if it's free.
        const x = this.view.confirm && this.external.get(this.view.confirm.extId);
        if (!x) break;
        if (this.backends[x.agent].heldElsewhere?.(x.nativeId) !== false) return this.toast(stillHeld(x.agent), "info");
        x.open = false;
        x.running = false;
        this.action({ type: "adoptConfirm" }, proof);
        return;
      }
      case "heldRetry":
      case "heldCopy": {
        const h = this.view.held;
        const t = h && this.threads.get(h.threadId);
        if (!h || !t) break;
        const b = this.backends[t.agent];
        if (a.type === "heldRetry" && t.nativeId && b.heldElsewhere?.(t.nativeId)) return this.toast(stillHeld(t.agent), "info");
        this.view.held = undefined;
        const copy = a.type === "heldCopy";
        // A copy (fork) needs a fresh open: drop Familiar's own session for this quest first.
        (copy ? b.close(t.id).then(() => void (t.fork = true)) : Promise.resolve())
          .then(() => this.sendTo(t, h.text, h.ctx))
          .catch((e) => this.fail(e));
        break;
      }
      case "heldCancel":
        if (this.view.held) this.toast("Not sent.", "info");
        this.view.held = undefined;
        break;
      case "openInApp": {
        // One owner at a time: Familiar lets go of its own session, then the app opens the same one.
        const id = this.view.selected;
        const t = id ? this.threads.get(id) : undefined;
        const x = id ? this.external.get(id) : undefined;
        const agent = t?.agent ?? x?.agent;
        const nativeId = t?.nativeId ?? x?.nativeId;
        const b = agent ? this.backends[agent] : undefined;
        if (!agent || !nativeId || !b?.handOff) return this.toast("Select a quest or desktop thread that its own app can open.", "info");
        if (t && (t.status === "running" || t.status === "approval")) return this.toast("Stop the quest first, or wait for it to finish.", "info");
        b.handOff(t?.id, nativeId)
          .then((url) => {
            this.openExternal(url);
            if (t) this.note(t, `Continued in the ${agentName(agent)} app. Sending from here asks first while the app has it open.`);
            else this.toast(`Opened in the ${agentName(agent)} app.`, "info");
            this.changed("handOff");
          })
          .catch((e) => this.fail(e));
        return;
      }
      case "more": {
        const id = String(a.id);
        if (id !== this.view.selected) return;
        const entries = (this.view.window[id] ?? 150) + 150;
        if (id.startsWith("ext:")) this.loadExtHistory(id, entries);
        else this.view.window[id] = entries;
        break;
      }
      case "retryHistory": {
        const id = String(a.id);
        const history = this.extHistoryState.get(id);
        if (id !== this.view.selected || history?.loading || (!history?.error && this.extHistory.has(id))) return;
        this.loadExtHistory(id, history?.entries ?? this.view.window[id] ?? 150);
        break;
      }
      case "pin": {
        const id = String(a.id ?? "");
        const x = this.external.get(id);
        const own = this.threads.get(id);
        const ref = x ? `${x.agent}:${x.nativeId}` : own?.nativeId ? `${own.agent}:${own.nativeId}` : undefined;
        if (!ref) {
          this.toast("Select a desktop thread to pin.", "info");
          break;
        }
        if (a.type === "pin") {
          if (x?.starred) this.toast("Starred in the desktop app - it stays listed.", "info");
          else if (this.pinned.delete(ref)) this.toast(`Unpinned: ${x?.title ?? own?.title}`, "info", undefined, "Unpinned.");
          else {
            this.pinned.add(ref);
            this.toast(`Pinned: ${x?.title ?? own?.title} - listed even when old`, "info", undefined, "Pinned - listed even when old.");
          }
        }
        if (x) this.refreshExternal().catch(() => {});
        break;
      }
      case "pickModel":
        this.pickModel(String(a.agent), String(a.model));
        break;
      case "pickEffort": {
        const c = this.cfg();
        c.chatEffort = String(a.effort);
        this.onConfigChanged(c);
        this.toast(`Chat effort: ${c.chatEffort} (new chats and new messages)`, "info");
        break;
      }
      case "closePicker":
        this.view.picker = false;
        break;
      case "zoneMore":
        this.view.zoneAll.add(String(a.key));
        break;
      case "dismissToast":
        this.toasts = this.toasts.filter((x) => x.id !== a.id);
        break;
    }
    this.changed("action");
  }

  /** Archive a quest or desktop thread: gone from the Quest Log, and archived in the agent's own
   * app too where it lets other apps do that (Codex, Hermes). Claude and Grok have no such way, so
   * those are archived in Familiar only (archiving in the Claude desktop app still flows here). */
  async archive(id: string) {
    const x = this.external.get(id);
    const own = this.threads.get(id);
    if (!x && !own) return this.toast("Select a quest or desktop thread to archive.", "info");
    if (own?.kind === "tutorial") {
      // Nothing runs in it and no app holds it: gone at once, and a fresh one is a /fam tutorial away.
      this.threads.delete(own.id);
      if (this.view.selected === id) this.view.selected = undefined;
      this.toast(`Archived: ${own.title} (/fam tutorial brings it back)`, "info", undefined, "Archived (/fam tutorial brings it back).");
      return this.changed("archive");
    }
    if (own && (own.status === "running" || own.status === "approval")) return this.toast("Stop the quest before archiving it.", "info");
    const agent = (x ?? own)!.agent;
    const nativeId = x?.nativeId ?? own?.nativeId;
    const title = (x ?? own)!.title;
    if (own) {
      this.threads.delete(own.id);
      await this.backends[agent]?.close(own.id).catch(() => {});
    } else this.external.delete(id);
    if (this.view.selected === id) this.view.selected = undefined;
    let inSource = false;
    if (nativeId) {
      const ref = `${agent}:${nativeId}`;
      this.hidden.add(ref);
      this.pinned.delete(ref);
      const b = this.backends[agent];
      inSource = !!(b?.archive && (await b.archive(nativeId, true).catch((e) => (this.log(`[${agent}] archive: ${e}`), false))));
      if (inSource) this.archivedInSource.add(ref);
    }
    this.toast(
      inSource
        ? `Archived: ${title} - in ${agentName(agent)} too (/fam unarchive restores)`
        : `Archived: ${title} - in Familiar only; ${agentName(agent)} doesn't let other apps archive (/fam unarchive restores)`,
      "info",
      undefined,
      "Archived (/fam unarchive restores).",
    );
    this.changed("archive");
  }

  /** Restore everything archived from Familiar (and in the agents' apps where it went there too). */
  async unarchiveAll() {
    const refs = [...this.hidden];
    if (!refs.length) return this.toast("Nothing is archived.", "info");
    for (const ref of refs) {
      const [agent, ...rest] = ref.split(":");
      const nativeId = rest.join(":");
      if (this.archivedInSource.has(ref)) await this.backends[agent]?.archive?.(nativeId, false).catch((e) => this.log(`[${agent}] unarchive: ${e}`));
    }
    this.hidden.clear();
    this.archivedInSource.clear();
    this.toast(`Restored ${refs.length} archived thread${refs.length > 1 ? "s" : ""}.`, "info");
    await this.refreshExternal().catch(() => {});
  }

  /** Model list click. In a chat, the choice also becomes the default for new chats. */
  private pickModel(agent: AgentKind, model: string) {
    const t = this.selectedThread();
    const d = this.view.draft;
    this.view.picker = false;
    const label = this.backends[agent]?.status().models.find((m) => m.id === model)?.label ?? model;
    if (d?.chat || (!d && t?.kind === "chat")) {
      const c = this.cfg();
      c.chatAgent = agent;
      c.chatModel = model;
      this.onConfigChanged(c);
      if (d) {
        d.agent = agent;
        d.model = model;
      } else if (t && t.agent === agent) {
        t.model = model;
        this.backends[agent].setModel(t.id, model).catch((e) => this.fail(e));
      } else this.beginChatDraft(); // a conversation can't move between agents: start a new chat
      this.toast(`Chat model: ${agentName(agent)} ${label} (also for new chats)`, "info");
      return;
    }
    const target = d ?? t;
    if (!target || (!d && t?.kind === "tutorial")) return;
    target.model = model;
    if (t && target === t) this.backends[t.agent].setModel(t.id, model).catch((e) => this.fail(e));
    this.toast(`Model: ${label}`, "info");
  }

  select(id: string) {
    if (this.view.selected !== id || this.view.draft || this.view.list !== "quests") this.historyGeneration++;
    this.view.picker = false;
    if (this.view.confirm && this.view.confirm.extId !== id) this.view.confirm = undefined;
    this.view.selected = id;
    this.view.list = "quests";
    this.view.draft = undefined;
    const t = this.threads.get(id);
    if (t) t.unread = false;
    if (id.startsWith("ext:") && (!this.extHistory.has(id) || this.extHistoryState.get(id)?.loading))
      this.loadExtHistory(id, this.extHistoryState.get(id)?.entries ?? this.view.window[id] ?? 150);
    this.dropToasts((x) => x.threadId === id);
  }

  /** Fetch (more of) a desktop thread's history; `entries` is roughly how many we want to show. */
  loadExtHistory(id: string, entries: number) {
    const x = this.external.get(id);
    if (!x || this.view.selected !== id || this.view.draft || this.view.list !== "quests") return;
    const previous = this.extHistoryState.get(id);
    if (previous?.loading && previous.generation === this.historyGeneration) return;
    const state = { loading: true, entries, generation: this.historyGeneration, error: undefined as string | undefined };
    this.extHistoryState.set(id, state);
    this.changed("history");
    const current = () => this.extHistoryState.get(id) === state && state.generation === this.historyGeneration
      && this.view.selected === id && this.external.has(id) && !this.view.draft && this.view.list === "quests";
    // Claude reads messages (several per turn); Codex reads turns.
    const limit = x.agent === "codex" ? Math.ceil(entries / 4) : Math.ceil(entries * 1.5);
    // Returning while an obsolete read is still running waits for it, then reads once more.
    const read: Promise<void> = (this.historyReads.get(id) ?? Promise.resolve())
      .then(() => (current() ? this.backends[x.agent].readHistory(x.nativeId, x.cwd, limit) : undefined))
      .then((h) => {
        if (!h || !current()) return;
        this.extHistory.set(id, h);
        this.view.window[id] = entries; // A failed "Load earlier" never changes the visible window.
      })
      .catch((e) => {
        if (!current()) return;
        this.log("[hub] history: " + e);
        state.error = this.extHistory.has(id) ? "Couldn't load earlier messages. Your loaded messages are still here." : "Couldn't load this conversation's history.";
      })
      .finally(() => {
        if (this.historyReads.get(id) === read) this.historyReads.delete(id);
        state.loading = false;
        if (current()) this.changed("history");
      });
    this.historyReads.set(id, read);
  }

  private beginDraft(agent: AgentKind, proj: Project) {
    this.view.draft = { agent, cwd: proj.path, projectKey: proj.key, mode: this.cfg().defaultMode };
    this.view.pickAgent = agent;
  }

  private cycleSelection(dir: 1 | -1) {
    const ids = this.orderedThreadIds();
    if (!ids.length) return;
    const i = this.view.selected ? ids.indexOf(this.view.selected) : -1;
    this.select(ids[(i + dir + ids.length) % ids.length]);
  }

  orderedThreadIds(): string[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((t) => t.id);
  }

  selectedThread(): Thread | undefined {
    return this.view.selected ? this.threads.get(this.view.selected) : undefined;
  }

  /** The request Approve/Deny/Always keys act on: the selected quest's oldest pending request, or
   * the only pending request anywhere (what the toast showed). Several elsewhere = ambiguous. */
  private pendingApproval(selectedOnly = false): { thread: Thread; entry: Entry } | "ambiguous" | "elsewhere" | undefined {
    const firstPending = (t: Thread) => t.entries.find((x) => x.kind === "approval" && x.approval === "pending");
    const sel = this.selectedThread();
    const own = sel && firstPending(sel);
    if (sel && own) return { thread: sel, entry: own };
    const all = [...this.threads.values()].flatMap((t) => t.entries.filter((x) => x.kind === "approval" && x.approval === "pending").map((entry) => ({ thread: t, entry })));
    if (selectedOnly && all.length) return "elsewhere";
    if (all.length === 1) return all[0];
    return all.length ? "ambiguous" : undefined;
  }

  private lastDecisionAt = 0;

  /** One decision per request id. `origin` "panel" is only ever passed by main for a click in the
   * desktop control panel (physical input on the PC, showing the whole request); every game path
   * (Glass card, keys, keybinds, dev hooks) is "game", which can never approve a cut request. */
  decide(threadId: string, requestId: string, d: Decision, origin: DecisionOrigin = "game"): { ok: boolean; why?: string } {
    const t = this.threads.get(threadId);
    const e = t?.entries.find((x) => x.requestId === requestId && x.approval === "pending");
    if (!t || !e) return { ok: false, why: "no longer pending" };
    const grants = d !== "deny" && d !== "denyAndStop";
    if (grants && e.cut && origin !== "panel") {
      this.log("[hub] approve refused: cut request");
      refuse(e, "cut");
      this.toast("Open it in full on your PC to approve.", "info");
      return { ok: false, why: "cut" };
    }
    if (grants && Date.now() - e.at < this.minCardAgeMs) {
      refuse(e, "fresh");
      this.toast("That request just appeared. Read it, then decide.", "info");
      return { ok: false, why: "fresh" };
    }
    settle(e, d === "allow" ? "approved" : d === "allowAlways" ? "always" : "denied");
    this.lastDecisionAt = Date.now();
    if (t.kind === "tutorial") this.play(t, tutorialDecide(t, grants, uid)); // the practice card: nothing runs
    else this.backends[t.agent].respondApproval(t.id, requestId, d);
    this.dropToasts((x) => x.kind === "approval" && x.threadId === t.id);
    this.refreshStatus(t);
    this.changed("decide");
    return { ok: true };
  }

  /** Every pending approval for the control panel's "Requests waiting", whole, decided there with
   * decide(..., "panel") (a cut one only there). Real names: the panel is on the PC, not on stream.
   * Multiple-choice questions are not listed: they want an answer, not Approve / Deny (in game). */
  pendingRequests(): PendingRequest[] {
    return [...this.threads.values()].flatMap((t) =>
      t.entries
        .filter((e) => e.kind === "approval" && e.approval === "pending" && e.requestId && !e.options?.length)
        .map((e) => ({ thread: t.id, questTitle: t.title, project: this.projectName(t), agent: agentName(t.agent), requestId: e.requestId!,
          title: e.title ?? "", detail: e.text, ...(e.cut ? { full: e.full ?? e.text } : {}), cut: !!e.cut, canAlways: !!e.canAlways, at: e.at })),
    );
  }

  // ---- sending --------------------------------------------------------------------------------
  async prompt(text: string, ctx?: string) {
    text = text.trim();
    if (!text) return;
    if (this.view.list === "pick" && !this.view.draft) {
      // Typed a folder while picking a zone.
      const mk = text.match(/^mkdir\s+(.+)$/i);
      const p = (mk ? mk[1] : text).replace(/^"|"$/g, "").trim();
      if (/^[a-z]:[\\/]/i.test(p) || p.startsWith("~")) {
        let abs = path.resolve(p.replace(/^~/, process.env.USERPROFILE ?? "~"));
        if (isExcluded(abs, this.cfg())) return this.toast("That folder is on the exclusion list.", "error");
        if (!fs.existsSync(abs)) {
          if (!mk) return this.toast(`No such folder. Type "mkdir ${abs}" to create it.`, "info");
          fs.mkdirSync(abs, { recursive: true });
        }
        abs = realPath(abs); // junctions / 8.3 names must not slip past the boundary list
        if (isExcluded(abs, this.cfg())) return this.toast("That folder is on the exclusion list.", "error");
        const proj = this.projects.add(abs, Date.now());
        if (proj) this.beginDraft(this.agentOr(this.view.pickAgent), proj);
        this.changed("draft");
        return;
      }
      const proj = this.matchProject(text);
      if (proj) {
        this.beginDraft(this.agentOr(this.view.pickAgent), proj);
        this.toast(`Zone: ${proj.name} — now describe the quest`, "info", undefined, "Zone chosen — now describe the quest");
        this.changed("draft");
        return;
      }
      return this.toast("No zone matches that. Pick one on the left, or type a folder path.", "info");
    }
    if (this.view.draft) {
      const d = this.view.draft;
      this.view.draft = undefined;
      this.view.list = "quests";
      const t = d.chat ? this.createChat(text, d.agent, d.model) : this.createThread(d.agent, d.cwd, d.mode, d.model, text);
      await this.sendTo(t, text, ctx);
      return;
    }
    const sel = this.view.selected;
    if (sel?.startsWith("ext:")) {
      if (!this.external.has(sel)) return this.toast("That desktop conversation is no longer listed - pick it again or start a new quest.", "error");
      // Never continue a real desktop session silently: show a confirmation card first.
      this.view.confirm = { extId: sel, text };
      this.changed("confirm");
      return;
    }
    const t = this.selectedThread();
    if (!t) return this.toast("Select a quest, or start one with + Claude / + Codex (or + Chat).", "info");
    await this.sendTo(t, text, ctx);
  }

  /** "/fam ask <question>": continue the latest chat (or start one); `fresh` always starts one. */
  async ask(text: string, ctx?: string, fresh = false) {
    text = text.trim();
    if (!text) {
      this.beginChatDraft();
      this.changed("ask");
      return;
    }
    const latest = fresh ? undefined : [...this.threads.values()].filter((t) => t.kind === "chat").sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const t = latest ?? this.createChat(text);
    this.view.list = "quests";
    this.view.draft = undefined;
    this.select(t.id);
    await this.sendTo(t, text, ctx);
  }

  private beginChatDraft() {
    const c = this.cfg();
    const zone = this.projects.chats();
    this.view.list = "quests";
    const agent = this.agentOr(c.chatAgent);
    // The chat model belongs to the configured chat agent; a fallback agent uses its own default.
    this.view.draft = { agent, cwd: zone.path, projectKey: zone.key, mode: "ask", model: agent === c.chatAgent ? c.chatModel || undefined : undefined, chat: true };
    this.view.collapsed.delete(zone.key);
  }

  private createChat(firstText: string, agent = this.agentOr(this.cfg().chatAgent), model = agent === this.cfg().chatAgent ? this.cfg().chatModel || undefined : undefined): Thread {
    const t = this.createThread(agent, this.projects.chats(Date.now()).path, "ask", model, firstText);
    t.kind = "chat";
    t.projectKey = CHATS_KEY;
    return t;
  }

  /** Fuzzy zone match: exact name, then prefix, then substring (case-insensitive). */
  matchProject(q: string): Project | undefined {
    const n = q.trim().toLowerCase().replace(/^@/, "");
    if (!n) return undefined;
    const list = this.projects.list();
    return (
      list.find((p) => p.name.toLowerCase() === n) ??
      list.find((p) => p.name.toLowerCase().startsWith(n)) ??
      list.find((p) => p.name.toLowerCase().includes(n))
    );
  }

  async quick(agent: AgentKind, text: string) {
    // "/fam claude @zone task" starts the quest in a named zone.
    const at = text.match(/^@(\S+)\s*(.*)$/s);
    if (at) {
      const proj = this.matchProject(at[1]);
      if (!proj) return this.toast(`No zone matches "${at[1]}".`, "error");
      if (!at[2].trim()) {
        this.view.list = "pick";
        this.beginDraft(agent, proj);
        this.changed("quick");
        return;
      }
      const t = this.createThread(agent, proj.path, this.cfg().defaultMode, undefined, at[2]);
      await this.sendTo(t, at[2].trim());
      return;
    }
    // Never the tutorial's folder (Familiar's own data): it is not a zone.
    const sel = this.selectedThread();
    const base = (sel?.kind === "tutorial" ? undefined : sel?.cwd) ?? (this.view.selected ? this.external.get(this.view.selected)?.cwd : undefined) ?? this.projects.list()[0]?.path;
    if (!text || !base) {
      this.view.list = "pick";
      this.view.pickAgent = agent;
      this.changed("quick");
      return;
    }
    const t = this.createThread(agent, this.zonePath(base), this.cfg().defaultMode, undefined, text);
    await this.sendTo(t, text);
  }

  /** Messages from the game are untrusted input: cap what a runaway or hostile addon can start. */
  private budgets = { prompt: [] as number[], start: [] as number[] };
  private within(kind: "prompt" | "start", max: number, perMs: number, now = Date.now()): boolean {
    const b = (this.budgets[kind] = this.budgets[kind].filter((t) => now - t < perMs));
    if (b.length >= max) return false;
    b.push(now);
    return true;
  }

  private createThread(agent: AgentKind, cwd: string, mode: Mode, model: string | undefined, firstText: string): Thread {
    // Thrown, so the caller's fail() shows it once; nothing is created or sent.
    if (!this.within("start", START_BUDGET.max, START_BUDGET.perMs)) throw new Error("Too many new quests in 5 minutes (6). Wait a bit.");
    const proj = this.projects.add(cwd, Date.now());
    const now = Date.now();
    const t: Thread = {
      id: uid("q"),
      agent,
      cwd,
      projectKey: proj?.key ?? normPath(cwd),
      title: titleFrom(firstText),
      status: "new",
      mode,
      model,
      entries: [],
      todos: [],
      createdAt: now,
      updatedAt: now,
      unread: false,
      attentionSeen: null,
      origin: "familiar",
    };
    this.threads.set(t.id, t);
    this.view.selected = t.id;
    this.view.collapsed.delete(t.projectKey);
    // Every start is visible on the Glass, so one another addon makes can't pass unnoticed.
    this.toast(`Started: ${t.title} (${this.projectName(t)})`, "info", t.id, `${agentName(t.agent)} quest started`);
    for (const x of this.threads.values()) if (x.kind === "tutorial") this.play(x, tutorialSetOut(x));
    return t;
  }

  /** Turn a desktop-app thread into a hub quest: the same conversation, or a copy (fork) while
   * another app has it open (that app owns writing to it). */
  private async adopt(extId: string): Promise<Thread | undefined> {
    const x = this.external.get(extId);
    if (!x) return undefined;
    const fork = mustFork(x);
    const t: Thread = {
      id: uid("q"),
      agent: x.agent,
      nativeId: x.nativeId,
      cwd: x.cwd || this.projects.chats().path,
      projectKey: x.projectKey,
      title: x.title,
      status: "idle",
      mode: x.mode ?? this.cfg().defaultMode, // the desktop thread's own mode, made safe for the game
      entries: (this.extHistory.get(extId) ?? []).map(historyToEntry),
      todos: [],
      createdAt: x.createdAt ?? x.updatedAt,
      updatedAt: Date.now(),
      unread: false,
      origin: "external",
      adoptedFrom: x.nativeId,
    };
    const oldAttention = attentionEntry(t);
    t.attentionSeen = oldAttention ? attentionRevision(oldAttention) : null;
    t.fork = fork;
    if (fork) this.note(t, FORK_NOTE);
    this.threads.set(t.id, t);
    this.external.delete(extId);
    this.view.selected = t.id;
    return t;
  }

  private opening = new Map<string, Promise<string>>();
  /** Stop presses per quest, so a prompt still waiting for its provider to start is never sent. */
  private stops = new Map<string, number>();
  private chatSending = new Map<string, Promise<void>>();

  /** Keep context selection and submission in order even when chat prompts overlap. */
  private async sendChat(t: Thread, text: string, ctx?: string) {
    const previous = this.chatSending.get(t.id) ?? Promise.resolve();
    const sending = previous.catch(() => {}).then(async () => {
      const quests = this.addon.quests;
      const fresh = quests !== undefined && quests !== t.questsSent ? quests : undefined;
      await this.backends[t.agent].send(t.id, withGameContext(text, ctx, fresh));
      // Empty is a real snapshot; unavailable/off is undefined. Failed sends must retry it.
      if (fresh !== undefined) t.questsSent = fresh;
    });
    this.chatSending.set(t.id, sending);
    try {
      await sending;
    } finally {
      if (this.chatSending.get(t.id) === sending) this.chatSending.delete(t.id);
    }
  }

  /** Replying to a quest or stopping it is catching up: the note for what's there now is
   * acknowledged. Pending requests never are. (Merely having the quest selected is not: it stays
   * selected while the window is closed and the player is busy.) */
  private markCaughtUp(t: Thread) {
    const e = attentionEntry(t);
    if (e && !(e.kind === "approval" && e.approval === "pending")) t.attentionSeen = attentionRevision(e);
  }

  private async sendTo(t: Thread, text: string, ctx?: string) {
    const b = this.backends[t.agent];
    // The agent's own app has this conversation open and owns writing to it: ask (quit it and
    // Retry, or continue as a copy) instead of silently continuing a copy.
    if (t.nativeId && !t.fork && b.heldElsewhere?.(t.nativeId)) {
      if (this.view.held?.threadId === t.id) return this.toast("Choose Retry, Continue as a copy or Cancel first.", "info");
      this.view.held = { threadId: t.id, text, ctx };
      this.changed("held");
      return;
    }
    this.markCaughtUp(t);
    t.entries.push({ id: uid("u"), kind: "user", text, at: Date.now() });
    t.status = "running";
    t.updatedAt = Date.now();
    t.lastError = undefined;
    this.changed("send");
    if (!this.saveNow()) { // Provider work may start only after the user's words were saved.
      t.status = "error";
      t.lastError = "Not sent; this message is currently only in memory. Keep Familiar open, resolve saved-quest storage, then use Ctrl+Up and send again.";
      this.note(t, t.lastError, "error");
      throw new Error(t.lastError); // Outside provider-init handling: never claim this message is saved.
    }
    if (t.kind === "tutorial") return this.play(t, tutorialReply(t, uid)); // answered by the hub, no backend
    const stopsBefore = this.stops.get(t.id) ?? 0;
    const stopped = () => {
      if ((this.stops.get(t.id) ?? 0) === stopsBefore) return false;
      t.status = "idle";
      this.note(t, "Stopped before your message was sent. Ctrl+Up in the composer recalls it.");
      this.saveNow();
      return true;
    };
    let ready = false;
    try {
      if (!b.status().ready) {
        const st = await b.init();
        if (stopped()) return;
        if (!st.ready) throw new Error("Provider not ready");
      }
      ready = true;
      if (!b.isOpen(t.id)) {
        // One open per quest even if a second prompt arrives while the first open is in flight.
        let opening = this.opening.get(t.id);
        if (!opening) {
          opening = b
            .open({
              threadId: t.id,
              cwd: t.cwd,
              mode: t.mode,
              model: t.model,
              resumeNativeId: t.nativeId,
              fork: !!t.fork,
              chat: t.kind === "chat" ? { instructions: CHAT_INSTRUCTIONS, effort: this.cfg().chatEffort || undefined } : undefined,
            })
            .finally(() => this.opening.delete(t.id));
          this.opening.set(t.id, opening);
        }
        const nativeId = await opening;
        t.fork = false;
        t.nativeId = nativeId;
        if (stopped()) return;
      }
      // Chats get the player's game context (class, level, zone) in front of the question.
      if (t.kind === "chat") await this.sendChat(t, text, ctx);
      else await b.send(t.id, text);
    } catch (e: any) {
      t.status = "error";
      // Initialization diagnostics may contain credentials or private paths. Keep setup failures
      // actionable in the saved transcript and toast without copying the provider's exception.
      const setup = !ready && b.status().setup; // Familiar's own words, unlike the provider's exception
      t.lastError = ready ? String(e?.message ?? e) : setup ? `${setup}. Your message is saved: after that, use Ctrl+Up in the composer and send again.` :
        `${agentName(t.agent)} couldn't start. Your message is saved. Check setup and sign-in in the control panel's Familiars card, then use Ctrl+Up in the composer and send again.`;
      this.note(t, t.lastError, "error");
      this.saveNow(); // Keep the error/catch-up note too, even if Familiar closes immediately.
      throw ready ? e : new Error(t.lastError);
    }
  }

  // ---- agent events ---------------------------------------------------------------------------
  /** Dev/test only: feed a synthetic agent event (used by the FakeWoW visual checks). */
  injectAgentEvent(kind: AgentKind, e: AgentEvent) {
    this.onAgent(kind, e);
  }

  private onAgent(kind: AgentKind, e: AgentEvent) {
    const t = e.threadId ? this.threads.get(e.threadId) : undefined;
    if (!t) {
      if (e.type === "error") this.log(`[${kind}] ${e.message}`);
      return;
    }
    t.updatedAt = Date.now();
    switch (e.type) {
      case "session":
        t.nativeId = e.nativeId;
        if (e.model) t.model = t.model ?? e.model;
        break;
      case "turnStarted":
        t.status = "running";
        break;
      case "delta": {
        const id = e.channel === "reasoning" ? `r:${e.itemId}` : `a:${e.itemId}`;
        let entry = t.entries.find((x) => x.id === id);
        if (!entry) {
          entry = { id, kind: e.channel === "reasoning" ? "reasoning" : "assistant", text: "", at: Date.now(), streaming: true };
          t.entries.push(entry);
        }
        entry.text += e.text;
        this.changed("delta");
        return;
      }
      case "message": {
        const id = `a:${e.itemId}`;
        const entry = t.entries.find((x) => x.id === id);
        if (entry) {
          entry.text = e.text;
          entry.streaming = false;
        } else t.entries.push({ id, kind: "assistant", text: e.text, at: Date.now() });
        // Reasoning streams are transient; drop them once the answer lands.
        t.entries = t.entries.filter((x) => !(x.kind === "reasoning" && x.streaming));
        break;
      }
      case "tool": {
        const id = `t:${e.toolId}`;
        let entry = t.entries.find((x) => x.id === id);
        if (!entry && e.phase === "completed" && !e.name) break; // result for a tool we never showed
        if (!entry) {
          entry = { id, kind: "tool", name: e.name, text: e.summary, at: Date.now(), status: "running" };
          t.entries.push(entry);
        }
        if (e.phase === "completed") {
          entry.status = e.ok === false ? "error" : "ok";
          if (e.output) entry.output = e.output;
          if (e.name) entry.name = e.name;
          if (e.summary) entry.text = e.summary;
        }
        break;
      }
      case "todo":
        t.todos = e.items;
        t.todoNote = e.explanation;
        break;
      case "approval":
        t.entries.push({
          id: `p:${e.requestId}`,
          kind: "approval",
          requestId: e.requestId,
          title: e.title,
          text: e.detail,
          canAlways: e.canAlways,
          options: e.options,
          ...(e.cut ? { cut: true, full: e.full ?? e.detail } : {}),
          approval: "pending",
          at: Date.now(),
        });
        t.status = "approval";
        t.unread = this.view.selected !== t.id;
        {
          // A cut request is approved only on the PC: the toast says where, and main makes the panel easy to reach.
          const onPc = e.cut ? ` · ${CUT_TOAST}` : "";
          this.toast(`Needs approval · ${agentName(t.agent)} · ${this.projectName(t)} · ${e.title}${onPc}`, "approval", t.id, `Needs approval · ${agentName(t.agent)}${onPc}`, e.requestId);
        }
        this.sound("approval");
        if (e.cut) this.alertPc();
        break;
      case "approvalResolved": {
        const entry = t.entries.find((x) => x.requestId === e.requestId && x.approval === "pending");
        if (entry && entry.approval === "pending") settle(entry, "expired");
        this.refreshStatus(t);
        break;
      }
      case "usage":
        t.usage = { ...t.usage, ...stripUndef(e) };
        break;
      case "title":
        t.title = e.title;
        break;
      case "mode":
        t.mode = e.mode;
        break;
      case "done": {
        for (const x of t.entries) {
          x.streaming = false;
          if (x.kind === "tool" && x.status === "running") x.status = "unknown";
          if (x.kind === "approval" && x.approval === "pending") settle(x, "expired");
        }
        t.entries = t.entries.filter((x) => x.kind !== "reasoning");
        if (e.status === "failed" && isUsageLimit(e.error)) {
          // A used-up plan or rate limit isn't a fault: say so calmly and leave the quest ready.
          t.status = "idle";
          t.lastError = undefined;
          this.note(t, `${agentName(t.agent)} usage limit reached: ${e.error}. Send it again once the limit resets (Ctrl+Up recalls your message).`);
          this.toast(`${agentName(t.agent)}: usage limit reached for now`, "info", t.id);
        } else if (e.status === "failed") {
          t.status = "error";
          t.lastError = e.error ?? "failed";
          this.note(t, `Turn failed: ${t.lastError}`, "error");
          this.toast(`Quest Failed · ${t.title}`, "error", t.id, "Quest Failed");
          this.sound("error");
        } else {
          t.status = "idle";
          if (e.status === "interrupted") {
            this.note(t, STOPPED_NOTE);
            this.markCaughtUp(t); // the player stopped it; nothing to catch up on
          } else {
            const last = [...t.entries].reverse().find((x) => x.kind === "assistant");
            if (this.view.selected !== t.id) t.unread = true;
            // The moment, not a receipt: no agent, zone or cost ("Answer ready" for a chat).
            const moment = t.kind === "chat" ? "Answer ready" : "Quest Complete";
            this.toast(`${moment} · ${t.title}`, "done", t.id, moment);
            if (!this.cfg().quiet) this.sound("done");
            if (!this.cfg().quiet && !this.cfg().privateMode && this.cfg().speak && last) this.speak(`${agentName(t.agent)} finished in ${this.projectName(t)}. ${firstSentence(last.text, 200)}`);
          }
        }
        break;
      }
      case "error":
        this.note(t, e.message, "error");
        break;
      case "notice":
        this.note(t, e.message);
        break;
    }
    if (t.entries.length > MAX_ENTRIES * 1.5) t.entries = t.entries.slice(-MAX_ENTRIES);
    this.changed(e.type);
  }

  private refreshStatus(t: Thread) {
    const pending = t.entries.some((x) => x.kind === "approval" && x.approval === "pending");
    if (pending) t.status = "approval";
    else if (t.status === "approval") t.status = t.kind === "tutorial" ? "idle" : "running"; // the tutorial never has a turn running
  }

  private note(t: Thread, text: string, level: "info" | "error" = "info") {
    t.entries.push({ id: uid("n"), kind: "notice", text, at: Date.now(), level });
    this.changed("note");
  }

  toast(text: string, kind: Toast["kind"], threadId?: string, generic?: string, requestId?: string) {
    if (kind === "done" && this.cfg().quiet) return;
    const x: Toast = { id: this.toastSeq++, text, kind, at: Date.now(), threadId, ...(generic ? { generic } : {}), ...(requestId ? { requestId } : {}) };
    // In a fight, a quest's own notices wait (see setCombat); info toasts answer the player and show.
    if (this.combat && kind !== "info" && threadId) return void this.held.push(x);
    this.show(x);
    this.changed("toast");
  }

  private show(x: Toast) {
    this.toasts.push(x);
    if (this.toasts.length > 4) this.toasts.shift();
    this.onToast(x);
  }

  /** Drop toasts, shown or held for after a fight (the player opened the quest, decided it...). */
  private dropToasts(drop: (x: Toast) => boolean) {
    this.toasts = this.toasts.filter((x) => !drop(x));
    this.held = this.held.filter((x) => !drop(x));
  }

  private sound(kind: "done" | "approval" | "error") {
    if (!this.combat) this.onSound(kind); // in a fight: one chime for what was held, when it ends
  }

  private speak(text: string) {
    if (this.combat) this.heldSpeech = text;
    else this.onSpeak(text);
  }

  /** A cut request arrived: main surfaces the control panel on the PC (after a fight, like the rest). */
  private alertPc() {
    if (this.combat) this.heldPcAlert = true;
    else this.onCutRequest();
  }

  /** The player's character is in combat (the addon's layout.combat): quests' finish, approval and
   * failure notices, chimes and speech wait until it ends, then come back once (several as one
   * summary line plus each approval). Cards, the tracker, markers and the Approve glow keep
   * updating; nothing but a layout saying combat ended releases them. */
  setCombat(on: boolean) {
    if (on === this.combat) return;
    this.combat = on;
    if (on) return;
    const held = this.held.map((x) => ({ ...x, at: Date.now() }));
    const speech = this.heldSpeech;
    const pc = this.heldPcAlert;
    this.held = [];
    this.heldSpeech = undefined;
    this.heldPcAlert = false;
    if (pc && this.pendingRequests().some((r) => r.cut)) this.onCutRequest();
    if (!held.length) return;
    const count = (k: Toast["kind"]) => held.filter((x) => x.kind === k).length;
    const kind = count("approval") ? "approval" : count("error") ? "error" : "done";
    if (held.length === 1) {
      this.show(held[0]);
      if (speech) this.onSpeak(speech);
    } else {
      const [done, asks, failed] = [count("done"), count("approval"), count("error")];
      const text = "While you fought: " + [
        done && `${done} quest${done > 1 ? "s" : ""} finished`,
        asks && `${asks} need${asks > 1 ? "" : "s"} approval`,
        failed && `${failed} failed`,
      ].filter(Boolean).join(" · ");
      for (const x of held) if (x.kind === "approval") this.show(x); // each keeps its 60 s
      this.show({ id: this.toastSeq++, text, kind, at: Date.now(), generic: text }); // names nothing
      if (speech) this.onSpeak(text.replace(/ · /g, ", "));
    }
    this.onSound(kind);
    this.changed("toast");
  }

  setQuiet(on: boolean) {
    const cfg = this.cfg();
    if (cfg.quiet === on) return;
    cfg.quiet = on;
    if (on) this.dropToasts((t) => t.kind === "done");
    this.onConfigChanged(cfg);
    this.changed("quiet");
  }

  /** Private (streamer) mode: the render model and FamiliarSync snapshot use generic names (see
   * privateModel in viewmodel.ts); the hub and threads.json keep the real data. */
  setPrivate(on: boolean) {
    const cfg = this.cfg();
    if (!!cfg.privateMode === on) return;
    cfg.privateMode = on;
    if (!on) cfg.blurTranscript = false; // names shown again: no longer Stream-safe
    this.onConfigChanged(cfg);
    this.toast(on ? "Hide names on: project and quest names are hidden. Replies, approval cards and what you type stay visible." : "Hide names off.", "info");
    this.changed("config");
  }

  /** Stream-safe: Hide names, plus replies blurred on the Glass until clicked, plus no speech. Off
   * shows names and text again; speech stays off (turning it on is the player's own choice). */
  setStream(on: boolean) {
    const cfg = this.cfg();
    if (!!cfg.privateMode === on && !!cfg.blurTranscript === on && !(on && cfg.speak)) return;
    cfg.privateMode = on;
    cfg.blurTranscript = on;
    if (on) cfg.speak = false;
    this.onConfigChanged(cfg);
    this.toast(on ? "Stream-safe on: names hidden, replies blurred. Click a blurred reply to read it for 8 seconds." : "Stream-safe off.", "info");
    this.changed("config");
  }

  private pruneToasts() {
    const now = Date.now();
    const keep = this.toasts.filter((x) => now - x.at < (x.kind === "approval" ? 60_000 : 9_000));
    if (keep.length !== this.toasts.length) {
      this.toasts = keep;
      this.changed("toast");
    }
  }

  projectName(t: { projectKey: string; cwd: string }) {
    return this.projects.get(t.projectKey)?.name ?? path.basename(t.cwd);
  }

  async shutdown() {
    this.saveNow();
    await Promise.all(Object.values(this.backends).map((b) => b.shutdown().catch(() => {})));
  }
}

export function agentName(a: AgentKind) {
  return providerLabel(a);
}

function stillHeld(a: AgentKind) {
  return `Still open in the ${agentName(a)} app or a terminal. Quit it there, then press Retry.`;
}

function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function nextOf<T>(list: T[], cur: T): T {
  const i = list.indexOf(cur);
  return list[(i + 1) % list.length];
}

function titleFrom(text: string) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? text;
  return line.trim().length > 60 ? line.trim().slice(0, 57) + "…" : line.trim();
}

export function firstSentence(text: string, max = 90) {
  const clean = text.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  const m = clean.match(/^(.{10,}?[.!?])(\s|$)/);
  const s = m ? m[1] : clean;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** A request leaves "pending" (decided, answered or expired); a refusal written on it goes too. */
function settle(e: Entry, approval: NonNullable<Entry["approval"]>) {
  e.approval = approval;
  delete e.refused;
}

/** Write a refusal on the pending card it was about, where it stays until a decision (toasts expire).
 * A cut card always says why it matters most: it can only be approved on the PC. */
function refuse(e: Entry | undefined, why: Refusal) {
  if (e?.kind === "approval" && e.approval === "pending") e.refused = { why: e.cut ? "cut" : why, at: Date.now() };
}

function stripUndef(o: any) {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== "type" && k !== "threadId") out[k] = v;
  return out;
}

function historyToEntry(h: HistoryEntry): Entry {
  if (h.kind === "tool")
    return { id: uid("t"), kind: "tool", name: h.name, text: h.summary, status: h.ok === false ? "error" : "ok", output: h.output, at: 0 };
  return { id: uid(h.kind[0]), kind: h.kind, text: h.text, at: h.at ?? 0 };
}

export { historyToEntry };

/** Game context the addon attaches to prompts (used for chats only). */
function ctxOf(msg: any): string | undefined {
  return typeof msg?.ctx === "string" && msg.ctx.trim() ? msg.ctx : undefined;
}

/** Plan / quota / rate limits ("usage balance exhausted", 402, 429...), as opposed to real failures. */
export function isUsageLimit(error?: string): boolean {
  return /usage (balance|limit)|balance exhausted|quota|rate.?limit|too many requests|\b(402|429)\b|credits? (exhausted|used up|remaining)|limit reached|out of (credits|usage)/i.test(error ?? "");
}

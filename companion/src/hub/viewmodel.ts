// Builds the render model the Glass overlay paints. Pure function of Hub state (+ link state).
import * as path from "node:path";
import { attentionItems, type AttentionItem } from "./attention";
import { providerInfo } from "../agents/providers";
import { AgentKind, MODE_LABEL, TodoItem } from "../agents/types";
import { agentName, approveAgain, Entry, ExternalThread, Hub, mustFork, NO_KEY, oneMoment, Refusal, textHash, Thread, ThreadStatus, Toast } from "./hub";
import type { Config } from "./config";
import { CHATS_KEY } from "./projects";
import { costLabel, dollars, fmtK } from "./rewards";
import { NEEDS_YOU, needYou } from "../shared/words";

export type Act = Record<string, unknown> & { type: string };

export interface Row {
  kind: "zone" | "thread" | "ext" | "project" | "header" | "hint" | "agent";
  key: string;
  text: string;
  sub?: string;
  agent?: AgentKind;
  status?: ThreadStatus;
  unread?: boolean;
  selected?: boolean;
  collapsed?: boolean;
  count?: number;
  act?: Act;
  act2?: Act; // right-click
}

export interface EntryView {
  id: string;
  kind: Entry["kind"];
  text: string;
  streaming?: boolean;
  name?: string;
  status?: string;
  output?: string;
  expanded?: boolean;
  title?: string;
  approval?: string;
  canAlways?: boolean;
  options?: string[];
  requestId?: string;
  level?: string;
  /** approval: the text is a cut preview, so the card offers Deny only (approve on the PC). */
  cut?: boolean;
  /** approval: why the last approving click was refused, as the line the card shows. */
  refused?: string;
}

export interface ProviderView {
  id: string;
  label: string;
  enabled: boolean;
  ready: boolean;
  status: string;
}

export type DetailModel =
  | {
      kind: "welcome";
      linked: boolean;
      linkedChar?: string;
      backends: ProviderView[];
      chat: ProviderView & { model?: string; act: Act };
      counts: { running: number; approval: number; total: number };
      /** Project folders known (configured or from agent history); 0: nowhere to start a quest yet. */
      zones: number;
    }
  | { kind: "pick"; agent: AgentKind }
  | {
      kind: "models";
      chat: boolean;
      groups: { agent: AgentKind; label: string; models: { id: string; label: string; current: boolean; newChat: boolean }[] }[];
      effort?: { current: string; options: string[] };
    }
  | { kind: "draft"; agent: AgentKind; project: string; cwd: string; mode: string; model?: string; chat?: boolean; provider?: ProviderView }
  | {
      kind: "thread";
      id: string;
      external: boolean;
      title: string;
      agent: AgentKind;
      project: string;
      cwd: string;
      status: ThreadStatus;
      mode: string;
      model?: string;
      usage?: string;
      todos: TodoItem[];
      todoNote?: string;
      entries: EntryView[];
      loading?: boolean;
      historyError?: string;
      historyEmpty?: boolean;
      /** Entries exist before the rendered window ("Load earlier" row). */
      more?: boolean;
      /** Waiting for the user to confirm continuing this desktop conversation. `retry`: the app
       * holding it can be quit and the same conversation continued (the agent can tell). */
      confirm?: { text: string; fork: boolean; retry: boolean; hash: string };
      /** A message held back because the agent's own app has this conversation open. `hash`: of the
       * text, put in the card's actions so a proof covers exactly the text painted (hub textCardAct). */
      held?: { text: string; hash: string };
      /** "Continue in <app>" is offered: the agent has an app and nothing is running here. */
      handOff?: { app: string };
      /** Desktop/CLI thread: where it came from and why it is listed ("desktop app · pinned"). */
      source?: string;
    };

export interface TrackerLine {
  id: string;
  agent: AgentKind;
  title: string;
  project: string;
  status: ThreadStatus;
  activity: string;
  progress?: string;
  /** The agent's own reported spend ("$0.14", "<$0.01") or tokens ("8.2k tokens"). Display only. */
  cost?: string;
}

export interface RenderModel {
  storage?: { level: "warn" | "error"; text: string };
  quiet?: boolean;
  /** Private (streamer) mode: names below are generic and desktop threads are left out. */
  private?: boolean;
  attention?: AttentionItem[];
  seq: number;
  /** Where the next message typed in the composer will go (shown under the details pane). */
  target: { text: string; warn?: boolean };
  list: { title: string; rows: Row[] };
  detail: DetailModel;
  status: { text: string; level: "ok" | "warn" | "off" };
  /** `approve`: a request is waiting somewhere; `stop`: the selected quest has a turn to stop (the
   * Glass glows the native Stop button). */
  keys: { approve: boolean; stop: boolean };
  /** Stream-safe: the Glass blurs replies (never approval cards) until clicked. */
  blur?: boolean;
  tracker: TrackerLine[];
  toasts: Toast[];
  fontScale: number;
  /** Notices big mid-screen (raid warnings) or small inside the Familiar window. */
  raidWarnings: boolean;
  /** Label and glyph per provider id, for rows and headers. */
  providers: Record<string, { label: string; glyph: string }>;
}

let seq = 0;

export function buildModel(hub: Hub, link: { linked: boolean; fps: number }): RenderModel {
  const v = hub.view;
  const threads = [...hub.threads.values()];
  const anyPending = threads.some((t) => t.status === "approval");
  const sel = hub.selectedThread();
  const attention = attentionItems(hub);
  const m: RenderModel = {
    storage: hub.storage,
    quiet: !!hub.cfg().quiet,
    attention,
    seq: ++seq,
    target: targetLine(hub),
    // Private mode leaves desktop threads out of the list (their titles are not ours to alias).
    list: v.list === "pick" ? pickList(hub) : questList(hub, !!hub.cfg().privateMode),
    detail: detail(hub, link.linked),
    status: statusLine(hub, link),
    keys: { approve: anyPending, stop: !!sel && (sel.status === "running" || sel.status === "approval") },
    tracker: trackerLines(hub),
    toasts: hub.toasts,
    fontScale: hub.cfg().fontScale,
    raidWarnings: hub.cfg().raidWarnings !== false,
    // The tutorial's "familiar" is not a backend but has quest rows of its own.
    providers: Object.fromEntries([...Object.keys(hub.backends), "familiar"].map((id) => [id, { label: providerInfo(id).label, glyph: providerInfo(id).glyph }])),
  };
  if (hub.cfg().privateMode) privateModel(hub, m, link.linked);
  if (hub.cfg().quiet && m.attention?.length) m.tracker.unshift({ id: m.attention[0].thread, agent: m.attention[0].agent,
    title: `${m.attention.length} waiting for you`, project: "Quiet play", status: "idle", activity: "/fam opens your saved catch-up notes" });
  m.tracker = m.tracker.slice(0, 8);
  return m;
}

// ---- private (streamer) mode --------------------------------------------------------------------
// The one place real names leave the render model: zones become "Project n", quests "Quest #n" and
// chats "Chat #n" (numbered in first-seen order, stable for the session), desktop threads are left
// out, and notices lose their names. The hub and threads.json keep the real data. Pending approval
// cards keep their full preview: the player must see what they approve.

const aliases = new WeakMap<Hub, { zones: Map<string, number>; quests: Map<string, number>; chats: Map<string, number> }>();

function privateNames(hub: Hub) {
  let a = aliases.get(hub);
  if (!a) aliases.set(hub, (a = { zones: new Map(), quests: new Map(), chats: new Map() }));
  const names = a;
  const num = (m: Map<string, number>, key: string) => {
    if (!m.has(key)) m.set(key, m.size + 1);
    return m.get(key)!;
  };
  const zone = (key: string) => (key === CHATS_KEY ? "Chats" : `Project ${num(names.zones, key)}`);
  const thread = (id: string) => (hub.threads.get(id)?.kind === "chat" ? `Chat #${num(names.chats, id)}` : `Quest #${num(names.quests, id)}`);
  return { zone, thread };
}

/** Generic toast text: never a project, title, command or reply excerpt. */
function privateToast(x: Toast): Toast {
  const text = x.generic ?? (x.kind === "approval" ? "Approval needed" : x.kind === "done" ? "Quest Complete" : x.kind === "error" && x.threadId ? "Quest Failed" : x.text);
  return { ...x, text };
}

function privateModel(hub: Hub, m: RenderModel, linked: boolean) {
  const { zone, thread } = privateNames(hub);
  const v = hub.view;
  m.private = true;
  if (hub.cfg().blurTranscript) m.blur = true; // Stream-safe
  // Quest Log first, so numbering follows the order the player sees. Desktop threads are already left
  // out (questList), so every zone here has quests of its own, or is Chats.
  const rows = m.list.rows.map((r): Row => (r.kind === "zone" || r.kind === "project" ? { ...r, text: zone(r.key) } : r.kind === "thread" ? { ...r, text: thread(r.key) } : r));
  m.list = { ...m.list, rows };

  const d = m.detail;
  if (d.kind === "thread" && d.external) m.detail = welcome(hub, linked);
  else if (d.kind === "thread") {
    const t = hub.threads.get(d.id);
    m.detail = { ...d, title: thread(d.id), project: t ? zone(t.projectKey) : "", cwd: "" };
  } else if (d.kind === "draft" && v.draft) m.detail = { ...d, project: zone(v.draft.projectKey), cwd: "" };

  const sel = hub.selectedThread();
  if (v.draft) m.target = { text: v.draft.chat ? `New chat with ${agentName(v.draft.agent)}` : `New ${agentName(v.draft.agent)} quest in ${zone(v.draft.projectKey)}` };
  else if (sel) m.target = { text: sel.kind === "chat" ? thread(sel.id) : `${agentName(sel.agent)} - ${thread(sel.id)} - ${zone(sel.projectKey)}` };
  else if (v.selected?.startsWith("ext:")) m.target = { text: "Desktop conversations are hidden in private mode", warn: true };

  m.tracker = m.tracker.map((l) => {
    const t = hub.threads.get(l.id);
    const activity = l.status === "approval" ? NEEDS_YOU : l.status === "error" ? "Failed" : l.status === "running" ? "Working" : "Finished";
    return { ...l, title: thread(l.id), project: t ? zone(t.projectKey) : "", activity };
  });
  m.attention = m.attention?.map((i) => {
    const t = hub.threads.get(i.thread);
    // A pending request keeps its title (what is being approved); replies wait in the quest itself.
    return { ...i, title: thread(i.thread), project: t ? zone(t.projectKey) : "", cwd: "", excerpt: i.pending ? i.excerpt : "" };
  });
  m.toasts = m.toasts.map(privateToast);
}

/** Rows a zone lists before "+N more". Rows that need you, are working, or are open always show. */
export const ROWS_PER_ZONE = 5;

// Zones keep one order: Chats, then by name. Live activity never moves a zone, because clicks are
// hit-tested by position and a right-click archives; what needs you is a glyph on the zone and the row.
// Inside a zone the newest is on top: your quests by when they started (a reply never moves a row), then
// desktop threads by their last activity. Each row says how long ago it last moved.
function questList(hub: Hub, noDesktop = false): { title: string; rows: Row[] } {
  const v = hub.view;
  type Item = { kind: "thread"; t: Thread; at: number; since: number } | { kind: "ext"; id: string; x: ExternalThread; at: number; since: number };
  const zones = new Map<string, { name: string; items: Item[] }>();
  const zoneOf = (key: string, cwd: string) => {
    let z = zones.get(key);
    if (!z) {
      z = { name: hub.projects.get(key)?.name ?? path.basename(cwd), items: [] };
      zones.set(key, z);
    }
    return z;
  };
  const shown = (agent: AgentKind) => !v.show.length || v.show.includes(agent);
  for (const t of hub.threads.values()) if (shown(t.agent)) zoneOf(t.projectKey, t.cwd).items.push({ kind: "thread", t, at: t.updatedAt, since: t.createdAt });
  if (!noDesktop)
    for (const [id, x] of hub.external) if (shown(x.agent)) zoneOf(x.projectKey, x.cwd).items.push({ kind: "ext", id, x, at: x.updatedAt, since: x.updatedAt });
  // The Chats zone is always there (it is how you start a chat) and always first.
  if (!v.show.length || v.show.includes(hub.cfg().chatAgent)) zoneOf(CHATS_KEY, "Chats");
  const rows: Row[] = [];
  const byName = ([ka, a]: [string, { name: string }], [kb, b]: [string, { name: string }]) =>
    Number(kb === CHATS_KEY) - Number(ka === CHATS_KEY) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || ka.localeCompare(kb);
  for (const [key, z] of [...zones.entries()].sort(byName)) {
    const collapsed = v.collapsed.has(key);
    const status = (i: Item): ThreadStatus | undefined => (i.kind === "thread" ? i.t.status : i.x.running ? "running" : undefined);
    const has = (s: ThreadStatus) => z.items.some((i) => status(i) === s);
    rows.push({
      kind: "zone",
      key,
      text: z.name,
      count: z.items.length || undefined,
      collapsed,
      // The zone's mark: the most urgent of its rows, so a collapsed zone still says it needs you.
      status: has("approval") ? "approval" : has("error") ? "error" : has("running") ? "running" : undefined,
      unread: z.items.some((i) => i.kind === "thread" && i.t.unread) || undefined,
      act: { type: "zone", key },
      act2: { type: "newIn", key },
    });
    if (collapsed) continue;
    const items = z.items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "thread" ? -1 : 1) || b.since - a.since);
    const all = v.zoneAll.has(key);
    const extCap = all ? Infinity : hub.cfg().externalPerZone;
    const id = (i: Item) => (i.kind === "thread" ? i.t.id : i.id);
    const live = (i: Item) => ["approval", "running", "error"].includes(status(i) ?? "");
    const keep = (i: Item) => v.selected === id(i) || live(i) || (i.kind === "thread" && !!i.t.unread);
    const zoneRows: (Row & { at: number; pin?: boolean })[] = [];
    let extShown = 0,
      hidden = 0;
    for (const i of items) {
      const fits = all || (zoneRows.length < ROWS_PER_ZONE && (i.kind === "thread" || extShown < extCap));
      if (!fits && !keep(i)) {
        hidden++;
        continue;
      }
      if (i.kind === "ext") extShown++;
      zoneRows.push(
        i.kind === "thread"
          ? { kind: "thread", key: i.t.id, text: i.t.title, agent: i.t.agent, status: i.t.status, unread: i.t.unread, sub: ago(i.at), at: i.at,
              selected: v.selected === i.t.id, act: { type: "select", id: i.t.id }, act2: { type: "archive", id: i.t.id } }
          : { kind: "ext", key: i.id, text: i.x.title, agent: i.x.agent, status: i.x.running ? "running" : undefined, sub: ago(i.at), at: i.at, pin: i.x.reason === "pinned",
              selected: v.selected === i.id, act: { type: "select", id: i.id }, act2: { type: "archive", id: i.id } },
      );
    }
    // Rows with the same title tell apart by age; when the age reads the same too, by the time itself.
    const twins = zoneRows.filter((r) => zoneRows.some((o) => o !== r && o.text === r.text && o.sub === r.sub));
    for (const r of twins) r.sub = stamp(r.at);
    for (const { at: _at, pin, ...r } of zoneRows) rows.push(pin ? { ...r, sub: `★ ${r.sub}` } : r);
    if (hidden) rows.push({ kind: "hint", key: `more:${key}`, text: `+${hidden} more`, act: { type: "zoneMore", key } });
    if (key === CHATS_KEY && !items.length) rows.push({ kind: "hint", key: "chat-hint", text: "Ask anything: + Chat or /fam ask", act: { type: "newIn", key } });
  }
  if (!rows.length)
    rows.push({ kind: "hint", key: "hint", text: v.show.length ? "Nothing here for this filter — /fam show all" : "Choose Chat for a question, or start a project quest." });
  return { title: v.show.length ? `Quest Log · ${v.show.map(agentName).join(" + ")}` : "Quest Log", rows };
}

function pickList(hub: Hub): { title: string; rows: Row[] } {
  const agent = hub.view.pickAgent;
  // Which agent: one row per installed provider (Claude, Codex, Hermes, Grok, ...).
  const ids = Object.keys(hub.backends).filter((id) => hub.enabled(id));
  const rows: Row[] =
    ids.length > 2
      ? ids.map((id) => ({ kind: "agent" as const, key: `agent:${id}`, text: agentName(id), agent: id, selected: id === agent, act: { type: "agent", agent: id } }))
      : [];
  rows.push({ kind: "header", key: "h", text: `Choose a zone for ${agentName(agent)}` });
  for (const p of hub.projects.list()) {
    rows.push({
      kind: "project",
      key: p.key,
      text: p.name,
      sub: p.lastActivity ? ago(p.lastActivity) : undefined,
      selected: hub.view.draft?.projectKey === p.key,
      act: { type: "pick", key: p.key },
    });
  }
  rows.push({ kind: "hint", key: "other", text: "…or type a folder path below" });
  return { title: "New Quest", rows };
}

function detail(hub: Hub, linked: boolean): DetailModel {
  const v = hub.view;
  if (v.picker && (v.draft || hub.selectedThread())) return modelList(hub);
  if (v.draft) {
    const p = hub.projects.get(v.draft.projectKey);
    return {
      kind: "draft",
      agent: v.draft.agent,
      project: p?.name ?? path.basename(v.draft.cwd),
      cwd: v.draft.cwd,
      mode: v.draft.chat ? "Chat (web search only)" : MODE_LABEL[v.draft.mode],
      model: v.draft.model,
      chat: v.draft.chat,
      provider: v.draft.chat ? providerView(hub, v.draft.agent) : undefined,
    };
  }
  if (v.list === "pick") return { kind: "pick", agent: v.pickAgent };
  const t = hub.selectedThread();
  if (t) return threadDetail(hub, t);
  if (v.selected?.startsWith("ext:")) {
    const x = hub.external.get(v.selected);
    if (x) {
      const hist = hub.extHistory.get(v.selected);
      const history = hub.extHistoryState.get(v.selected);
      const win = v.window[v.selected] ?? 150;
      const fork = mustFork(x);
      const confirm = v.confirm?.extId === v.selected ? { text: v.confirm.text, fork, retry: fork && !!hub.backends[x.agent]?.heldElsewhere, hash: textHash(v.confirm.text) } : undefined;
      const from = originLabel(x.origin);
      const why = x.reason === "pinned" ? (x.starred ? "starred" : "pinned") : x.reason === "running" ? "working now" : "recent";
      return {
        kind: "thread",
        id: v.selected,
        external: true,
        title: x.title,
        agent: x.agent,
        project: hub.projects.get(x.projectKey)?.name ?? path.basename(x.cwd),
        cwd: x.cwd,
        status: x.running ? "running" : "idle",
        mode: MODE_LABEL[x.mode ?? hub.cfg().defaultMode],
        source: `from ${from} · ${why}`,
        todos: [],
        more: !!hist && hist.length >= win,
        confirm,
        handOff: hub.backends[x.agent]?.handOff ? { app: providerInfo(x.agent).label } : undefined,
        entries: groupTools(
          hub,
          (hist ?? []).slice(-win).map(
            (h, i): Entry => ({
              id: `${v.selected}:h${i}`,
              kind: h.kind,
              text: h.kind === "tool" ? h.summary : h.text,
              name: h.kind === "tool" ? h.name : undefined,
              status: h.kind === "tool" ? (h.ok === false ? "error" : "ok") : undefined,
              output: h.kind === "tool" ? h.output : undefined,
              at: 0,
            }),
          ),
        ).map((e) => ({
          id: e.id,
          kind: e.kind,
          text: e.text,
          name: e.name,
          status: e.status,
          output: hub.view.expanded.has(e.id) ? e.output : undefined,
          expanded: hub.view.expanded.has(e.id),
        })),
        loading: history?.loading ?? false,
        historyError: history?.error ?? (!hist && !history?.loading ? "History hasn't been loaded yet." : undefined),
        historyEmpty: !!hist && !hist.length && !history?.loading && !history?.error,
      };
    }
  }
  return welcome(hub, linked);
}

function welcome(hub: Hub, linked: boolean): DetailModel {
  const threads = [...hub.threads.values()];
  return {
    kind: "welcome",
    linked,
    linkedChar: linked ? hub.addon.char : undefined,
    backends: providerViews(hub),
    chat: { ...providerView(hub, hub.cfg().chatAgent), model: hub.cfg().chatModel || undefined, act: { type: "newIn", key: CHATS_KEY } },
    counts: {
      running: threads.filter((t) => t.status === "running").length,
      approval: threads.filter((t) => t.status === "approval").length,
      total: threads.length,
    },
    zones: hub.projects.list().length,
  };
}

function threadDetail(hub: Hub, t: Thread): DetailModel {
  const u = t.usage;
  const usage = u
    ? [u.inputTokens ? `${fmtK(u.inputTokens)} in` : "", u.outputTokens ? `${fmtK(u.outputTokens)} out` : "", u.costUsd ? dollars(u.costUsd) : ""]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  return {
    kind: "thread",
    id: t.id,
    external: false,
    title: t.title,
    agent: t.agent,
    project: hub.projectName(t),
    cwd: t.cwd,
    status: t.status,
    mode: t.kind === "chat" ? "Chat" : MODE_LABEL[t.mode],
    model: t.model,
    usage,
    todos: t.todos,
    todoNote: t.todoNote,
    held: hub.view.held?.threadId === t.id ? { text: hub.view.held.text, hash: textHash(hub.view.held.text) } : undefined,
    handOff: t.nativeId && hub.backends[t.agent]?.handOff && t.status !== "running" && t.status !== "approval" ? { app: providerInfo(t.agent).label } : undefined,
    more: t.entries.length > (hub.view.window[t.id] ?? 150),
    entries: groupTools(hub, t.entries.slice(-(hub.view.window[t.id] ?? 150))).map((e) => ({
      id: e.id,
      kind: e.kind,
      text: e.text,
      streaming: e.streaming,
      name: e.name,
      status: e.status,
      output: hub.view.expanded.has(e.id) ? e.output : undefined,
      expanded: hub.view.expanded.has(e.id),
      title: e.title,
      approval: e.approval,
      canAlways: e.canAlways,
      options: e.options,
      requestId: e.requestId,
      level: e.level,
      cut: e.cut,
      refused: e.refused && e.approval === "pending" ? refusedLine(e.refused.why, hub.cfg()) : undefined,
    })),
  };
}

/** The red line a refused card shows until the next decision (the toast says it too, but expires).
 * The Approve key comes first; clicking is named only while click approval is switched on; with
 * neither, Requests waiting on the PC (approveAgain). */
function refusedLine(why: Refusal, c: Config): string {
  const again = approveAgain(c);
  return {
    proof: again ? `Not confirmed as yours. With this request on screen, ${again}.` : NO_KEY,
    fresh: oneMoment(c),
    cut: "Part of this request is hidden here. Approve it in full from Familiar's control panel on your PC, or Deny.",
    view: "Use Full view and review the request before deciding.",
  }[why];
}

/**
 * Tool-call display per config: "full" = every call; "hidden" = none (running calls still show as
 * one live line); "compact" = each run of consecutive calls collapses into one clickable summary
 * line ("5 steps - Bash x3, Read x2"), expanded on click.
 */
function groupTools(hub: Hub, entries: Entry[]): Entry[] {
  const mode = hub.cfg().toolDetail ?? "compact";
  if (mode === "full") return entries;
  const out: Entry[] = [];
  let run: Entry[] = [];
  const flush = () => {
    if (!run.length) return;
    const gid = `g:${run[0].id}`;
    const running = run.some((e) => e.status === "running");
    const failed = run.filter((e) => e.status === "error").length;
    if (mode === "hidden") {
      if (running) out.push({ ...run[run.length - 1] });
    } else if (hub.view.expanded.has(gid)) {
      out.push(groupEntry(gid, run, running, failed, true), ...run);
    } else out.push(groupEntry(gid, run, running, failed, false));
    run = [];
  };
  for (const e of entries) {
    if (e.kind === "tool") run.push(e);
    else {
      flush();
      out.push(e);
    }
  }
  flush();
  return out;
}

function groupEntry(id: string, run: Entry[], running: boolean, failed: number, open: boolean): Entry {
  const counts = new Map<string, number>();
  for (const e of run) counts.set(e.name ?? "tool", (counts.get(e.name ?? "tool") ?? 0) + 1);
  const names = [...counts].map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join(", ");
  const last = run[run.length - 1];
  const unknown = run.filter(e => e.status === "unknown").length;
  const text = running ? `${names} - now: ${last.name}: ${last.text}` : names + (failed ? ` (${failed} failed)` : "") + (unknown ? ` (${unknown} outcome${unknown > 1 ? "s" : ""} unknown)` : "");
  return {
    id,
    kind: "tool",
    name: `${open ? "-" : "+"} ${run.length} step${run.length > 1 ? "s" : ""}`,
    text,
    status: running ? "running" : failed ? "error" : unknown ? "unknown" : "ok",
    at: run[0].at,
  };
}

function targetLine(hub: Hub): RenderModel["target"] {
  const v = hub.view;
  const zone = (key: string, cwd: string) => hub.projects.get(key)?.name ?? path.basename(cwd);
  if (v.draft?.chat) return { text: `New chat with ${agentName(v.draft.agent)}${v.draft.model ? ` (${v.draft.model})` : ""}` };
  if (v.draft) return { text: `New ${agentName(v.draft.agent)} quest in ${zone(v.draft.projectKey, v.draft.cwd)}` };
  if (v.list === "pick") return { text: "Type a zone name or a folder path" };
  const t = hub.selectedThread();
  if (t) return { text: t.kind === "chat" ? `Chat - ${t.title}` : `${agentName(t.agent)} - ${t.title} - ${hub.projectName(t)} - ${MODE_LABEL[t.mode]}` };
  if (v.selected?.startsWith("ext:")) {
    const x = hub.external.get(v.selected);
    if (x) return { text: `Desktop ${agentName(x.agent)} conversation in ${zone(x.projectKey, x.cwd)} (asks before continuing)`, warn: true };
  }
  return { text: "Nothing selected · pick a quest, or start one above." };
}

function trackerLines(hub: Hub): TrackerLine[] {
  const now = Date.now();
  return [...hub.threads.values()]
    .filter((t) => t.status === "running" || t.status === "approval" || ((t.status === "error" || t.unread) && now - t.updatedAt < 30 * 60_000))
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    .slice(0, 8)
    .map((t) => {
      const lastTool = [...t.entries].reverse().find((e) => e.kind === "tool");
      const doing = t.todos.find((x) => x.status === "in_progress");
      const done = t.todos.filter((x) => x.status === "completed").length;
      let activity =
        t.status === "approval"
          ? NEEDS_YOU
          : t.status === "error"
            ? "Failed — " + (t.lastError ?? "")
            : t.status === "running"
              ? doing?.text ?? (lastTool ? `${lastTool.name}: ${lastTool.text}` : "Thinking…")
              : "Finished — " + lastLine(t);
      if (activity.length > 70) activity = activity.slice(0, 69) + "…";
      return {
        id: t.id,
        agent: t.agent,
        title: t.title,
        project: hub.projectName(t),
        status: t.status,
        activity,
        progress: t.todos.length ? `${done}/${t.todos.length}` : undefined,
        cost: costLabel(t.usage),
      };
    });
}

function rank(t: Thread) {
  return t.status === "approval" ? 0 : t.status === "running" ? 1 : t.status === "error" ? 2 : 3;
}

function lastLine(t: Thread) {
  const a = [...t.entries].reverse().find((e) => e.kind === "assistant");
  return a ? a.text.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
}

function statusLine(hub: Hub, link: { linked: boolean; fps: number }): RenderModel["status"] {
  const threads = [...hub.threads.values()];
  const running = threads.filter((t) => t.status === "running").length;
  const approval = threads.filter((t) => t.status === "approval").length;
  const parts = [link.linked ? "Linked" : "Searching for the Runestrip…"];
  const providers = providerViews(hub);
  parts.push(...providers.map((p) => `${p.label} ${!p.enabled ? "off" : p.ready ? "✓" : "✗"}`));
  if (running) parts.push(`${running} running`);
  if (approval) parts.push(needYou(approval));
  const versions = hub.versionMismatch();
  if (versions) parts.push(`addon ${versions.addon} / app ${versions.app}`);
  return { text: parts.join("  ·  "), level: !link.linked ? "off" : approval || !providers.some((p) => p.ready) ? "warn" : "ok" };
}

function providerViews(hub: Hub): ProviderView[] {
  // Keep configured choices visible even when switched off or their backend is absent.
  const ids = new Set([...Object.keys(hub.backends), ...Object.keys(hub.cfg().providers ?? {}), hub.cfg().chatAgent]);
  return [...ids].map((id) => providerView(hub, id));
}

function providerView(hub: Hub, id: AgentKind): ProviderView {
  const enabled = hub.enabled(id);
  const s = hub.backends[id]?.status();
  return {
    id,
    label: providerInfo(id).label,
    enabled,
    ready: enabled && !!s?.ready,
    status: !enabled ? "switched off" : !s ? "not available in Familiar" : s.ready
      ? `ready${s.account ? ` (${s.account})` : ""}` : `not ready${s.error ? `: ${s.error}` : ""}`,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "12 Nov 14:05": the time itself, for rows whose title and age read the same. */
export function stamp(ms: number) {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Where a desktop/CLI/bot thread came from, for "from ... · recent". */
function originLabel(origin?: string): string {
  if (!origin || origin === "desktop") return "the desktop app";
  if (origin === "cli") return "the CLI";
  if (origin === "acp") return "an editor";
  return origin.charAt(0).toUpperCase() + origin.slice(1).replace(/_/g, " "); // Telegram, Discord, Api server...
}

/** The Model button's list: this agent's models; in a chat, every chat-capable agent's models. */
function modelList(hub: Hub): DetailModel {
  const v = hub.view;
  const t = hub.selectedThread();
  const target = v.draft ?? t!;
  const chat = !!(v.draft?.chat || (!v.draft && t?.kind === "chat"));
  const agents = chat ? ["claude", "codex"].filter((a) => hub.backends[a] && hub.enabled(a)) : [target.agent];
  const groups = agents.map((agent) => {
    let models = hub.backends[agent].status().models.filter((m) => !(chat && m.id === "default"));
    if (!models.length && chat && agent === hub.cfg().chatAgent) models = [{ id: hub.cfg().chatModel, label: hub.cfg().chatModel }];
    const current = target.agent === agent ? target.model ?? models.find((m) => m.isDefault)?.id : undefined;
    return {
      agent,
      label: agentName(agent),
      models: models.map((m) => ({ id: m.id, label: m.label, current: m.id === current, newChat: chat && !v.draft && target.agent !== agent })),
    };
  });
  return { kind: "models", chat, groups, effort: chat ? { current: hub.cfg().chatEffort || "medium", options: ["low", "medium", "high"] } : undefined };
}

// Builds the render model the Glass overlay paints. Pure function of Hub state (+ link state).
import * as path from "node:path";
import { attentionItems, type AttentionItem } from "./attention";
import { providerInfo } from "../agents/providers";
import { AgentKind, MODE_LABEL, TodoItem } from "../agents/types";
import { agentName, Entry, Hub, mustFork, Thread, ThreadStatus, Toast } from "./hub";
import { CHATS_KEY } from "./projects";

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
      confirm?: { text: string; fork: boolean; retry: boolean };
      /** A message held back because the agent's own app has this conversation open. */
      held?: { text: string };
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
  /** `mode`: what the Mode button acts on now (the selected quest's or draft's mode label, "Chat"
   * for chats; absent when nothing it acts on is selected); `modeHot`: Accept edits or Auto. */
  keys: { approve: boolean; stop: boolean; mode?: string; modeHot?: boolean };
  /** Stream-safe: the Glass blurs replies (never approval cards) until clicked. */
  blur?: boolean;
  tracker: TrackerLine[];
  toasts: Toast[];
  native: boolean;
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
    list: v.list === "pick" ? pickList(hub) : questList(hub),
    detail: detail(hub, link.linked),
    status: statusLine(hub, link),
    keys: { approve: anyPending, stop: !!sel && (sel.status === "running" || sel.status === "approval") },
    tracker: trackerLines(hub),
    toasts: hub.toasts,
    native: v.native,
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
  const text = x.generic ?? (x.kind === "approval" ? "Approval needed" : x.kind === "done" ? "Quest finished" : x.kind === "error" && x.threadId ? "Quest failed" : x.text);
  return { ...x, text };
}

function privateModel(hub: Hub, m: RenderModel, linked: boolean) {
  const { zone, thread } = privateNames(hub);
  const v = hub.view;
  m.private = true;
  // Quest Log first, so numbering follows the order the player sees.
  const shown = (agent: AgentKind) => !v.show.length || v.show.includes(agent);
  const quests = (key: string) => [...hub.threads.values()].filter((t) => t.projectKey === key && shown(t.agent)).length;
  const rows: Row[] = [];
  for (const r of m.list.rows) {
    if (r.kind === "ext" || r.key.startsWith("more:")) continue;
    if (r.kind === "zone") {
      const n = quests(r.key);
      if (!n && r.key !== CHATS_KEY) continue; // only desktop threads in it
      rows.push({ ...r, text: zone(r.key), count: n || undefined });
    } else if (r.kind === "project") rows.push({ ...r, text: zone(r.key) });
    else if (r.kind === "thread") rows.push({ ...r, text: thread(r.key) });
    else rows.push(r);
  }
  if (!rows.length) rows.push({ kind: "hint", key: "hint", text: "Choose Chat for a question, or start a project quest." });
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
    const activity = l.status === "approval" ? "Needs your approval" : l.status === "error" ? "Failed" : l.status === "running" ? "Working" : "Finished";
    return { ...l, title: thread(l.id), project: t ? zone(t.projectKey) : "", activity };
  });
  m.attention = m.attention?.map((i) => {
    const t = hub.threads.get(i.thread);
    // A pending request keeps its title (what is being approved); replies wait in the quest itself.
    return { ...i, title: thread(i.thread), project: t ? zone(t.projectKey) : "", cwd: "", excerpt: i.pending ? i.excerpt : "" };
  });
  m.toasts = m.toasts.map(privateToast);
}

function questList(hub: Hub): { title: string; rows: Row[] } {
  const v = hub.view;
  type Item = { kind: "thread"; t: Thread } | { kind: "ext"; id: string; x: any };
  const zones = new Map<string, { name: string; items: Item[]; activity: number }>();
  const zoneOf = (key: string, cwd: string) => {
    let z = zones.get(key);
    if (!z) {
      z = { name: hub.projects.get(key)?.name ?? path.basename(cwd), items: [], activity: 0 };
      zones.set(key, z);
    }
    return z;
  };
  const shown = (agent: AgentKind) => !v.show.length || v.show.includes(agent);
  for (const t of hub.threads.values()) {
    if (!shown(t.agent)) continue;
    const z = zoneOf(t.projectKey, t.cwd);
    z.items.push({ kind: "thread", t });
    z.activity = Math.max(z.activity, t.updatedAt + (t.status === "running" || t.status === "approval" ? 1e13 : 0));
  }
  for (const [id, x] of hub.external) {
    if (!shown(x.agent)) continue;
    const z = zoneOf(x.projectKey, x.cwd);
    z.items.push({ kind: "ext", id, x });
    z.activity = Math.max(z.activity, x.updatedAt + (x.running ? 1e13 : 0));
  }
  // The Chats zone is always there (it is how you start a chat) and always first.
  if (!v.show.length || v.show.includes(hub.cfg().chatAgent)) zoneOf(CHATS_KEY, "Chats");
  const rows: Row[] = [];
  const ordered = [...zones.entries()].sort((a, b) => (b[0] === CHATS_KEY ? 1 : 0) - (a[0] === CHATS_KEY ? 1 : 0) || b[1].activity - a[1].activity);
  for (const [key, z] of ordered) {
    const collapsed = v.collapsed.has(key);
    const live = z.items.filter((i) => i.kind === "thread").length;
    rows.push({
      kind: "zone",
      key,
      text: z.name,
      count: z.items.length || undefined,
      collapsed,
      sub: live ? `${live} quest${live > 1 ? "s" : ""}` : undefined,
      act: { type: "zone", key },
      act2: { type: "newIn", key },
    });
    if (collapsed) continue;
    // Quests first, then running / pinned desktop threads, then the rest by recency.
    const rank = (i: Item) =>
      i.kind === "thread" ? i.t.updatedAt + 3e13 : i.x.updatedAt + (i.x.running ? 2e13 : i.x.reason === "pinned" ? 1e13 : 0);
    const items = z.items.sort((a, b) => rank(b) - rank(a));
    const extCap = v.zoneAll.has(key) ? Infinity : hub.cfg().externalPerZone;
    const extTotal = items.filter((i) => i.kind === "ext").length;
    let extShown = 0;
    for (const i of items) {
      if (i.kind === "thread") {
        rows.push({
          kind: "thread",
          key: i.t.id,
          text: i.t.title,
          agent: i.t.agent,
          status: i.t.status,
          unread: i.t.unread,
          selected: v.selected === i.t.id,
          act: { type: "select", id: i.t.id },
          act2: { type: "archive", id: i.t.id },
        });
      } else if (extShown < extCap) {
        extShown++;
        rows.push({
          kind: "ext",
          key: i.id,
          text: i.x.title,
          agent: i.x.agent,
          status: i.x.running ? "running" : undefined,
          sub: (i.x.reason === "pinned" ? "★ " : "") + ago(i.x.updatedAt),
          selected: v.selected === i.id,
          act: { type: "select", id: i.id },
          act2: { type: "archive", id: i.id },
        });
      }
    }
    if (extTotal > extShown) rows.push({ kind: "hint", key: `more:${key}`, text: `+${extTotal - extShown} more`, act: { type: "zoneMore", key } });
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
      const confirm = v.confirm?.extId === v.selected ? { text: v.confirm.text, fork, retry: fork && !!hub.backends[x.agent]?.heldElsewhere } : undefined;
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
  };
}

function threadDetail(hub: Hub, t: Thread): DetailModel {
  const u = t.usage;
  const usage = u
    ? [u.inputTokens ? `${fmtK(u.inputTokens)} in` : "", u.outputTokens ? `${fmtK(u.outputTokens)} out` : "", u.costUsd ? `$${u.costUsd.toFixed(2)}` : ""]
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
    held: hub.view.held?.threadId === t.id ? { text: hub.view.held.text } : undefined,
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
    })),
  };
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
  return { text: "Nothing selected - choose Chat, a project quest, or a conversation on the left", warn: true };
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
          ? "Needs your approval"
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
  if (approval) parts.push(`${approval} awaiting approval`);
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

export function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtK(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
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

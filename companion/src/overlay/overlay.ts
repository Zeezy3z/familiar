// Glass: the transparent, click-through overlay that paints live content inside the addon's
// touch surfaces. Input arrives from the addon as region-relative clicks/wheel/hover, and is
// hit-tested here against what we drew.
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import type { DetailModel, EntryView, RenderModel, Row, TrackerLine } from "../hub/viewmodel";
import { threadState } from "./thread-state";
import { approvalPreview } from "./approval-preview";
import type { OverlayBridge } from "../shared/bridge";
import { CUES, type Cue, DEFAULT_CUE_VOLUME, playCue } from "../shared/cues";
const bridge = window.familiar as OverlayBridge;

// Round-3 model fields (docs: UX round 3 §9). Read as optional so the Glass renders models from
// before and after the hub adds them; every one is absent-safe.
type EntryR3 = EntryView & { cut?: boolean; refused?: string };
type KeysR3 = RenderModel["keys"] & { mode?: string; modeHot?: boolean };
type TrackerR3 = TrackerLine & { cost?: string };
const keysOf = (m: RenderModel | null) => m?.keys as KeysR3 | undefined;

type Rect = [number, number, number, number];
interface Layout {
  scr: [number, number];
  px: number;
  fpx?: number;
  panel: boolean;
  native: boolean;
  focus?: boolean;
  drag: boolean;
  combat: boolean;
  ui?: boolean;
  win?: Rect;
  list?: Rect;
  rowH?: number;
  detail?: Rect;
  status?: Rect;
  keys?: Record<string, Rect>;
  tracker?: Rect;
  occ?: Rect[];
  op?: number; // window background opacity, percent (absent: 100)
}

const marked = new Marked({ gfm: true, breaks: true });
// Agent output may contain raw HTML: keep only the highlighter's own classes so it can't borrow
// Glass classes (positioned panes, glows, buttons) to spoof UI.
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "class" && !/^(?:(?:hljs[\w-]*|code|language-[\w-]+)\s*)+$/.test(data.attrValue)) data.keepAttr = false;
});
marked.use({
  renderer: {
    code({ text, lang }) {
      const l = (lang ?? "").split(/\s/)[0];
      let html: string;
      try {
        html = l && hljs.getLanguage(l) ? hljs.highlight(text, { language: l }).value : hljs.highlightAuto(text).value;
      } catch {
        html = escapeHtml(text);
      }
      return `<pre class="code"><code class="hljs">${html}</code></pre>`;
    },
  },
});

const $ = (id: string) => document.getElementById(id)!;
const els = {
  list: $("list"),
  listScroll: $("list-scroll"),
  rows: $("rows"),
  listTitle: $("list-title"),
  detail: $("detail"),
  attention: $("attention"),
  focusReview: $("focus-review"),
  detailScroll: $("detail-scroll"),
  content: $("content"),
  status: $("status"),
  tracker: $("tracker"),
  lines: $("lines"),
  toasts: $("toasts"),
  glowApprove: $("glow-approve"),
  glowStop: $("glow-stop"),
  modeLabel: $("mode-label"),
  target: $("target"),
  latest: $("latest"),
};

let layout: Layout | null = null;
let model: RenderModel | null = null;
let visible = false;
let devInput = false; // dev/test harness only: hit-test even while the Glass is hidden
let k = 1; // CSS px per physical px
let follow = true;
let notesOpen = true;
let notesPage = 0;
let detailsOpen = false;
let focusReviewOpen = false;
let pendingJump: { thread: string; entry: string } | undefined;
// Reading places live only in this Glass instance. They never change conversation data.
interface ReadingPlace { top: number; follow: boolean; anchor?: string; identity?: string; offset?: number }
const readingPlaces = new Map<string, ReadingPlace>();
let restorePlace: ReadingPlace | undefined;

function currentReadingPlace(): ReadingPlace {
  const top = els.detailScroll.scrollTop;
  const viewTop = top + (els.content.querySelector<HTMLElement>(".qhead")?.offsetHeight ?? 0);
  let anchor: string | undefined;
  let anchorTop = Infinity;
  if (!follow) for (const [id, { el }] of entryCache) {
    if (el.offsetTop + el.offsetHeight > viewTop && el.offsetTop < anchorTop) {
      anchor = id;
      anchorTop = el.offsetTop;
    }
  }
  // Anchor relative to the readable area beneath the sticky header. Loading/error controls can
  // change that header's height without moving the message out from under the reader.
  return { top, follow, anchor, identity: anchor ? entryCache.get(anchor)?.identity : undefined, offset: anchor ? anchorTop - viewTop : undefined };
}

function rememberReadingPlace() {
  if (!lastDetailKey.startsWith("thread:") || !els.detailScroll.clientHeight || restorePlace) return;
  readingPlaces.delete(lastDetailKey);
  readingPlaces.set(lastDetailKey, currentReadingPlace());
  if (readingPlaces.size > 100) readingPlaces.delete(readingPlaces.keys().next().value!);
}

function syncDetailScroll() {
  const scroll = els.detailScroll;
  if (!scroll.clientHeight) return; // Restore after the pane is laid out or shown again.
  if (model?.detail.kind === "thread" && model.detail.loading && !model.detail.entries.length) {
    els.latest.style.display = "none";
    return; // Keep a restored place pending until the history actually arrives.
  }
  if (follow) scroll.scrollTop = scroll.scrollHeight;
  else if (restorePlace) {
    let anchor = restorePlace.anchor ? entryCache.get(restorePlace.anchor)?.el : undefined;
    if (lastDetailKey.startsWith("thread:ext:") && restorePlace.identity) {
      // Desktop history IDs describe slice positions, so prepending can reuse them for a
      // different message. Match unique content instead; ambiguous repeats use pixel fallback.
      const matches = [...entryCache.values()].filter(e => e.identity === restorePlace!.identity);
      anchor = matches.length === 1 ? matches[0].el : undefined;
    }
    const headerHeight = els.content.querySelector<HTMLElement>(".qhead")?.offsetHeight ?? 0;
    scroll.scrollTop = anchor ? anchor.offsetTop - headerHeight - (restorePlace.offset ?? 0) : restorePlace.top;
  }
  restorePlace = undefined;
  els.latest.style.display = model?.detail.kind !== "thread" || scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 8 ? "none" : "";
}

// ---- geometry -----------------------------------------------------------------------------------
// Where each element was last laid out (left/top/width/height). A layout that only moves an
// element (a drag) slides it with a GPU transform instead of re-laying it out, so the transcript
// isn't re-flowed on every mouse move.
const laidOut = new Map<HTMLElement, { r: Rect; k: number }>();

function place(el: HTMLElement, r?: Rect, show = true) {
  if (!r || !show) {
    el.style.display = "none";
    laidOut.delete(el);
    return;
  }
  el.style.display = "";
  const at = laidOut.get(el);
  if (at && at.k === k && at.r[2] === r[2] && at.r[3] === r[3]) {
    const dx = (r[0] - at.r[0]) * k,
      dy = (r[1] - at.r[1]) * k;
    el.style.transform = dx || dy ? `translate3d(${dx}px, ${dy}px, 0)` : "";
    return;
  }
  el.style.transform = "";
  el.style.left = `${r[0] * k}px`;
  el.style.top = `${r[1] * k}px`;
  el.style.width = `${r[2] * k}px`;
  el.style.height = `${r[3] * k}px`;
  laidOut.set(el, { r: [...r], k });
}

// CSS variables only when they change (setting one restyles the whole page).
const cssVars = new Map<string, string>();
function setVar(name: string, value: string) {
  if (cssVars.get(name) === value) return;
  cssVars.set(name, value);
  document.documentElement.style.setProperty(name, value);
}

function clipFor(el: HTMLElement, r?: Rect) {
  if (!r || !layout?.occ?.length) {
    el.style.clipPath = "";
    return;
  }
  const w = r[2] * k,
    h = r[3] * k;
  let d = `M0 0H${w}V${h}H0Z`;
  for (const o of layout.occ) {
    const x = (o[0] - r[0]) * k,
      y = (o[1] - r[1]) * k,
      ow = o[2] * k,
      oh = o[3] * k;
    if (x > w || y > h || x + ow < 0 || y + oh < 0) continue;
    d += `M${x} ${y}h${ow}v${oh}h${-ow}Z`;
  }
  el.style.clipPath = `path(evenodd, "${d}")`;
}

// A drag only moves things. While the shape (scale, sizes, what's shown) is unchanged, slide the
// panes with transforms and skip the rest (catch-up re-render, clip paths, toast placement and the
// scroll sync, which forces a synchronous layout); the full pass runs once things settle.
let lastShape = "";
let settleTimer: ReturnType<typeof setTimeout> | undefined;
function layoutShape(): string {
  if (!layout) return "";
  const size = (r?: Rect) => (r ? `${r[2]}x${r[3]}` : "-");
  return [window.innerWidth / layout.scr[0], layout.panel, layout.drag, layout.ui, layout.native, layout.focus, layout.rowH, layout.fpx, layout.px, layout.op,
    size(layout.list), size(layout.detail), size(layout.status), size(layout.tracker), size(layout.keys?.approve), size(layout.keys?.stop), size(layout.keys?.mode),
    JSON.stringify(layout.occ ?? []), model?.fontScale, model?.raidWarnings, model?.tracker.length, !!model?.keys.approve, !!model?.keys.stop, !!keysOf(model)?.mode].join("|");
}

function applyLayout(moveOnly = false) {
  if (!layout) return;
  const shape = layoutShape();
  els.detail.classList.toggle("focused", !!layout.focus);
  if (moveOnly && shape === lastShape && laidOut.size) {
    const panelOn = layout.panel && !layout.drag && layout.ui !== false;
    place(els.list, layout.list, panelOn);
    place(els.detail, layout.detail, panelOn && !layout.native);
    place(els.status, layout.status, panelOn);
    place(els.tracker, layout.tracker, !layout.drag && layout.ui !== false && !!model?.tracker.length);
    place(els.glowApprove, layout.keys?.approve, panelOn && !!model?.keys.approve);
    place(els.glowStop, layout.keys?.stop, panelOn && !!model?.keys.stop);
    place(els.modeLabel, layout.keys?.mode, panelOn && !!keysOf(model)?.mode);
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { settleTimer = undefined; lastShape = ""; applyLayout(); }, 120);
    return;
  }
  lastShape = shape;
  k = window.innerWidth / layout.scr[0];
  // Layout is kept even while hidden so hit-testing of incoming clicks still works.
  const panelOn = layout.panel && !layout.drag && layout.ui !== false;
  // The welcome portrait steps aside when the pane is under 200 CSS px tall (overlay.css, body.short-detail).
  document.body.classList.toggle("short-detail", !!layout.detail && layout.detail[3] * k < 200);
  const rowH = (layout.rowH ?? 16) * k;
  const fpx = (layout.fpx ?? layout.px) * k;
  const fs = model?.fontScale ?? 1;
  setVar("--row-h", `${rowH}px`);
  setVar("--row-font", `${rowH * 0.72}px`);
  setVar("--body-font", `${Math.max(11, fpx * 12.5 * fs)}px`);
  setVar("--small-font", `${Math.max(10, fpx * 10.5 * fs)}px`);
  // The addon fades its own backgrounds by the same amount (Options -> AddOns -> Familiar).
  setVar("--bg", `rgba(9, 8, 11, ${Math.max(0, Math.min(100, layout.op ?? 100)) / 100})`);
  place(els.list, layout.list, panelOn);
  place(els.detail, layout.detail, panelOn && !layout.native);
  renderAttention();
  renderFocusReview();
  place(els.status, layout.status, panelOn);
  place(els.tracker, layout.tracker, !layout.drag && layout.ui !== false && !!model?.tracker.length);
  clipFor(els.list, layout.list);
  clipFor(els.detail, layout.detail);
  clipFor(els.tracker, layout.tracker);
  place(els.glowApprove, layout.keys?.approve, panelOn && !!model?.keys.approve);
  place(els.glowStop, layout.keys?.stop, panelOn && !!model?.keys.stop);
  // The addon cannot learn the live mode, so its Mode button says "Mode"; the Glass paints the
  // selected quest's mode over that button's rect. Hidden Glass = the native label shows again.
  place(els.modeLabel, layout.keys?.mode, panelOn && !!keysOf(model)?.mode);
  clipFor(els.modeLabel, layout.keys?.mode);
  fitModeLabel();
  // Toasts: centred near the top of the game, like raid warnings; or (raid warnings off) small,
  // across the top of the transcript, only while the Familiar window is open.
  const raid = model?.raidWarnings !== false;
  const d = layout.detail;
  els.toasts.classList.toggle("inwin", !raid);
  const ts = els.toasts.style;
  if (raid || !d) ts.left = ts.top = ts.width = ts.right = "";
  else {
    ts.left = `${d[0] * k}px`;
    ts.top = `${(d[1] + 4) * k}px`;
    ts.width = `${d[2] * k}px`;
    ts.right = "auto";
  }
  ts.display = layout.ui !== false && (raid || (panelOn && !!d)) ? "" : "none";
  if (layout.drag) els.toasts.style.opacity = "0.4";
  else els.toasts.style.opacity = "1";
  syncDetailScroll();
}

// The native Mode button is small (64x22 in UI.lua): the label takes the body small size, capped by
// the rect's height, and shrinks further only when a long mode ("Accept edits") would not fit.
function fitModeLabel() {
  const el = els.modeLabel, span = el.firstElementChild as HTMLElement | null;
  if (!span || el.style.display === "none") return;
  span.style.fontSize = `${Math.min(Math.max(10, (layout?.fpx ?? layout?.px ?? 1) * k * 10.5 * (model?.fontScale ?? 1)), el.clientHeight * 0.6)}px`;
  const room = el.clientWidth - 6 * k;
  if (span.scrollWidth > room) span.style.fontSize = `${parseFloat(span.style.fontSize) * room / span.scrollWidth}px`;
}

// ---- rendering ----------------------------------------------------------------------------------
// Provider glyphs/labels come with every model (built-ins first so the very first paint works).
let PROVIDERS: Record<string, { label: string; glyph: string }> = { claude: { label: "Claude", glyph: "✦" }, codex: { label: "Codex", glyph: "◈" } };
const AGENT_ICON = new Proxy({} as Record<string, string>, { get: (_t, id: string) => PROVIDERS[id]?.glyph ?? "◇" });
const agentLabel = (id: string) => PROVIDERS[id]?.label ?? id;
const STATUS_ICON: Record<string, string> = { running: "◌", approval: "!", error: "✗", idle: "", new: "…" };

function attr(o: unknown) {
  return escapeAttr(JSON.stringify(o));
}

function renderRows(rows: Row[], title: string) {
  els.listTitle.textContent = title;
  const html = rows
    .map((r) => {
      const cls = ["row", r.kind, r.selected ? "sel" : "", r.unread ? "unread" : "", r.status ? `st-${r.status}` : "", r.agent ? `ag-${r.agent}` : ""].join(" ");
      const act = r.act ? ` data-act="${attr(r.act)}"` : "";
      const act2 = r.act2 ? ` data-act2="${attr(r.act2)}"` : "";
      let inner = "";
      if (r.kind === "zone") inner = `<span class="tw">${r.collapsed ? "+" : "−"}</span><span class="t">${esc(r.text)}</span><span class="s">${r.count ?? ""}</span>`;
      else if (r.kind === "agent") inner = `<span class="ag">${AGENT_ICON[r.agent ?? ""]}</span><span class="t">${esc(r.text)}</span>`;
      else if (r.kind === "thread" || r.kind === "ext")
        inner = `<span class="ag">${AGENT_ICON[r.agent ?? "claude"]}</span><span class="t">${esc(r.text)}</span>${r.status && STATUS_ICON[r.status] ? `<span class="st">${STATUS_ICON[r.status]}</span>` : ""}${r.sub ? `<span class="s">${esc(r.sub)}</span>` : ""}`;
      else if (r.kind === "project") inner = `<span class="t">${esc(r.text)}</span>${r.sub ? `<span class="s">${esc(r.sub)}</span>` : ""}`;
      else inner = `<span class="t">${esc(r.text)}</span>`;
      return `<div class="${cls}"${act}${act2}>${inner}</div>`;
    })
    .join("");
  if (els.rows.innerHTML !== html) els.rows.innerHTML = html;
}

const entryCache = new Map<string, { sig: string; identity: string; text?: string; output?: string; el: HTMLElement }>();
let lastDetailKey = "";

function renderDetail(d: DetailModel) {
  const storage = model?.storage ? `<div class="notice ${model.storage.level === "error" ? "error" : ""}" role="status">${esc(model.storage.text)}</div>` : "";
  const storageSummary = model?.storage ? `<div class="notice storage-summary ${model.storage.level === "error" ? "error" : ""}" role="status">${model.storage.level === "error" ? "Saving needs attention" : "Recovery notice"}</div>` : "";
  const key = d.kind === "thread" ? `thread:${d.id}` : d.kind;
  if (key !== lastDetailKey) {
    rememberReadingPlace();
    els.content.innerHTML = "";
    entryCache.clear();
    lastDetailKey = key;
    detailsOpen = false;
    focusReviewOpen = false;
    const place = readingPlaces.get(key);
    // Task choices and model lists start at the top; only transcripts follow new replies.
    follow = place?.follow ?? (d.kind === "thread");
    restorePlace = place ?? { top: 0, follow };
  }
  if (d.kind !== "thread") {
    els.content.innerHTML = storage + (layout?.focus
      ? `<div class="notice">Use Full view below to choose or start a conversation. Your unfinished reply stays in the composer.</div>`
      : staticDetail(d));
    return;
  }
  // Header + objectives are cheap; entries are keyed and only re-rendered when they change.
  let head = els.content.querySelector<HTMLElement>(".qhead");
  if (!head) {
    head = document.createElement("div");
    head.className = "qhead";
    els.content.appendChild(head);
  }
  const state = threadState(d);
  const routine = state.label === "Reply ready" || state.label === "Ready for your message";
  const focused = !!layout?.focus;
  const selectedPending = model?.attention?.find(item => item.thread === d.id && item.pending);
  const detailControl = `<span class="btn qdetails-toggle" aria-expanded="${detailsOpen}" data-act="${attr({ type: "local", what: "details" })}">Details</span>`;
  const handoff = d.handOff ? `<span class="btn" aria-label="Continue in ${esc(d.handOff.app)} app" title="Continue in ${esc(d.handOff.app)} app" data-act="${attr({ type: "openInApp" })}">${focused ? "Continue" : `Continue in ${esc(d.handOff.app)} app`}</span>` : "";
  const focusHeader = `<div class="qfocus-line"><div class="qfocus-title"><span class="ag ag-${d.agent}">${AGENT_ICON[d.agent]} ${esc(agentLabel(d.agent))}</span><span class="qfocus-name">${esc(d.title)}</span></div><div class="qfocus-actions">${handoff}${detailControl}</div></div>`;
  const focusState = routine ? "" : `<div class="qstate ${state.level}"><b>${state.label}</b><span>${state.hint}</span>
    ${!d.external && (d.status === "running" || d.status === "approval") ? `<span class="btn" data-act="${attr({ type: "stop", thread: d.id })}">Stop</span>` : ""}
    ${selectedPending ? `<span class="btn" data-act="${attr({ type: "local", what: "openUpdate", thread: d.id, entry: selectedPending.entry })}">Review request</span>` : ""}</div>`;
  const hot = /^(Accept edits|Auto)/.test(d.mode);
  const fullHeader = `
    <div class="qtitle"><span class="ag ag-${d.agent}">${AGENT_ICON[d.agent]} ${agentLabel(d.agent)}</span> ${esc(d.title)}</div>
    <div class="qbar">
      <span class="qmode${hot ? " hot" : ""}">${esc(d.mode)}</span>
      ${d.handOff ? `<div class="qapp">${handoff}</div>` : ""}
      ${routine ? "" : `<div class="qstate ${state.level}"><b>${state.label}</b><span>${state.hint}</span></div>`}
      ${detailControl}
    </div>`;
  const contextHtml = `${focused && detailsOpen ? `<div class="qmeta"><b>${esc(d.title)}</b>${d.handOff ? `<br>Continue opens this conversation in ${esc(d.handOff.app)} app.` : ""}</div>` : ""}
    ${detailsOpen ? `<div class="qmeta">${esc(d.project)} · ${esc(d.mode)}${focused && d.cwd ? ` · ${esc(d.cwd)}` : ""}${d.model ? ` · ${esc(d.model)}` : ""}${d.usage ? ` · ${esc(d.usage)}` : ""}</div>` : ""}
    ${d.todos.length && (!focused || detailsOpen) ? `<div class="objectives"><div class="obj-h">Objectives${d.todoNote ? ` <span class="s">— ${esc(d.todoNote)}</span>` : ""}</div>${d.todos.map((t) => `<div class="obj ${t.status}">${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "•"} ${esc(t.text)}</div>`).join("")}</div>` : ""}`;
  const headHtml = `${storageSummary}${focused ? focusHeader + focusState : fullHeader}
    ${model?.storage ? "" : contextHtml}
    ${d.loading ? `<div class="notice" role="status">${d.entries.length ? "Loading earlier messages…" : "Loading history…"}</div>` : ""}
    ${d.historyError ? `<div class="history-error"><div class="notice error" role="status">${esc(d.historyError)}</div><span class="btn" data-act="${attr({ type: "retryHistory", id: d.id })}">Retry</span></div>` : ""}
    ${d.historyEmpty ? `<div class="notice">No saved messages in this conversation.</div>` : ""}
    ${d.more && !d.loading && !d.historyError ? `<div class="more" data-act="${attr({ type: "more", id: d.id })}">&#9650; Load earlier messages</div>` : ""}`;
  if (head.dataset.sig !== headHtml) {
    head.innerHTML = headHtml;
    head.dataset.sig = headHtml;
  }
  const seen = new Set<string>();
  let prev: HTMLElement = head;
  // Exceptional guidance and expanded context must remain scrollable, rather than growing the
  // sticky header until the narrow/large-text response and controls become unreachable.
  let storageDetail = els.content.querySelector<HTMLElement>(".storage-detail");
  const storageHtml = model?.storage ? (detailsOpen ? storage.replace(' role="status"', "") : "") + contextHtml : "";
  if (storageHtml.trim()) {
    if (!storageDetail) { storageDetail = document.createElement("div"); storageDetail.className = "storage-detail"; }
    if (storageDetail.dataset.sig !== storageHtml) { storageDetail.innerHTML = storageHtml; storageDetail.dataset.sig = storageHtml; }
    if (head.nextSibling !== storageDetail) head.after(storageDetail);
    prev = storageDetail;
  } else storageDetail?.remove();
  for (const e of d.entries) {
    seen.add(e.id);
    // Slice IDs can be reused for different desktop messages, including equal-length text.
    const { text, output, ...metadata } = e;
    // Agent and folder shape approval cards; Hide names blanks the folder, so a card must re-render.
    const sig = JSON.stringify([d.agent, d.cwd, blurOn(), metadata]);
    let c = entryCache.get(e.id);
    if (!c) {
      const el = document.createElement("div");
      el.dataset.id = e.id;
      c = { sig: "", identity: "", el };
      entryCache.set(e.id, c);
    }
    if (c.sig !== sig || c.text !== text || c.output !== output) {
      c.identity = JSON.stringify([e.kind, e.name, text]);
      c.el.className = `entry ${e.kind}${e.streaming ? " streaming" : ""}${e.level ? " " + e.level : ""}`;
      c.el.innerHTML = entryHtml(e, d.id, d.agent, d.cwd);
      c.sig = sig;
    }
    c.el.classList.toggle("revealed", revealed.has(e.id));
    // Retain this push's strings without allocating escaped copies on every update.
    c.text = text;
    c.output = output;
    if (prev.nextSibling !== c.el) prev.after(c.el);
    prev = c.el;
  }
  for (const [id, c] of entryCache) {
    if (!seen.has(id)) {
      c.el.remove();
      entryCache.delete(id);
    }
  }
  // Confirmation before continuing a desktop-app conversation (always last).
  let conf = els.content.querySelector<HTMLElement>(".confirm");
  if (d.confirm) {
    if (!conf) {
      conf = document.createElement("div");
      conf.className = "card pending confirm";
    }
    const app = agentLabel(d.agent);
    const why = d.confirm.retry
      ? `It's open in the ${esc(app)} app or a terminal right now, which owns writing to it. Quit it there (${esc(app)} app: tray → Quit) and press Retry to continue this same conversation, or continue as a copy (fork), which that app won't show.`
      : d.confirm.fork
        ? "It's open in another app right now, so Familiar continues a copy (fork); that app won't show the replies. Close it there first to keep one conversation."
        : "Familiar continues this same conversation; you'll see these turns there the next time you open it.";
    conf.innerHTML = `<div class="card-h">Continue this desktop conversation?</div>
      <div class="card-b">${esc(d.project)} - ${esc(d.title)}<br><i>${why} You're only asked once per conversation.</i></div>
      <pre class="card-b">${esc(d.confirm.text)}</pre>
      <div class="btns">${d.confirm.retry ? `<span class="btn ok" data-act="${attr({ type: "adoptRetry" })}">Retry</span>` : ""}<span class="btn${d.confirm.retry ? "" : " ok"}" data-act="${attr({ type: "adoptConfirm" })}">${d.confirm.fork ? "Continue as a copy" : "Continue here"}</span><span class="btn" data-act="${attr({ type: "adoptNew" })}">New quest in ${esc(d.project)}</span><span class="btn no" data-act="${attr({ type: "adoptCancel" })}">Cancel</span></div>`;
    els.content.appendChild(conf);
    follow = true;
  } else conf?.remove();
  // A message held back because the agent's own app has this quest's conversation open (always last).
  let held = els.content.querySelector<HTMLElement>(".held");
  if (d.held) {
    if (!held) {
      held = document.createElement("div");
      held.className = "card pending held";
    }
    const app = agentLabel(d.agent);
    held.innerHTML = `<div class="card-h">Open in the ${esc(app)} app</div>
      <div class="card-b"><i>This conversation is open in the ${esc(app)} app or a terminal, which owns writing to it. Quit it there (${esc(app)} app: tray → Quit) and press Retry to send this to the same conversation, or continue as a copy (fork), which that app won't show.</i></div>
      <pre class="card-b">${esc(d.held.text)}</pre>
      <div class="btns"><span class="btn ok" data-act="${attr({ type: "heldRetry" })}">Retry</span><span class="btn" data-act="${attr({ type: "heldCopy" })}">Continue as a copy</span><span class="btn no" data-act="${attr({ type: "heldCancel" })}">Cancel</span></div>`;
    els.content.appendChild(held);
    follow = true;
  } else held?.remove();
}

// Stream-safe: replies are blurred on the Glass; a click reveals one for a few seconds. Local
// only (no hub action): it grants nothing. Approval cards are never blurred.
const blurOn = () => !!(model as { blur?: boolean } | null)?.blur;
const REVEAL = attr({ type: "local", what: "reveal" });
const REVEAL_MS = 8000;
const revealed = new Map<string, ReturnType<typeof setTimeout>>();
function reveal(id: string) {
  clearTimeout(revealed.get(id));
  revealed.set(id, setTimeout(() => {
    revealed.delete(id);
    entryCache.get(id)?.el.classList.remove("revealed");
  }, REVEAL_MS));
  entryCache.get(id)?.el.classList.add("revealed");
}

function entryHtml(e: EntryView, threadId: string, agent: string, cwd: string): string {
  const revealAct = blurOn() ? ` data-act="${REVEAL}"` : "";
  switch (e.kind) {
    case "user":
      return `<div class="who">You</div><div class="body"${revealAct}>${esc(e.text).replace(/\n/g, "<br>")}</div>`;
    case "assistant":
    case "reasoning":
      return `<div class="body md"${revealAct}>${md(e.text)}${e.streaming ? '<span class="caret">▍</span>' : ""}</div>`;
    case "tool": {
      const icon = e.status === "running" ? "◌" : e.status === "error" ? "✗" : "✓";
      return `<div class="tool-line" data-act="${attr({ type: "tool", id: e.id })}"><span class="ti ${e.status}">${e.status === "unknown" ? "?" : icon}</span> <b>${esc(e.name ?? "tool")}</b> <span class="tsum">${esc(e.text)}</span>${e.status === "unknown" ? '<span class="outcome-unknown">Outcome unknown — check the folder before resending</span>' : ""}</div>${e.expanded && e.output ? `<pre class="tout">${diffHtml(e.output)}</pre>` : ""}`;
    }
    case "approval": {
      const pending = e.approval === "pending";
      const { cut, refused } = e as EntryR3;
      const preview = approvalPreview(e.text, e.expanded, pending);
      const btn = (label: string, decision: string, cls = "") =>
        `<span class="btn ${cls}" data-act="${attr({ type: "decide", thread: threadId, requestId: e.requestId, decision })}">${label}</span>`;
      const alwaysLabel = agent === "claude" || agent === "codex" ? "Always (this quest)" : "Always (agent decides how long)";
      // A cut request is approved only on the PC, where the whole text is shown: Deny is the
      // only decision drawn here (the hub refuses a grant from the game regardless).
      const opts = cut
        ? `<span class="approve-pc">Approve on your PC</span>${btn("Deny", "deny", "no")}`
        : e.options?.length
          ? e.options.map((o) => `<span class="btn" data-act="${attr({ type: "answer", thread: threadId, requestId: e.requestId, label: o })}">${esc(o)}</span>`).join("")
          : btn("Approve", "allow", "ok") + btn("Deny", "deny", "no") + (e.canAlways ? btn(alwaysLabel, "allowAlways", "always") : "");
      return `<div class="card ${pending ? "pending" : e.approval}">
        <div class="card-h">${pending ? '<span class="bang">!</span> ' : ""}${esc(e.title ?? "Approval")}</div>
        ${pending && cwd ? `<div class="card-where">in ${esc(cwd)}</div>` : ""}
        <div class="preview-note">The agent's own summary. If unsure, Deny — nothing happens until you approve.</div>
        ${pending && cut ? `<div class="preview-cut" role="alert">! Part of this request is not shown here. To approve it, read it in full in Familiar's control panel on your PC — or Deny.</div>` : ""}
        ${preview.shortened ? `<span class="btn preview-toggle" aria-expanded="${!!e.expanded}" data-act="${attr({ type: "approvalPreview", thread: threadId, id: e.id })}"><span aria-hidden="${!!e.expanded}">Show more of preview</span><span aria-hidden="${!e.expanded}">Collapse preview</span></span>` : ""}
        <pre class="card-b approval-preview">${diffHtml(preview.text)}${preview.shortened && !e.expanded ? "\n… [More preview text hidden]" : ""}</pre>
        ${pending ? `<div class="btns">${opts}</div>` : `<div class="card-s">${approvalText(e.approval, agent)}</div>`}
        ${pending && refused ? `<div class="card-refused" role="alert">✗ ${esc(refused)}</div>` : ""}
      </div>`;
    }
    case "notice":
      return `<div class="notice">${esc(e.text)}</div>`;
  }
}

// The welcome page is the quest giver: its face and first lines follow what the model already says
// (no new field). Unlinked, or linked with no familiar ready, it is puzzled; no quests, asleep;
// something running, working; otherwise idle. Offer sentences below the head stay as they were.
type WelcomeModel = Extract<DetailModel, { kind: "welcome" }>;
function welcomeHead(d: WelcomeModel): { expr: "idle" | "working" | "asleep" | "puzzled"; big: string; sub: string } {
  const link = d.linkedChar ? esc(d.linkedChar) : "the game";
  if (!d.linked) return { expr: "puzzled", big: "I can't see the game yet.", sub: "Waiting for the game link. Familiar on your PC says what it sees (tray → Open Familiar)." };
  if (!d.backends.some((b) => b.ready)) return { expr: "puzzled", big: "Well met.", sub: "No familiar is ready yet. Open Familiar from the tray icon on your PC to sign in." };
  if (d.counts.total === 0) return { expr: "asleep", big: "No quests yet.", sub: "Wake me with + Claude or + Codex, or ask a question with + Chat." };
  if (d.counts.running > 0) return { expr: "working", big: "Well met.", sub: `Linked to ${link} · ${d.counts.running} working.` };
  return { expr: "idle", big: "Well met.", sub: `Linked to ${link}.` };
}

function staticDetail(d: DetailModel): string {
  if (d.kind === "models")
    return `<div class="welcome models"><div class="big">${d.chat ? "Chat model" : "Model"}</div>
      ${d.groups
        .map(
          (g) => `<div class="mgroup"><div class="mg-h">${AGENT_ICON[g.agent]} ${esc(g.label)}</div>${g.models
            .map(
              (m) =>
                `<div class="mrow${m.current ? " cur" : ""}" data-act="${attr({ type: "pickModel", agent: g.agent, model: m.id })}">${m.current ? "● " : ""}${esc(m.label)}${m.newChat ? ' <span class="s">(new chat)</span>' : ""}</div>`,
            )
            .join("") || '<div class="hint">Starts when World of Warcraft is running…</div>'}</div>`,
        )
        .join("")}
      ${d.effort ? `<div class="mgroup"><div class="mg-h">Effort</div>${d.effort.options.map((o) => `<span class="btn${o === d.effort!.current ? " cur" : ""}" data-act="${attr({ type: "pickEffort", effort: o })}">${esc(o)}</span>`).join(" ")}</div>` : ""}
      <div class="hint">${d.chat ? "Your pick is used for new chats too. Lower effort answers faster." : "Applies to this quest from its next message."} <span class="btn" data-act="${attr({ type: "closePicker" })}">Close</span></div></div>`;
  if (d.kind === "welcome") {
    // Lane H adds `zones` to the welcome model; a hub without it draws nothing extra.
    const noProjects = (d as { zones?: number }).zones === 0;
    const projectStarts = d.backends.filter((b) => b.ready).map((b) =>
      b.id === "claude" || b.id === "codex" ? `<b>+ ${esc(b.label)}</b>` : `<b>/fam ${esc(b.id)}</b> (no message)`);
    const { expr, big, sub } = welcomeHead(d);
    return `<div class="welcome ${expr}">
      <div class="whead"><img class="portrait" src="assets/${expr}-192.png" alt="" decoding="sync"><div class="wtext"><div class="big">${big}</div><div class="sub">${sub}</div></div></div>
      <div class="hint offer welcome-chat"><b>Ask a game question</b><br>
        Quests, talents, zones, or a quick lookup. Chat uses web search, without project files or commands.<br>
        ${esc(d.chat.label)}${d.chat.model ? ` · ${esc(d.chat.model)}` : ""} · ${esc(d.chat.status)}<br>
        <span class="btn" data-act="${attr(d.chat.act)}">+ Chat</span> ${d.chat.ready ? "Opens a draft; nothing is sent yet. Model lists your chat choices." : "Chat uses Claude or Codex. Open a draft, then use Model to choose an enabled Chat provider or open Familiar from the tray icon on your PC to sign in."}</div>
      <div class="hint offer welcome-project"><b>Work on a project</b><br>
        ${projectStarts.length ? `Use ${projectStarts.join(" or ")} to choose a project folder. The project picker also lists other familiars.` : "No provider is ready yet. Open Familiar from the tray icon on your PC to sign in before starting a project."}
        Use Model to see the available models. Check Your familiars below before sending.${noProjects ? `<br><span class="welcome-noprojects">No project folders yet — add one in Familiar on your PC (tray → Open Familiar → Projects).</span>` : ""}</div>
      <div class="hint offer welcome-continue"><b>Continue a conversation</b><br>
        Pick a quest or desktop conversation on the left. Familiar asks before sending your first message to a desktop conversation.</div>
      <div class="hint welcome-tutorial"><span class="link" data-act="${attr({ type: "tutorial" })}"><span class="ag ag-familiar">◆</span> Replay A Familiar Face</span> · the practice quest: one request to approve, and nothing runs.</div>
      <div class="hint"><b>Your familiars</b></div>
      ${d.backends.map((b) => `<div class="kv"><span>${AGENT_ICON[b.id]} ${esc(b.label)}</span> ${esc(b.status)}</div>`).join("")}
      <div class="kv"><span>Quests</span> ${d.counts.total} · ${d.counts.running} running · ${d.counts.approval} awaiting approval</div>
    </div>`;
  }
  if (d.kind === "pick")
    return `<div class="welcome"><div class="big">New ${agentLabel(d.agent)} quest</div>
      <div class="sub">Choose a zone (project folder) on the left.</div>
      <div class="hint">Not listed? Type a full folder path in the box below and press Enter.<br>Type <b>mkdir &lt;your WoW folder&gt;\\_forever_\\Interface\\AddOns\\MyAddon</b> to start a new addon folder.<br>
      Switch familiar: ${Object.keys(PROVIDERS).filter((id) => id !== "familiar").map((id) => `<span class="btn" data-act="${attr({ type: "agent", agent: id })}">${AGENT_ICON[id]} ${esc(agentLabel(id))}</span>`).join(" ")}</div></div>`;
  if (d.kind === "draft" && d.chat)
    return `<div class="welcome"><div class="big">${AGENT_ICON[d.agent]} New chat</div>
      <div class="sub">${agentLabel(d.agent)}${d.model ? ` · ${esc(d.model)}` : ""} · web search only, no files or commands</div>
      ${d.provider ? `<div class="kv"><span>Provider</span> ${esc(d.provider.status)}</div>` : ""}
      <div class="hint">${d.provider && !d.provider.ready ? "Chat uses Claude or Codex. Check provider setup in the control panel, or use Model to choose an enabled Chat provider before sending." : "Ask your question below and press Enter. Use Model to see your chat provider and model choices."}<br>
      Your character's class, level and zone are included so answers fit where you are (/fam ask context off to stop).</div></div>`;
  if (d.kind === "draft")
    return `<div class="welcome"><div class="big">${AGENT_ICON[d.agent]} ${agentLabel(d.agent)} · ${esc(d.project)}</div>
      <div class="sub">${esc(d.cwd)}</div>
      <div class="kv"><span>Mode</span> ${esc(d.mode)} <i>(Mode button cycles)</i></div>
      <div class="kv"><span>Model</span> ${esc(d.model ?? "default")} <i>(Model button lists them)</i></div>
      <div class="hint">Describe the quest below and press Enter. Your familiar will start working in this folder.</div></div>`;
  return "";
}

function renderTracker(lines: TrackerLine[]) {
  els.lines.innerHTML = lines
    .map(
      (l) => `<div class="tl st-${l.status}" data-act="${attr({ type: "select", id: l.id })}">
        <div class="tl-h"><span class="ag ag-${l.agent}">${AGENT_ICON[l.agent]}</span> ${esc(l.title)} <span class="s">${esc([l.project, l.progress, (l as TrackerR3).cost].filter(Boolean).join(" · "))}</span></div>
        <div class="tl-a">${esc(l.activity)}</div></div>`,
    )
    .join("");
}

function renderToasts(m: RenderModel) {
  const html = m.toasts
    .slice(-3)
    .map((t) => {
      // The moment: the painted seal (cracked on a failure) over the title, and the hub's rewards line when it sent one
      // (`sub`: counts and cost only, never a name; read defensively, a hub without it draws no line).
      if (t.kind !== "done" && t.kind !== "error") return `<div class="toast ${t.kind}">${esc(t.text)}</div>`;
      const sub = (t as { sub?: string }).sub;
      return `<div class="toast ${t.kind}"><img class="seal" src="assets/${t.kind === "done" ? "seal-128" : "seal-cracked-128"}.png" alt=""><div class="t">${esc(t.text)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;
    })
    .join("");
  if (els.toasts.innerHTML !== html) els.toasts.innerHTML = html;
}

function render() {
  if (!model) return;
  renderRows(model.list.rows, model.list.title);
  const key = model.detail.kind === "thread" ? `thread:${model.detail.id}` : model.detail.kind;
  // The previous quest's short transcript must not make the next quest follow its latest reply.
  if (key === lastDetailKey && !restorePlace) {
    if (els.detailScroll.clientHeight) {
      if (model.detail.kind === "thread" && els.detailScroll.scrollTop + els.detailScroll.clientHeight >= els.detailScroll.scrollHeight - 8) follow = true;
      if (!follow) restorePlace = currentReadingPlace();
    } else if (!follow) restorePlace = readingPlaces.get(key);
  }
  renderDetail(model.detail);
  els.target.textContent = "Messages go to: " + model.target.text;
  els.target.classList.toggle("warn", !!model.target.warn);
  renderTracker(model.tracker);
  renderToasts(model);
  document.body.classList.toggle("blur", blurOn());
  els.status.textContent = model.status.text + (model.quiet ? " · Alerts muted (/fam quiet off)" : "") + (blurOn() ? " · Stream-safe on" : model.private ? " · Hide names on" : "");
  const keys = keysOf(model);
  const modeHtml = keys?.mode ? `<span>${esc(keys.mode)}</span>` : "";
  if (els.modeLabel.innerHTML !== modeHtml) els.modeLabel.innerHTML = modeHtml;
  els.modeLabel.classList.toggle("hot", !!keys?.modeHot);
  els.status.className = `lvl-${model.status.level}`;
  applyLayout();
  if (pendingJump && model.detail.kind === "thread" && pendingJump.thread === model.detail.id && els.detailScroll.clientHeight) {
    const entry = entryCache.get(pendingJump.entry)?.el;
    if (entry) {
      follow = false;
      els.detailScroll.scrollTop = Math.max(0, entry.offsetTop - (els.content.querySelector<HTMLElement>(".qhead")?.offsetHeight ?? 0));
      syncDetailScroll();
      pendingJump = undefined;
    }
  }
  rememberReadingPlace();
}

// Long folders keep only their last two parts; a blank folder (Hide names) is left out.
const pathTail = (p: string) => { const s = p.split(/[\\/]/).filter(Boolean); return s.length > 2 ? "…\\" + s.slice(-2).join("\\") : p; };

function renderAttention() {
  if (!model) return;
  const items = model.attention ?? [];
  if (layout?.focus || !items.length) { els.attention.style.display = "none"; return; }
  els.attention.style.display = "";
  const paneHeight = (layout?.detail?.[3] ?? 500) * k;
  const smallFont = Math.max(10, (layout?.fpx ?? layout?.px ?? 1) * k * 10.5 * (model.fontScale ?? 1));
  const pageSize = Math.max(1, Math.min(4, Math.floor((paneHeight * 0.65 - 60) / Math.max(45, smallFont * 4.6))));
  notesPage = Math.min(notesPage, Math.max(0, Math.ceil(items.length / pageSize) - 1));
  const control = (label: string, action: unknown) => `<span class="btn" data-act="${attr(action)}">${label}</span>`;
  const html = `<div class="catch-head">${control(`<b>${notesOpen ? "▾" : "▸"} ${items.length} waiting</b>`, { type: "local", what: "notes" })}</div>` +
    (notesOpen ? `<div class="catch-promise">Replies wait here until you choose Caught up or reply in that quest. Opening a quest alone doesn't count.</div>` + items.slice(notesPage * pageSize, notesPage * pageSize + pageSize).map(item => `<div class="catch-note"><div class="catch-copy"><div class="catch-title"><b>${esc(item.title)}</b><span class="${item.pending ? "warn" : ""}">${esc(item.label)}</span></div><div class="catch-meta">${esc(agentLabel(item.agent))} · ${esc(item.project)} · ${esc(item.mode)}${item.cwd ? ` · ${esc(pathTail(item.cwd))}` : ""}</div><div class="catch-excerpt">${esc(item.excerpt)}</div></div><div class="catch-actions">${control("Open quest", { type: "local", what: "openUpdate", thread: item.thread, entry: item.entry })}${item.pending ? "" : control("Caught up", { type: "caughtUp", thread: item.thread, entry: item.entry, revision: item.revision })}</div></div>`).join("") +
      (items.length > pageSize ? `<div class="catch-pages">${notesPage ? control("Previous notes", { type: "local", what: "notesPage", page: notesPage - 1 }) : ""}<span>${notesPage * pageSize + 1}–${Math.min(items.length, notesPage * pageSize + pageSize)} of ${items.length}</span>${(notesPage + 1) * pageSize < items.length ? control("Next notes", { type: "local", what: "notesPage", page: notesPage + 1 }) : ""}</div>` : "") : "");
  if (els.attention.innerHTML !== html) els.attention.innerHTML = html;
}

// Focus hides cross-thread cards without acknowledging or navigating them. This disclosure is
// read-only; the native Full view control restores the list for an explicit conversation choice.
function renderFocusReview() {
  const selected = model?.detail.kind === "thread" ? model.detail.id : undefined;
  const others = model?.attention?.filter(item => item.thread !== selected) ?? [];
  if (!layout?.focus || !others.length) { els.focusReview.style.display = "none"; return; }
  els.focusReview.style.display = "";
  const urgent = others.some(item => item.pending || item.label !== "Reply waiting");
  const counts = [
    [others.filter(item => item.pending).length, "approval", "approvals"],
    [others.filter(item => !item.pending && item.label !== "Reply waiting").length, "alert", "alerts"],
    [others.filter(item => !item.pending && item.label === "Reply waiting").length, "reply", "replies"],
  ].filter(([count]) => count).map(([count, singular, plural]) => `${count} ${count === 1 ? singular : plural}`).join(", ");
  const label = focusReviewOpen ? `Other: ${counts} · Hide`
    : `${others.length} other update${others.length === 1 ? "" : "s"}${urgent ? " · Review" : ""}`;
  const html = `<span class="btn focus-review-toggle ${urgent ? "warn" : ""}" aria-expanded="${focusReviewOpen}" data-act="${attr({ type: "local", what: "focusReview" })}">${label}</span>` +
    (focusReviewOpen ? `<div class="focus-review-copy">Use Full view below.</div>` : "");
  if (els.focusReview.innerHTML !== html) els.focusReview.innerHTML = html;
}

// ---- input from the addon -----------------------------------------------------------------------
function regionEl(r: string): HTMLElement | null {
  return r === "list" ? els.list : r === "detail" ? els.detail : r === "tracker" ? els.tracker : r === "status" ? els.status : null;
}

function pointIn(r: string, x: number, y: number): Element | null {
  const el = regionEl(r);
  if (!el || el.style.display === "none") return null;
  const b = el.getBoundingClientRect();
  return document.elementFromPoint(b.left + x * b.width, b.top + y * b.height);
}

let hovered: Element | null = null;

function toLatest() {
  follow = model?.detail.kind === "thread";
  els.detailScroll.scrollTop = els.detailScroll.scrollHeight;
  els.latest.style.display = "none";
  rememberReadingPlace();
}

function onInput(ev: any) {
  if (!visible && !devInput) {
    // Never act on clicks the player can't see (the Glass is hidden or not yet aligned).
    if (ev.t === "click") bridge.log(`[glass] ignored ${ev.r} click while hidden`);
    return;
  }
  if (ev.t === "wheel") {
    if (ev.r === "detail" && model?.detail.kind === "thread" && model.detail.loading && !model.detail.entries.length) return;
    // The "Jump to the latest reply" binding: the same as clicking Latest.
    if (ev.r === "detail" && ev.d <= -9999) return toLatest();
    const target = ev.r === "list" ? els.listScroll : ev.r === "detail" ? els.detailScroll : ev.r === "tracker" ? els.tracker : null;
    if (!target) return;
    target.scrollTop -= ev.d * 4 * parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h") || "16");
    if (ev.r === "detail") {
      follow = model?.detail.kind === "thread" && target.scrollTop + target.clientHeight >= target.scrollHeight - 8;
      els.latest.style.display = model?.detail.kind !== "thread" || follow ? "none" : "";
      rememberReadingPlace();
    }
    return;
  }
  if (ev.t === "hover") {
    const hit = ev.x < 0 ? null : (pointIn(ev.r, ev.x, ev.y)?.closest("[data-act]") ?? null);
    if (hit !== hovered) {
      hovered?.classList.remove("hover");
      hit?.classList.add("hover");
      hovered = hit;
    }
    return;
  }
  if (ev.t === "click") {
    const hit = pointIn(ev.r, ev.x, ev.y)?.closest("[data-act]") as HTMLElement | null;
    if (!hit) return;
    const raw = ev.b === "R" ? (hit.dataset.act2 ?? hit.dataset.act) : hit.dataset.act;
    if (!raw) return;
    hit.classList.add("pressed");
    setTimeout(() => hit.classList.remove("pressed"), 160);
    const act = JSON.parse(raw);
    if (act.type === "local") {
      if (act.what === "focusReview") { focusReviewOpen = !focusReviewOpen; render(); }
      if (act.what === "details") { detailsOpen = !detailsOpen; render(); }
      if (act.what === "notes") { notesOpen = !notesOpen; render(); }
      if (act.what === "notesPage") { notesPage = act.page; render(); }
      if (act.what === "openUpdate") {
        notesOpen = false;
        pendingJump = { thread: act.thread, entry: act.entry };
        bridge.action({ type: "select", id: act.thread, entry: act.entry });
      }
      if (act.what === "bottom") toLatest();
      if (act.what === "reveal") {
        const id = (hit.closest(".entry") as HTMLElement | null)?.dataset.id;
        if (id && blurOn()) reveal(id);
      }
      return;
    }
    if (act.type === "approvalPreview" || (["more", "retryHistory"].includes(act.type) && model?.detail.kind === "thread" && model.detail.entries.length)) {
      follow = false;
      restorePlace = currentReadingPlace(); // Keep the text being read in place through expansion/recovery.
    }
    bridge.action(act);
  }
}

// ---- wiring -------------------------------------------------------------------------------------
// Layouts can arrive ~120 times a second while a frame is dragged: apply the newest once per paint.
let layoutFrame = 0;
bridge.on("layout", (l: Layout) => {
  // Capture before changing header height or pane geometry. A layout must never turn a reader
  // into a follower or discard expanded entries/loaded history merely because focus toggled.
  const modeChanged = !!layout?.focus !== !!l.focus;
  const resized = layout?.detail?.[2] !== l.detail?.[2] || layout?.detail?.[3] !== l.detail?.[3];
  if ((modeChanged || resized) && !follow && !restorePlace) restorePlace = currentReadingPlace();
  layout = l;
  if (modeChanged) {
    focusReviewOpen = false;
    render();
  }
  if (!layoutFrame)
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      applyLayout(true);
    });
});
bridge.on("model", (m: RenderModel) => {
  // Font size and where notices go are applied with the layout.
  const relayout = !model || model.fontScale !== m.fontScale || model.raidWarnings !== m.raidWarnings;
  model = m;
  if (m.providers) PROVIDERS = m.providers;
  render();
  if (relayout) applyLayout();
});
bridge.on("input", onInput);
bridge.on("vis", (v: { visible: boolean; devInput?: boolean }) => {
  visible = v.visible;
  devInput = !!v.devInput;
  document.body.classList.toggle("hidden", !visible);
  applyLayout();
});
window.addEventListener("resize", () => applyLayout());

// ---- audio: the six synthesized cues (shared/cues.ts; no assets) and optional speech ----------------
// Main sends { kind, volume } (volume 0..1, cfg.soundVolume / 100); an older main sends the bare cue
// name, played at the default volume. Anything else is ignored. The context is built on the first cue.
let audio: AudioContext | null = null;
bridge.on("sound", (p: unknown) => {
  const { kind, volume } = (typeof p === "string" ? { kind: p } : (p ?? {})) as { kind?: unknown; volume?: unknown };
  if (typeof kind !== "string" || !(CUES as readonly string[]).includes(kind)) return;
  playCue((audio ??= new AudioContext()), kind as Cue, typeof volume === "number" && Number.isFinite(volume) ? volume : DEFAULT_CUE_VOLUME);
});
bridge.on("speak", (text: string) => {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch {
    /* no voices */
  }
});

// ---- helpers ------------------------------------------------------------------------------------
/** Escape, colouring unified-diff style +/- lines when the text looks like a diff. */
function diffHtml(text: string): string {
  const lines = text.split("\n");
  const looksDiff = lines.filter((l) => /^[+-]/.test(l)).length >= Math.min(2, lines.length);
  if (!looksDiff) return esc(text);
  return lines
    .map((l) =>
      l.startsWith("+") && !l.startsWith("+++")
        ? `<span class="d-add">${esc(l)}</span>`
        : l.startsWith("-") && !l.startsWith("---")
          ? `<span class="d-del">${esc(l)}</span>`
          : l.startsWith("@@")
            ? `<span class="d-hunk">${esc(l)}</span>`
            : esc(l),
    )
    .join("\n");
}

function md(text: string): string {
  try {
    return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { ALLOW_DATA_ATTR: false, FORBID_ATTR: ["style", "id"] });
  } catch {
    return esc(text);
  }
}
function esc(s: string) {
  return escapeHtml(s ?? "");
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function escapeAttr(s: string) {
  return escapeHtml(s);
}
function approvalText(a: string | undefined, agent: string) {
  const always = agent === "claude" || agent === "codex" ? "Approved (always, this quest)" : "Approved (always)";
  return { approved: "Approved", always, denied: "Denied", expired: "Request expired. The agent no longer waits for this; send a message to retry." }[a ?? ""] ?? "";
}

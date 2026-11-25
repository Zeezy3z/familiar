// Desktop control panel, in a fixed order that never moves between states: header · Requests waiting (when any) ·
// one status line · Play · Safety · Familiars · Projects · Troubleshooting (collapsed) · footer. Text that came from
// an agent, the game or the network is only ever set with textContent (or esc() inside a template), never as markup.
import { PRIVACY, alwaysLabel, approveKeyStatus, familiarStatus, journey, keyToBinding, portraitFor, privacyLevel, waitingOnlyHere, type PrivacyLevel } from "./journey";
import { buildPresentation, restartGuidance, updateLine, versionLabel, versionMismatch } from "./build";
import type { ControlBridge } from "../shared/bridge";
import { CUES, cueLabel, playCue } from "../shared/cues";
const bridge = window.familiar as ControlBridge;

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const kv = (rows: [string, unknown, string?][]) => rows.map(([k, v, cls]) => `<div>${esc(k)}</div><div class="${cls ?? ""}">${esc(v)}</div>`).join("");
const text = (id: string, value: string) => { if ($(id).textContent !== value) $(id).textContent = value; };
// Replay the one-shot "arrive" slide on an element whose content just changed (reduced motion switches it off in CSS).
const arrive = (el: HTMLElement) => { el.classList.remove("arrive"); void el.offsetWidth; el.classList.add("arrive"); };

// ---- feedback beside the control that caused it ---------------------------------------------------------------
// Every settings row and button group carries its own empty live region from the start (a region added together
// with its text is often not announced). say() writes into the one nearest the control; an ok line fades after a
// while, an error stays until the next try.
const FB_HOSTS = ".set, .btns, #familiars, #status";
for (const host of document.querySelectorAll<HTMLElement>(".set, .btns")) {
  const fb = document.createElement(host.classList.contains("btns") ? "span" : "p");
  fb.className = "fb";
  fb.setAttribute("role", "status");
  host.append(fb);
}
const fbTimers = new WeakMap<HTMLElement, number>();
function say(from: Element, message: string, level: "ok" | "warn" | "err" = "ok") {
  const host = from.closest<HTMLElement>(".req") ?? from.closest<HTMLElement>(FB_HOSTS); // a request answers under its own buttons
  const fb = host?.querySelector<HTMLElement>(":scope > .fb, :scope > .req-msg");
  if (!fb) return;
  clearTimeout(fbTimers.get(fb));
  fb.textContent = message;
  fb.className = `${fb.classList.contains("req-msg") ? "req-msg" : "fb"} ${message ? level : ""}`;
  if (message && level === "ok") fbTimers.set(fb, window.setTimeout(() => { if (fb.textContent === message) fb.textContent = ""; }, 8000));
}
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Run one panel action and say how it went next to `where`. */
async function act(where: Element, message: string | (() => string), fn: () => unknown) {
  say(where, "");
  try {
    await fn();
    const m = typeof message === "function" ? message() : message;
    if (m) say(where, m, "ok");
  } catch (e) {
    say(where, `Couldn't do that: ${reasonOf(e)}`, "err");
    await refreshStatus().catch(() => {});
  }
}
/** A button that runs an action: disabled while it runs, focus kept on it afterwards. */
const btn = (id: string, message: string | (() => string), fn: () => unknown) => $(id).addEventListener("click", async () => {
  const button = $(id) as HTMLButtonElement;
  const focused = document.activeElement === button;
  button.disabled = true;
  await act(button, message, fn);
  button.disabled = false;
  if (focused && (document.activeElement === document.body || !document.activeElement) && button.offsetParent) button.focus();
});

let paused = false;

function render(s: any) {
  paused = !!s.overlay?.paused;
  text("b-pause", paused ? "Resume overlay" : "Pause overlay");
  renderStatusLine(s);
  text("ver", versionLabel(s.version));
  const mismatch = versionMismatch(s.update);
  $("vermismatch").hidden = !mismatch;
  text("vermismatch", mismatch?.text ?? "");
  const build = buildPresentation(s.version, s.build);
  text("build-summary", build.summary);
  const buildId = $("build-id") as HTMLInputElement;
  if (buildId.value !== build.diagnostic) buildId.value = build.diagnostic;
  const restart = restartGuidance(s.work);
  text("restart-title", restart.title);
  $("restart-title").className = restart.level;
  text("restart-state", restart.text);
  const badge = s.linked ? '<span class="ok">● linked</span>' : '<span class="muted">○ not linked</span>';
  if ($("linkbadge").innerHTML !== badge) $("linkbadge").innerHTML = badge;
  renderTroubleshooting(s);
  ($("c-login") as HTMLInputElement).checked = !!s.launchAtLogin;
  renderUi(s.ui);
  renderQuest(s.quest);
  renderProviders(s.providers ?? [], s.backends ?? {}, s.claude);
  renderRequests(s.requests); // after the providers: a request names its familiar by label
  renderProjects(s.projects);
  if (s.update?.last) showUpdate(s.update.last); // the last "Check for updates" answer, from the click that asked
}

// ---- the status line ------------------------------------------------------------------------------------------
// "All set — type /fam in WoW", or the single step in the way with its action. The three-step strip shows only
// while setup is incomplete. Saved quests that need attention outrank everything else on the line; next, requests
// waiting that the game cannot approve (no Approve key, click approval off), with Set key.
const ACTIONS: Record<string, string> = { providers: "Review familiars", config: "Open config", key: "Set key…" };
function renderStatusLine(s: any) {
  const j = journey(s);
  const only = waitingOnlyHere(s.ui, (Array.isArray(s.requests) ? s.requests : []).filter(validRequest).length);
  const line = s.storage ? { title: "Saved quests need attention", text: String(s.storage.text ?? ""), level: s.storage.level === "error" ? "err" : "warn", textLevel: "", action: "" }
    : only ? { ...only, textLevel: "warn" }
    : { title: j.title, text: j.text, level: j.level, textLevel: "textLevel" in j && j.textLevel ? j.textLevel : "", action: j.action ?? "" };
  if ($("journey-title").textContent !== line.title) { text("journey-title", line.title); arrive($("journey-title")); }
  $("journey-title").className = line.level;
  text("journey-text", line.text);
  $("journey-text").className = `hint ${line.textLevel}`;
  showPortrait(portraitFor(s, j.current));
  // One line per step; the whole sentence is its title, and what a screen reader hears.
  const strip = $("journey-steps");
  strip.hidden = j.current === -1;
  const steps = j.steps.map((step, i) => `<li${i === j.current ? ' class="cur" aria-current="step"' : ""}><b class="${step.done ? "ok" : ""}">${i + 1} ${esc(step.label)}${step.done ? " ✓" : ""}</b><span class="hint" title="${esc(step.text)}" aria-hidden="true">${esc(j.hints[i])}</span><span class="sr">${esc(step.text)}</span></li>`).join("");
  if (strip.dataset.html !== steps) { strip.dataset.html = steps; strip.innerHTML = steps; }
  // The pause toggle sits on the right of the line already, so "paused" needs no second button.
  const action = ACTIONS[line.action] ? line.action : "";
  const next = $("journey-action") as HTMLButtonElement;
  next.hidden = !action;
  next.dataset.action = action;
  text("journey-action", ACTIONS[action] ?? "");
}
const scrollTo = (el: HTMLElement) => el.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
$("journey-action").addEventListener("click", (e) => {
  const action = $("journey-action").dataset.action;
  if (action === "providers") {
    const card = $("familiars");
    scrollTo(card);
    (card.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? card).focus({ preventScroll: true });
  } else if (action === "config") act($("journey-action"), "Config opened", () => openFile("openConfig"));
  else if (action === "key" && e.isTrusted) { // straight to "Press a key…" on the Approve key row
    scrollTo($("approve-key-row"));
    keyBtn.focus({ preventScroll: true });
    startCapture();
  }
});
btn("b-pause", () => (paused ? "Overlay paused" : "Overlay showing again"), async () => {
  paused = await bridge.invoke("pause", !paused);
  await refreshStatus();
});

// The header portrait. A face whose picture is missing (an older or partial build) falls back to idle, once.
const missingFaces = new Set<string>();
function showPortrait(face: string) {
  const img = $("portrait") as HTMLImageElement;
  const src = `assets/${missingFaces.has(face) ? "idle" : face}-192.png`;
  if (img.getAttribute("src") !== src) img.setAttribute("src", src);
}
$("portrait").addEventListener("error", () => {
  const face = /assets\/([a-z]+)-192\.png$/.exec($("portrait").getAttribute("src") ?? "")?.[1];
  if (!face || face === "idle" || missingFaces.has(face)) return;
  missingFaces.add(face);
  showPortrait(face);
});

// ---- Requests waiting -----------------------------------------------------------------------------------------
// Every pending approval, with the whole text before the buttons (status.requests[] and the "decide" command are the
// hub lane's). A request the game card shows only in part is marked. Only a real click or key press decides. Always
// is worded as the Glass words it (alwaysLabel), and persistent grants are given here only.
interface PanelRequest { thread: string; questTitle: string; project: string; agent: string; agentId?: string; requestId: string; title: string; detail?: string; full?: string; cut?: boolean; canAlways: boolean; at: number }
const SETTLE_MS = 800; // a row that just appeared ignores clicks briefly, so a layout shift cannot land one on it
const requestRows = new Map<string, HTMLElement>();
let requestSeq = 0;
// The whole text: `full` when the game card cuts it, the card's own text otherwise. A cut request with no `full` is not listed.
const requestText = (r: PanelRequest) => (r.cut === true ? r.full : r.full ?? r.detail);
const validRequest = (r: any): r is PanelRequest => !!r && typeof r.thread === "string" && typeof r.requestId === "string" && typeof requestText(r) === "string";
let providerLabels: Record<string, string> = {};

function buildRequest(r: PanelRequest): HTMLElement {
  const id = `req-${++requestSeq}`;
  const make = (tag: string, cls: string, attrs: Record<string, string> = {}) => {
    const el = document.createElement(tag);
    el.className = cls;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const row = make("article", "req", { "aria-labelledby": `${id}-title` });
  row.dataset.thread = r.thread;
  row.dataset.request = r.requestId;
  row.dataset.agent = r.agentId ?? r.agent;
  const btns = make("div", "btns");
  const decisions: [string, string, string][] = [["allow", "Approve", "ok"], ["deny", "Deny", "primary"], ["allowAlways", alwaysLabel(r.agentId ?? r.agent).label, "always"]];
  for (const [decision, label, cls] of decisions) {
    const b = make("button", cls, { type: "button", "data-decide": decision, "aria-describedby": `${id}-title` }) as HTMLButtonElement;
    b.textContent = label;
    b.disabled = true;
    btns.append(b);
  }
  setTimeout(() => { if (!row.dataset.sent) btns.querySelectorAll("button").forEach((b) => (b.disabled = false)); }, SETTLE_MS);
  const head = make("div", "req-head");
  const badge = make("span", "badge", { hidden: "" });
  badge.textContent = "Too long for the in-game card";
  head.append(make("h3", "req-title", { id: `${id}-title` }), badge);
  // The whole text comes first; the buttons follow it; the answer lands under them.
  row.append(head, make("p", "hint req-meta"), make("pre", "req-full", { id: `${id}-full`, tabindex: "0", "aria-label": "The full request" }), btns, make("p", "req-msg", { role: "status" }));
  return row;
}

function renderRequests(list: unknown) {
  const rows = (Array.isArray(list) ? list : []).filter(validRequest).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  $("requests").hidden = !rows.length;
  text("requests-live", rows.length ? `${rows.length} request${rows.length === 1 ? "" : "s"} waiting` : "");
  const host = $("requests-list");
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.thread}\0${r.requestId}`;
    seen.add(key);
    let row = requestRows.get(key);
    if (!row) { row = buildRequest(r); requestRows.set(key, row); host.append(row); } // newcomers join at the end: nothing above moves
    const since = Number.isFinite(r.at) ? ` · waiting since ${new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    const set = (sel: string, value: string) => { const el = row!.querySelector(sel)!; if (el.textContent !== value) el.textContent = value; };
    set(".req-title", r.title || "Request");
    set(".req-meta", [providerLabels[r.agent] ?? r.agent, r.project, r.questTitle].filter(Boolean).join(" · ") + since);
    set(".req-full", requestText(r)!); // left alone while unchanged, so a reader's scroll position stays put
    row.querySelector<HTMLElement>(".badge")!.hidden = r.cut !== true;
    row.querySelector<HTMLElement>("[data-decide=allowAlways]")!.hidden = !r.canAlways;
  }
  for (const [key, row] of requestRows) if (!seen.has(key)) { row.remove(); requestRows.delete(key); }
}

$("requests-list").addEventListener("click", async (e) => {
  // Never automatic: a click made by script (isTrusted false) decides nothing.
  if (!e.isTrusted) return;
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-decide]");
  const row = button?.closest<HTMLElement>(".req");
  if (!button || !row || button.disabled || !row.dataset.thread) return;
  const decision = button.dataset.decide;
  const done = decision === "allow" ? "Approved" : decision === "deny" ? "Denied" : alwaysLabel(row.dataset.agent).done;
  const buttons = row.querySelectorAll<HTMLButtonElement>("button");
  row.dataset.sent = "1";
  buttons.forEach((b) => (b.disabled = true));
  let answer: { ok?: boolean; why?: string } | undefined;
  let failure = "";
  try { answer = await bridge.invoke("decide", { thread: row.dataset.thread, requestId: row.dataset.request, decision }); }
  catch (err) { failure = reasonOf(err); }
  if (answer?.ok === true) say(button, `${done}.`, "ok");
  else {
    delete row.dataset.sent;
    buttons.forEach((b) => (b.disabled = false));
    const gone = answer?.why === "no longer pending";
    say(button, failure ? `Couldn't send that answer: ${failure}`
      : gone ? "Already answered."
      : answer?.why === "fresh" ? "This request just appeared. Read it, then click again."
      : `Not applied${answer?.why ? `: ${answer.why}` : ""}.`, gone ? "warn" : "err");
  }
  await refreshStatus().catch(() => {});
});

// ---- Familiars ------------------------------------------------------------------------------------------------
// One row per agent with one status (familiarStatus decides which signal speaks); Sign in, Retry and Install… show
// only when that is what the row needs; Use switches it on or off.
function renderProviders(list: any[], backends: Record<string, any>, claude: unknown) {
  providerLabels = Object.fromEntries(list.map((p) => [p.id, String(p.label ?? p.id)]));
  const html = list
    .map((p) => {
      const st = familiarStatus(p, backends[p.id], claude as any);
      const progress = st.downloading ? `<progress aria-label="Claude Code download"${st.pct != null ? ` max="100" value="${st.pct}"` : ""}></progress>` : "";
      const cmd = !p.installed && p.installCommand && !st.retry ? ` — <code>${esc(p.installCommand)}</code>` : "";
      const actions = [
        st.retry ? `<button type="button" class="small primary" data-retry="claude">${esc(st.retry)}</button>` : "",
        st.install ? `<button type="button" class="small" data-install="${esc(p.id)}">Install…</button>` : "",
        st.signIn ? `<button type="button" class="small primary" data-login="${esc(p.id)}">Sign in</button>` : "",
        `<label class="hint"><input type="checkbox" data-enable="${esc(p.id)}" aria-label="Use ${esc(p.label)} in Familiar" ${p.enabled ? "checked" : ""} ${p.installed ? "" : "disabled"}> Use</label>`,
      ].join("");
      return `<div class="prov ${p.enabled ? "" : "off"}"><span class="g" aria-hidden="true">${esc(p.glyph)}</span><span class="n">${esc(p.label)}</span><span class="d" title="${esc(p.detail)}"><span class="${st.level}">${esc(st.text)}</span>${cmd}${progress}</span><span class="a">${actions}</span></div>`;
    })
    .join("");
  setHtml($("providers"), html, ["install", "login", "enable", "retry"]);
}
$("providers").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset.install) act($("providers"), "Installation page opened", () => bridge.invoke("providerInstall", t.dataset.install));
  if (t.dataset.login) act($("providers"), "Sign-in window opened. Complete sign-in there; Familiar checks again when the agent starts.", () => bridge.invoke("providerLogin", t.dataset.login));
  if (t.dataset.retry) act($("providers"), "Claude Code is downloading.", async () => { await bridge.invoke("claudeRetry"); await refreshStatus(); });
});
$("providers").addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.enable) act($("providers"), `${providerLabels[t.dataset.enable] ?? t.dataset.enable} ${t.checked ? "on" : "off"}`, async () => { await bridge.invoke("providerEnable", { id: t.dataset.enable, on: t.checked }); await refreshStatus(); });
});

// ---- Troubleshooting ------------------------------------------------------------------------------------------
function renderTroubleshooting(s: any) {
  const c = s.capture ?? {};
  $("link").innerHTML = kv([
    ["Status", s.linked ? "Linked" : s.game ? "Searching for the game link…" : "Waiting for WoW", s.linked ? "ok" : "warn"],
    ...(typeof s.doctor?.text === "string" && s.doctor.text ? [["Link doctor", s.doctor.text, s.doctor.level === "ok" ? "ok" : s.doctor.level === "warn" ? "warn" : "muted"] as [string, unknown, string]] : []),
    ["Capture", c.fps ? `${c.fps} fps · ${c.frameW}×${c.frameH}` : "—"],
    ["Frames", `${c.decoded ?? 0} decoded · ${c.crc ?? 0} crc · ${c.missed ?? 0} missed`],
    ["Messages", `${c.msgs ?? 0} received${s.lastMsgAgo != null ? ` · last ${Math.round(s.lastMsgAgo / 1000)}s ago` : ""}`],
    ["Lock", c.lock ? `${c.lock.x.toFixed(1)}, ${c.lock.y.toFixed(1)} · ${c.lock.pitch.toFixed(2)}px cells` : "—"],
    ["Overlay", paused ? "paused" : s.overlay?.shown ? "showing" : "hidden"],
    ["Quests", String(s.threads ?? 0)],
    ...(c.error ? [["Error", c.error, "err"] as [string, unknown, string]] : []),
  ]);
  const g = s.game;
  const installRow: [string, unknown, string] = ["Install", s.install ? (g ? s.install.flavor : s.install.dir) : s.installError ?? "not found", s.install ? "" : "warn"];
  const clientRow: [string, unknown, string][] = s.wow ? [["Client", s.wow.text, s.wow.level === "ok" ? "ok" : "warn"]] : [];
  const wrongRow: [string, unknown, string][] = s.wrongClient ? [["Status", `WoW is running (${s.wrongClient.exe} in ${s.wrongClient.dir}) but it isn't the Forever client. Familiar only links to WoW: Forever.`, "warn"]] : [];
  $("game").innerHTML = g
    ? kv([
        ["Process", g.exe],
        ["Window", `${g.client?.width}×${g.client?.height} at ${g.client?.x},${g.client?.y}`],
        ["State", g.minimized ? "minimized" : g.foreground ? "foreground" : "background"],
        installRow,
        ...clientRow,
      ])
    : kv([...(wrongRow.length ? wrongRow : [["Status", "World of Warcraft is not running", "warn"] as [string, unknown, string]]), installRow, ...clientRow]);
  const a = s.addon ?? {};
  $("addon").innerHTML = kv([
    ["Character", a.char ? `${a.char} — ${a.realm}` : "— (no hello yet)"],
    ["Client", a.build ? `${a.build} (interface ${a.iface})` : "—"],
    ["Addon", a.addon ?? "—"],
    ["Panel", s.layout ? (s.layout.panel ? "open" : "closed") : "—"],
  ]);
  $("notes").innerHTML = (s.installNotes ?? []).map((n: string) => `<li>${esc(n)}</li>`).join("");
}
function addLog(line: string) {
  const el = $("log");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.textContent += line + "\n";
  if (el.textContent!.length > 60000) el.textContent = el.textContent!.slice(-40000);
  if (atBottom) el.scrollTop = el.scrollHeight;
}
const openFile = async (cmd: string) => {
  const error = await bridge.invoke(cmd);
  // Electron shell.openPath resolves to an error string rather than rejecting.
  if (typeof error === "string" && error) throw new Error(error);
};
btn("b-install", "Addon install checked. Notes are listed above.", async () => { await bridge.invoke("install"); await refreshStatus(); });
btn("b-toast", "Overlay test sent. Look for the notice over WoW while the Glass is visible.", () => bridge.invoke("testToast"));
btn("b-config", "Config opened", () => openFile("openConfig"));
btn("b-reload", "Config reloaded", async () => { await bridge.invoke("reloadConfig"); await refreshStatus(); });
btn("b-logs", "Log file opened", () => openFile("openLogs"));
btn("b-diag", "Diagnostics copied to the clipboard (redacted). Review before posting.", () => bridge.invoke("diagnostics"));
btn("b-refresh", "Desktop quests rescanned", async () => { await bridge.invoke("refresh"); await refreshStatus(); });
// Save what Familiar sees: a small crop of the strip corner, written by the companion; named here, never shown.
btn("b-snapshot", () => "", async () => { // the line under the button is the answer
  $("snapshot-result").replaceChildren();
  const r = await bridge.invoke("captureSnapshot");
  if (!r?.ok) throw new Error(typeof r?.why === "string" && r.why ? r.why : "Familiar has no picture of the game to save yet");
  const name = typeof r.file === "string" ? r.file.split(/[\\/]/).pop() : "";
  const open = document.createElement("button");
  open.type = "button";
  open.id = "b-open-snapshot";
  open.className = "linklike";
  open.textContent = "Open folder";
  open.addEventListener("click", () => act(open, "", () => bridge.invoke("openSnapshot")));
  $("snapshot-result").replaceChildren(`Saved ${name || "a picture"} in your Familiar folder. It shows the top-left 320×32 pixels of the game window; look at it before attaching it to a bug report. `, open);
});

// ---- Play and Safety: settings rows ---------------------------------------------------------------------------
const DEFAULT_VOLUME = 70;
const volume = $("ui-volume") as HTMLInputElement;
const fontSel = $("ui-font") as HTMLSelectElement;
const privacySel = $("ui-privacy") as HTMLSelectElement;
for (let p = 80; p <= 160; p += 10) fontSel.add(new Option(`${p}%${p === 100 ? " (default)" : ""}`, String(p / 100)));
const risky = (v: string) => v === "edits" || v === "auto";
const modeNames: Record<string, string> = { ask: "Ask first", edits: "Accept edits", plan: "Plan only", auto: "Auto" };
/** The warning under the mode, and the header pill, while new quests do not start in Ask first. */
function showMode(v: string) {
  $("ui-mode-warn").hidden = !risky(v);
  const b = $("modebadge");
  b.hidden = v === "ask";
  text("modebadge", v === "ask" ? "" : `New quests: ${modeNames[v] ?? v}`);
}
type Ui = { fontScale: number; sound: boolean; soundVolume?: number; raidWarnings: boolean; trayNotices?: boolean; quiet?: boolean; privateMode?: boolean; streamSafe?: boolean; privacy?: PrivacyLevel; defaultMode?: string; approveKey?: string; approveByClick?: boolean; inheritAgentConfig?: boolean };
let shownPrivacy: PrivacyLevel = "off";
let savedKey = "";
let byClick = false;
/** A switch main does not report yet (an older build) is shown off and cannot be changed. */
function showSwitch(id: string, value: unknown) {
  const box = $(id) as HTMLInputElement;
  box.disabled = typeof value !== "boolean";
  box.checked = value === true;
  box.title = box.disabled ? "This build of Familiar does not have this setting yet" : "";
}
function renderUi(ui?: Ui) {
  if (!ui) return;
  if (document.activeElement !== fontSel) fontSel.value = String(Math.round(ui.fontScale * 10) / 10);
  ($("ui-sound") as HTMLInputElement).checked = ui.sound;
  if (document.activeElement !== volume) { volume.value = String(Number.isFinite(ui.soundVolume) ? ui.soundVolume : DEFAULT_VOLUME); text("ui-volume-out", volume.value); }
  ($("ui-raid") as HTMLInputElement).checked = ui.raidWarnings;
  ($("ui-tray") as HTMLInputElement).checked = ui.trayNotices !== false; // on unless switched off
  ($("ui-quiet") as HTMLInputElement).checked = ui.quiet === true;
  shownPrivacy = privacyLevel(ui);
  if (document.activeElement !== privacySel) privacySel.value = shownPrivacy;
  text("ui-privacy-sh", PRIVACY[shownPrivacy].hint);
  if (ui.defaultMode) { if (document.activeElement !== $("ui-mode")) ($("ui-mode") as HTMLSelectElement).value = ui.defaultMode; showMode(ui.defaultMode); }
  showSwitch("ui-click", ui.approveByClick);
  showSwitch("ui-inherit", ui.inheritAgentConfig);
  savedKey = ui.approveKey ?? "";
  byClick = ui.approveByClick === true;
  if (!capturing) showApproveKey();
}
const refreshStatus = () => bridge.invoke("status").then(render);
// The status line reads the settings too (no key and click approval off), so it is redrawn with them.
const setUi = (where: Element, patch: object, message: string) => act(where, message, () => bridge.invoke("uiSettings", patch).then(renderUi).then(refreshStatus));

fontSel.addEventListener("change", () => setUi(fontSel, { fontScale: Number(fontSel.value) }, `Text size ${Math.round(Number(fontSel.value) * 100)}%`));
$("ui-sound").addEventListener("change", (e) => { const on = (e.target as HTMLInputElement).checked; setUi(e.target as Element, { sound: on }, on ? "Sounds on" : "Sounds off"); });
volume.addEventListener("input", () => text("ui-volume-out", volume.value));
volume.addEventListener("change", () => setUi(volume, { soundVolume: Number(volume.value) }, `Sound volume ${volume.value}%`)); // on release, not every tick
// Play a sample: the six cues in the panel itself, one per click, through the same playCue the Glass uses.
let audio: AudioContext | undefined;
let sampleNext = 0;
$("b-sound-sample").addEventListener("click", (e) => {
  if (!e.isTrusted) return; // sound only ever follows a real click, never a script
  const cue = CUES[sampleNext % CUES.length];
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    playCue(audio, cue, Number(volume.value) / 100);
    sampleNext++;
    text("sound-sample", `Played: ${cueLabel(cue)}`);
  } catch {
    text("sound-sample", "This window could not play the sample.");
  }
});
$("ui-raid").addEventListener("change", (e) => { const on = (e.target as HTMLInputElement).checked; setUi(e.target as Element, { raidWarnings: on }, on ? "Raid-warning style on" : "Small notices in the Familiar window"); });
$("ui-tray").addEventListener("change", (e) => { const on = (e.target as HTMLInputElement).checked; setUi(e.target as Element, { trayNotices: on }, on ? "Windows notices on" : "Windows notices off"); });
// Quiet play: finished quests and replies wait as catch-up notes; requests still reach you.
$("ui-quiet").addEventListener("change", (e) => { const on = (e.target as HTMLInputElement).checked; setUi(e.target as Element, { quiet: on }, on ? "Holding ordinary notices" : "Notices show as they come"); });
privacySel.addEventListener("change", () => {
  const to = privacySel.value as PrivacyLevel;
  if (to !== shownPrivacy) setUi(privacySel, { privacy: to }, PRIVACY[to].done); // main moves both saved settings in one step
});
$("ui-mode").addEventListener("change", (e) => {
  const mode = (e.target as HTMLSelectElement).value;
  showMode(mode);
  setUi(e.target as Element, { defaultMode: mode }, `New quests will start in ${modeNames[mode] ?? mode}`);
});
// The quest open in the game (status.quest): its mode is set here only ("questMode"); the game cannot change it.
// The title is shown as the requests list shows names: real, since this window is on the PC.
const questSel = $("quest-mode") as HTMLSelectElement;
$("quest-warn").innerHTML = $("ui-mode-warn").innerHTML; // the same fixed wording, copied from this page's own markup
let questMode = "";
let questId = ""; // sent with the choice: main refuses it if another quest is open by then
function showQuestWarn() { $("quest-warn").hidden = !risky(questSel.value); }
function renderQuest(q: unknown) {
  const quest = q && typeof q === "object" && typeof (q as any).id === "string" && typeof (q as any).title === "string" && Object.hasOwn(modeNames, (q as any).mode) ? q as { id: string; title: string; mode: string } : null;
  $("quest-row").hidden = !quest;
  if (!quest) return;
  text("quest-title", quest.title.trim() || "Untitled quest");
  questId = quest.id;
  questMode = quest.mode;
  if (document.activeElement !== questSel) questSel.value = quest.mode;
  showQuestWarn();
}
questSel.addEventListener("change", () => {
  const mode = questSel.value;
  showQuestWarn();
  act(questSel, `Next turn: ${modeNames[mode] ?? mode}`, async () => {
    const r = await bridge.invoke("questMode", { mode, thread: questId });
    if (!r?.ok) {
      questSel.value = questMode; // still focused, so the status redraw would leave the refused choice showing
      showQuestWarn();
      throw new Error(typeof r?.why === "string" && r.why ? r.why : "the mode did not change");
    }
    await refreshStatus();
  });
});
$("ui-click").addEventListener("change", (e) => { const on = (e.target as HTMLInputElement).checked; setUi(e.target as Element, { approveByClick: on }, on ? "Clicking Approve on the in-game card now counts" : "In-game approvals need the Approve key"); });
$("ui-inherit").addEventListener("change", (e) => { const on = (e.target as HTMLInputElement).checked; setUi(e.target as Element, { inheritAgentConfig: on }, on ? "New quests from the game use your agent configuration" : "New quests from the game use Familiar's own settings only"); });

// Approve key: captured by pressing it (Set key…, then the key), never typed by name. Escape cancels; Tab moves on.
let capturing = false;
let capturedAt = 0;
const keyBtn = $("b-key-set") as HTMLButtonElement;
function showApproveKey() {
  const st = approveKeyStatus(savedKey, byClick);
  text("approve-key-val", st.level === "ok" ? savedKey.trim().toUpperCase() : "");
  text("approve-key-line", st.text);
  $("approve-key-line").className = st.level === "muted" ? "" : st.level;
  text("approve-key-warn", st.warning);
  $("b-key-clear").hidden = st.level !== "ok";
  $("approve-key-how").hidden = st.level === "ok"; // how to bind it, only until a key is set
  text("b-key-set", st.level === "ok" ? "Change key…" : "Set key…");
}
function stopCapture() {
  capturing = false;
  keyBtn.setAttribute("aria-pressed", "false");
  showApproveKey();
}
function startCapture() {
  capturing = true;
  keyBtn.setAttribute("aria-pressed", "true");
  text("b-key-set", "Press a key…");
  text("approve-key-line", "Press the key you bound in WoW. Escape cancels.");
  $("approve-key-line").className = "";
  text("approve-key-warn", "");
  $("approve-key-how").hidden = false;
}
keyBtn.addEventListener("click", (e) => {
  if (!e.isTrusted || performance.now() - capturedAt < 600) return; // a Space or Enter just captured is not a new click
  if (capturing) return stopCapture();
  startCapture();
});
keyBtn.addEventListener("keydown", (e) => {
  if (!capturing || !e.isTrusted) return;
  if (e.key === "Tab") return stopCapture(); // focus moves on as usual
  e.preventDefault();
  if (e.key === "Escape") return stopCapture();
  const binding = keyToBinding(e);
  if (!binding) {
    if (!["Control", "Shift", "Alt", "Meta"].includes(e.key)) text("approve-key-line", "Familiar can't check that key. Try an F-key, or Ctrl/Shift with a key.");
    return; // a modifier on its own: wait for the key
  }
  capturing = false;
  capturedAt = performance.now();
  keyBtn.setAttribute("aria-pressed", "false");
  setUi(keyBtn, { approveKey: binding }, `Approve key set to ${binding}`);
});
keyBtn.addEventListener("blur", () => { if (capturing) stopCapture(); });
btn("b-key-clear", "Approve key cleared", () => bridge.invoke("uiSettings", { approveKey: "" }).then(renderUi).then(refreshStatus));

// ---- Projects -------------------------------------------------------------------------------------------------
// Folders added by hand, folders of projects, and how many Familiar finds in the agents' history.
interface ProjectsStatus { explicit: string[]; roots: string[]; history: number }
const projectsOf = (v: any): ProjectsStatus | null =>
  v && typeof v === "object" && Array.isArray(v.explicit) && Array.isArray(v.roots) && v.explicit.every((p: unknown) => typeof p === "string") && v.roots.every((p: unknown) => typeof p === "string")
    ? { explicit: v.explicit, roots: v.roots, history: Number.isFinite(v.history) ? v.history : 0 } : null;
let projectsShown = false;
function renderProjects(value: unknown) {
  const p = projectsOf(value);
  $("projects").hidden = !p; // an older main process has no folder commands (and reports a plain count)
  if (!p) return;
  const none = !p.explicit.length && !p.roots.length;
  const n = p.explicit.length + p.roots.length;
  text("project-count", n ? `${n} folder${n === 1 ? "" : "s"}` : "none yet");
  // Open the first time only when there is no folder yet; after that it stays as the player leaves it.
  if (!projectsShown) { projectsShown = true; ($("projects") as HTMLDetailsElement).open = none; }
  text("project-lead", none ? "Give me a folder and I'll have somewhere to go. " : "");
  text("project-history", p.history > 0 ? ` Found from your agents so far: ${p.history}.` : "");
  const row = (label: string, path: string) => `<div class="prov"><span class="g" aria-hidden="true">▪</span><span class="n">${label}</span><span class="d">${esc(path)}</span><span class="a"><button class="small" type="button" data-remove="${esc(path)}" aria-label="Remove ${esc(path)}">✕</button></span></div>`;
  setHtml($("project-rows"), [...p.explicit.map((x) => row("Project", x)), ...p.roots.map((x) => row("Projects in", x))].join(""), ["remove"]);
}
// Replace a list's markup only when it changed, and give keyboard focus back to the same control afterwards:
// a status tick may update a row while someone is using it with the keyboard.
function setHtml(el: HTMLElement, html: string, focusKeys: string[]) {
  if (el.dataset.html === html) return;
  const active = el.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusKey = active && focusKeys.find(key => active.dataset[key]);
  const focusId = focusKey ? active!.dataset[focusKey] : undefined;
  el.dataset.html = html;
  el.innerHTML = html;
  if (focusKey) [...el.querySelectorAll<HTMLElement>(`[data-${focusKey}]`)].find(node => node.dataset[focusKey] === focusId)?.focus();
}
async function addFolder(kind: "project" | "root") {
  const buttons = [$("b-project-add"), $("b-root-add")] as HTMLButtonElement[];
  let added = "";
  buttons.forEach((b) => (b.disabled = true)); // one folder dialog at a time
  await act($("b-project-add"), () => (added ? `Added ${added}. It is offered the next time you pick a project.` : ""), async () => { // a cancelled dialog says nothing
    const r = await bridge.invoke("projectAdd", { kind });
    if (r?.ok) { added = typeof r.path === "string" && r.path ? r.path : "the folder"; await refreshStatus(); }
    else if (typeof r?.why === "string" && r.why) throw new Error(r.why);
  });
  buttons.forEach((b) => (b.disabled = false));
}
$("b-project-add").addEventListener("click", () => addFolder("project"));
$("b-root-add").addEventListener("click", () => addFolder("root"));
$("project-rows").addEventListener("click", (e) => {
  const path = (e.target as HTMLElement).closest<HTMLElement>("[data-remove]")?.dataset.remove;
  if (path) act($("b-project-add"), `Removed ${path}`, async () => {
    const r = await bridge.invoke("projectRemove", { path });
    await refreshStatus();
    if (!r?.ok) throw new Error("that folder was not in your list any more");
  });
});

// ---- Footer ---------------------------------------------------------------------------------------------------
// Check for updates: one request to GitHub, only on this click (never scheduled). The download page opens only on a
// second, explicit click. The same answer comes back as status.update.last, so this redraws only when it changed.
function showUpdate(result: unknown) {
  const el = $("update-result");
  const key = JSON.stringify(result ?? null);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const line = updateLine(result as any);
  el.className = `hint ${line.level === "muted" ? "" : line.level}`;
  const lead = document.createElement(line.open ? "b" : "span");
  lead.textContent = line.text;
  el.replaceChildren(lead);
  if (!line.open) return;
  const open = document.createElement("button");
  open.type = "button";
  open.id = "b-open-release";
  open.className = "linklike";
  open.textContent = "Open the download page";
  open.addEventListener("click", (e) => { if (e.isTrusted) act(open, "Download page opened in your browser", () => bridge.invoke("openUrl", { url: line.open })); });
  el.append(" · ", open);
}
btn("b-update", () => "", async () => { showUpdate(await bridge.invoke("checkUpdate")); }); // the result line is the answer
$("c-login").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  act(e.target as Element, on ? "Familiar starts with Windows" : "Familiar no longer starts with Windows", () => bridge.invoke("launchAtLogin", on));
});
btn("b-suggest", "Opened a pre-filled GitHub issue in your browser. Nothing is sent until you submit it there.", () =>
  bridge.invoke("suggest", ($("suggest-text") as HTMLTextAreaElement).value));

bridge.on("status", render);
bridge.on("log", addLog);
bridge.invoke("status").then(render);
bridge.invoke("logs").then((lines: string[]) => lines.forEach(addLog));

export {};

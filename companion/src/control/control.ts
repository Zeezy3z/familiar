// Desktop control panel: three setup steps, the essentials, "Requests waiting" (every pending approval), the
// Projects card, and one Advanced section. Text that came from an agent, the game or the network is only ever
// set with textContent (or esc() inside a template), never as markup.
import { approveKeyStatus, claudeLine, journey } from "./journey";
import { buildPresentation, restartGuidance, updateLine, versionMismatch } from "./build";
import type { ControlBridge } from "../shared/bridge";
const bridge = window.familiar as ControlBridge;

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const kv = (rows: [string, unknown, string?][]) => rows.map(([k, v, cls]) => `<div>${esc(k)}</div><div class="${cls ?? ""}">${esc(v)}</div>`).join("");
const text = (id: string, value: string) => { if ($(id).textContent !== value) $(id).textContent = value; };
const feedback = (message: string, level: "ok" | "warn" | "err") => { $("feedback").textContent = message; $("feedback").className = `wide ${level}`; };

let paused = false;

function render(s: any) {
  paused = !!s.overlay?.paused;
  $("b-pause").textContent = paused ? "Resume overlay" : "Pause overlay";
  const j = journey(s);
  text("journey-title", j.title);
  $("journey-title").className = j.level;
  text("journey-text", j.text);
  $("journey-steps").innerHTML = j.steps.map((step, i) => `<li${i === j.current ? ' class="cur" aria-current="step"' : ""}><b class="${step.done ? "ok" : ""}">${i + 1} ${esc(step.label)}${step.done ? " ✓" : ""}</b><span class="hint${step.level === "warn" ? " warn" : ""}">${esc(step.text)}</span></li>`).join("");
  const next = $("journey-action") as HTMLAnchorElement;
  next.hidden = !j.action;
  next.dataset.action = j.action ?? "";
  next.href = j.action === "providers" ? "#familiars" : "#";
  next.textContent = j.action === "pause" ? "Resume overlay" : j.action === "config" ? "Open config" : "Review familiars";
  if (s.storage) {
    text("journey-title", "Saved quests need attention");
    $("journey-title").className = s.storage.level === "error" ? "err" : "warn";
    text("journey-text", s.storage.text);
    next.hidden = true;
  }
  // The first undone step's content sits under the strip: the Familiars card for step 1 (and while the first-run
  // choice is still open), the journey text itself for steps 2 and 3. Everything done: one line.
  $("all-set").hidden = !(j.current === -1 && j.level === "ok" && !s.storage);
  const familiarsInStep = j.current === 0 || !s.providersChosen;
  if (familiarsInStep && j.action === "providers") next.hidden = true; // the card is already right below
  placeFamiliars(familiarsInStep);
  $("ver").textContent = `v${s.version}`;
  const mismatch = versionMismatch(s.version, s.addon?.addon);
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
  $("linkbadge").innerHTML = s.linked ? '<span class="ok">● linked</span>' : '<span class="muted">○ not linked</span>';
  const c = s.capture ?? {};
  $("link").innerHTML = kv([
    ["Status", s.linked ? "Linked" : s.game ? "Searching for the game link…" : "Waiting for WoW", s.linked ? "ok" : "warn"],
    ...(typeof s.doctor?.text === "string" && s.doctor.text ? [["Link doctor", s.doctor.text, s.doctor.level === "ok" ? "ok" : s.doctor.level === "warn" ? "warn" : "muted"] as [string, unknown, string]] : []),
    ["Capture", c.fps ? `${c.fps} fps · ${c.frameW}×${c.frameH}` : "—"],
    ["Frames", `${c.decoded ?? 0} decoded · ${c.crc ?? 0} crc · ${c.missed ?? 0} missed`],
    ["Messages", `${c.msgs ?? 0} received${s.lastMsgAgo != null ? ` · last ${Math.round(s.lastMsgAgo / 1000)}s ago` : ""}`],
    ["Lock", c.lock ? `${c.lock.x.toFixed(1)}, ${c.lock.y.toFixed(1)} · ${c.lock.pitch.toFixed(2)}px cells` : "—"],
    ["Overlay", paused ? "paused" : s.overlay?.shown ? "showing" : "hidden"],
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
  const b = s.backends ?? {};
  const be = (x: any) =>
    x?.ready ? `ready${x.account ? " · " + x.account : ""}` : x?.error ? `unavailable — ${x.error}` : "starts when World of Warcraft is running";
  $("agents").innerHTML = kv([
    ...Object.entries<any>(b)
      .filter(([id]) => (s.providers ?? []).find((p: any) => p.id === id)?.enabled !== false)
      .map(([id, x]): [string, unknown, string] => [x?.label ?? (s.providers ?? []).find((p: any) => p.id === id)?.label ?? id, be(x), x?.ready ? "ok" : x?.error ? "err" : ""]),
    ["Quests", s.threads],
    ...(typeof s.projects === "number" ? [["Zones", s.projects] as [string, unknown]] : []), // newer builds list them on the Projects card
  ]);
  const a = s.addon ?? {};
  $("addon").innerHTML = kv([
    ["Character", a.char ? `${a.char} — ${a.realm}` : "— (no hello yet)"],
    ["Client", a.build ? `${a.build} (interface ${a.iface})` : "—"],
    ["Addon", a.addon ?? "—"],
    ["Panel", s.layout ? (s.layout.panel ? "open" : "closed") : "—"],
  ]);
  ($("c-login") as HTMLInputElement).checked = !!s.launchAtLogin;
  renderUi(s.ui);
  renderRequests(s.requests, s.providers ?? []);
  renderProjects(s.projects);
  renderProviders(s.providers ?? [], s.backends ?? {}, s.claude);
  renderChat(s);
  ($("onboard") as HTMLElement).hidden = !!s.providersChosen;
  $("notes").innerHTML = (s.installNotes ?? []).map((n: string) => `<li>${esc(n)}</li>`).join("");
}

// Moving a card drops focus from anything inside it; put it back (a no-op while Advanced is closed).
function moveCard(card: HTMLElement, target: Element, put: () => void) {
  if (card.parentElement === target) return;
  const active = card.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  put();
  active?.focus();
}
// The Familiars card lives under the step strip while step 1 needs it, and in Advanced afterwards.
function placeFamiliars(inStep: boolean) {
  const target = $(inStep ? "step-slot" : "adv-familiars");
  moveCard($("familiars"), target, () => target.append($("familiars")));
}
// The Projects card sits above the essentials until a folder has been added, then moves into Advanced.
function placeProjects(onTop: boolean) {
  const target = onTop ? $("essentials").parentElement! : $("adv-projects");
  moveCard($("projects"), target, () => (onTop ? $("essentials").before($("projects")) : target.append($("projects"))));
}

// Requests waiting: every pending approval, with the whole text before the buttons (status.requests[] and the
// "decide" command are the hub lane's). A request the game card shows only in part is marked. Only a real click
// or key press decides.
interface PanelRequest { thread: string; questTitle: string; project: string; agent: string; requestId: string; title: string; detail?: string; full?: string; cut?: boolean; canAlways: boolean; at: number }
const DECISIONS: [decision: string, label: string, done: string][] = [["allow", "Approve", "Approved"], ["deny", "Deny", "Denied"], ["allowAlways", "Always (this quest)", "Approved for this quest"]];
const SETTLE_MS = 800; // a row that just appeared ignores clicks briefly, so a layout shift cannot land one on it
const requestRows = new Map<string, HTMLElement>();
let requestSeq = 0;
// The whole text: `full` when the game card cuts it, the card's own text otherwise. A cut request with no `full` is not listed.
const requestText = (r: PanelRequest) => (r.cut === true ? r.full : r.full ?? r.detail);
const validRequest = (r: any): r is PanelRequest => !!r && typeof r.thread === "string" && typeof r.requestId === "string" && typeof requestText(r) === "string";

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
  const btns = make("div", "btns");
  for (const [decision, label] of DECISIONS) {
    const b = make("button", decision === "allowAlways" ? "always" : "", { type: "button", "data-decide": decision, "aria-describedby": `${id}-title` }) as HTMLButtonElement;
    b.textContent = label;
    b.disabled = true;
    btns.append(b);
  }
  setTimeout(() => { if (!row.dataset.sent) btns.querySelectorAll("button").forEach((b) => (b.disabled = false)); }, SETTLE_MS);
  const head = make("div", "req-head");
  const badge = make("span", "badge", { hidden: "" });
  badge.textContent = "Too long for the in-game card";
  head.append(make("h3", "req-title", { id: `${id}-title` }), badge);
  // The whole text comes first; the buttons follow it.
  row.append(head, make("p", "hint req-meta"), make("pre", "req-full", { id: `${id}-full`, tabindex: "0", "aria-label": "The full request" }), btns, make("p", "req-msg", { role: "status" }));
  return row;
}

function renderRequests(list: unknown, providers: any[]) {
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
    const agent = providers.find((p) => p.id === r.agent)?.label ?? r.agent;
    const since = Number.isFinite(r.at) ? ` · waiting since ${new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    const set = (sel: string, value: string) => { const el = row!.querySelector(sel)!; if (el.textContent !== value) el.textContent = value; };
    set(".req-title", r.title || "Request");
    set(".req-meta", [agent, r.project, r.questTitle].filter(Boolean).join(" · ") + since);
    set(".req-full", requestText(r)!); // left alone while unchanged, so a reader's scroll position stays put
    row.dataset.cut = r.cut === true ? "1" : "";
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
  const done = DECISIONS.find(([d]) => d === button.dataset.decide)?.[2] ?? "Answered";
  const title = row.querySelector(".req-title")!.textContent;
  const msg = row.querySelector(".req-msg")!;
  const buttons = row.querySelectorAll<HTMLButtonElement>("button");
  row.dataset.sent = "1";
  buttons.forEach((b) => (b.disabled = true));
  let answer: { ok?: boolean; why?: string } | undefined;
  let failure = "";
  try { answer = await bridge.invoke("decide", { thread: row.dataset.thread, requestId: row.dataset.request, decision: button.dataset.decide }); }
  catch (err) { failure = err instanceof Error ? err.message : String(err); }
  if (answer?.ok === true) {
    msg.textContent = `${done}.`;
    msg.className = "req-msg ok";
    feedback(`${done}: ${title}`, "ok");
  } else {
    delete row.dataset.sent;
    buttons.forEach((b) => (b.disabled = false));
    const gone = answer?.why === "no longer pending";
    const reason = failure ? `Could not send that answer: ${failure}`
      : gone ? "Already answered."
      : answer?.why === "fresh" ? "This request just appeared. Read it, then click again."
      : `Not applied${answer?.why ? `: ${answer.why}` : ""}.`;
    msg.textContent = reason;
    msg.className = `req-msg ${gone ? "warn" : "err"}`;
    feedback(reason, gone ? "warn" : "err");
  }
  await refreshStatus().catch(() => {});
});

// One row per agent: installed? signed in? used in Familiar? — plus Install / Sign in buttons.
function renderProviders(list: any[], backends: Record<string, any>, claude?: unknown) {
  const html = list
    .map((p) => {
      const be = backends[p.id];
      const dl = p.id === "claude" ? claudeLine(claude as any) : null; // the in-app Claude Code download, until it is on disk
      const state = dl ? `<span class="${dl.level}">${esc(dl.text)}</span>${dl.state === "downloading" ? `<progress aria-label="Claude Code download"${dl.pct != null ? ` max="100" value="${dl.pct}"` : ""}></progress>` : ""}`
        : !p.installed
        ? `<span class="muted">${esc(p.detail)}</span>${p.installCommand ? ` — <code>${esc(p.installCommand)}</code>` : ""}`
        : `<span class="${p.signedIn === false ? "warn" : "ok"}">${esc(p.detail)}</span>${be?.error && p.enabled ? ` <span class="err">· ${esc(be.error)}</span>` : ""}`;
      const actions = [
        dl?.retry ? `<button class="small" data-retry="claude">${esc(dl.retry)}</button>` : "",
        !p.installed && p.installUrl ? `<button class="small" data-install="${esc(p.id)}">Install…</button>` : "",
        p.installed && p.canLogin ? `<button class="small" data-login="${esc(p.id)}">${p.signedIn ? "Sign in again" : "Sign in"}</button>` : "",
        `<label class="hint"><input type="checkbox" data-enable="${esc(p.id)}" aria-label="Use ${esc(p.label)} in Familiar" ${p.enabled ? "checked" : ""} ${p.installed ? "" : "disabled"}> Use</label>`,
      ].join("");
      return `<div class="prov ${p.enabled ? "" : "off"}"><span class="g">${esc(p.glyph)}</span><span class="n">${esc(p.label)}</span><span class="d">${state}</span><span class="a">${actions}</span></div>`;
    })
    .join("");
  setHtml($("providers"), html, ["install", "login", "enable", "retry"]);
}

// Chat defaults: provider, model and effort (the in-game Model list changes them too).
function renderChat(s: any) {
  const chat = s.chat ?? {};
  const providers = (s.providers ?? []).filter((p: any) => p.id === "claude" || p.id === "codex");
  const agents = providers.filter((p: any) => p.enabled);
  const current = providers.find((p: any) => p.id === chat.agent);
  const label = current?.label ?? (s.providers ?? []).find((p: any) => p.id === chat.agent)?.label ?? chat.agent ?? "Selected provider";
  const fill = (id: string, opts: [string, string, boolean?][], cur: string) => {
    const el = $(id) as HTMLSelectElement;
    const html = opts.map(([v, l, disabled]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}${disabled ? " disabled" : ""}>${esc(l)}</option>`).join("");
    if (document.activeElement !== el && el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
    }
  };
  const choices: [string, string, boolean?][] = agents.map((p: any) => [p.id, p.label]);
  // A select otherwise displays its first remaining option, implying an unsaved provider change.
  if (!agents.some((p: any) => p.id === chat.agent)) choices.unshift([
    chat.agent ?? "", chat.agent ? `${label} (${current?.installed === false ? "not installed" : current?.enabled === false ? "switched off" : "unavailable"})` : "Choose a Chat provider", true,
  ]);
  fill("chat-agent", choices, chat.agent ?? "");
  let models: [string, string][] = ((s.backends ?? {})[chat.agent]?.models ?? []).filter((m: any) => m.id !== "default").map((m: any) => [m.id, m.label]);
  if (!models.some(([v]) => v === chat.model)) models = [[chat.model ?? "", chat.model || "No model selected"], ...models];
  fill("chat-model", models, chat.model ?? "");
  ($("chat-effort") as HTMLSelectElement).value = chat.effort ?? "medium";
  const backend = s.backends?.[chat.agent];
  const ready = current?.installed && current.enabled && backend?.ready;
  const status = !current ? `${label} is unavailable for Chat. Choose Claude or Codex here, or check setup above.`
    : !current.installed ? `${label} is not installed. Check setup above or choose another Chat provider.`
    : !current.enabled ? `${label} is switched off. Turn on Use above or choose another Chat provider.`
    : ready ? `${label} is ready for Chat.`
    : backend?.error ? `${label} is not ready: ${backend.error}. Check its setup above.`
    : current.signedIn === false ? `${label} needs sign-in. Use Sign in above, then check its status before sending.`
    : current.signedIn === true ? `${label} sign-in found; live readiness is not yet confirmed. Agents start with WoW.`
    : `${label} readiness is not yet verified. Check its status above before sending.`;
  text("chat-status", status);
  $("chat-status").className = `hint ${ready ? "ok" : "warn"}`;
}
for (const [id, key] of [["chat-agent", "agent"], ["chat-model", "model"], ["chat-effort", "effort"]])
  $(id).addEventListener("change", (e) =>
    act("Chat defaults updated", async () => { await bridge.invoke("chatSettings", { [key]: (e.target as HTMLSelectElement).value }); await refreshStatus(); }),
  );

$("providers").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset.install) act("Installation page opened", () => bridge.invoke("providerInstall", t.dataset.install));
  if (t.dataset.login) act("Sign-in window opened. Complete sign-in there; Familiar will check again.", () => bridge.invoke("providerLogin", t.dataset.login));
  if (t.dataset.retry) act("Claude Code is downloading. Progress is on the Familiars card.", async () => { await bridge.invoke("claudeRetry"); await refreshStatus(); });
});
$("providers").addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.enable) act("Familiar choices updated", async () => { await bridge.invoke("providerEnable", { id: t.dataset.enable, on: t.checked }); await refreshStatus(); });
});

function addLog(line: string) {
  const el = $("log");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.textContent += line + "\n";
  if (el.textContent!.length > 60000) el.textContent = el.textContent!.slice(-40000);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

bridge.on("status", render);
bridge.on("log", addLog);
bridge.invoke("status").then(render);
bridge.invoke("logs").then((lines: string[]) => lines.forEach(addLog));

const refreshStatus = () => bridge.invoke("status").then(render);
const actionFeedback = new WeakMap<HTMLElement, HTMLElement>();
function localFeedback(group: HTMLElement, message: string) {
  let el = actionFeedback.get(group);
  if (!el && message) {
    el = document.createElement("p");
    el.dataset.actionFeedback = "";
    el.className = "err";
    group.before(el);
    actionFeedback.set(group, el);
  }
  // The existing global status is the live announcement; this copy stays beside the action.
  if (el) el.textContent = message;
}
async function act(message: string | (() => string), fn: () => unknown, local?: { group: HTMLElement; label: string }) {
  if (local) localFeedback(local.group, "");
  try { await fn(); feedback(typeof message === "function" ? message() : message, "ok"); }
  catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    feedback(local ? `${local.label} failed: ${reason}` : `Could not complete that action: ${reason}`, "err");
    if (local) localFeedback(local.group, `${local.label}: ${reason}`);
    await refreshStatus().catch(() => {});
  }
}
const btn = (id: string, message: string | (() => string), fn: () => unknown) => $(id).addEventListener("click", async () => {
  const button = $(id) as HTMLButtonElement;
  const group = button.closest<HTMLElement>(".btns");
  const local = group ? { group, label: button.textContent?.trim() || id } : undefined;
  const focused = document.activeElement === button || (id === "b-pause" && document.activeElement === $("journey-action"));
  button.disabled = true;
  await act(message, fn, local);
  button.disabled = false;
  if (focused && (document.activeElement === button || document.activeElement === document.body || document.activeElement === $("journey-action"))) {
    if (button.offsetParent) button.focus();
    else if (!$("journey-action").hidden) $("journey-action").focus();
    else $("providers").querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
  }
});
btn("b-install", "Addon install checked. See the installation notes in Link details.", async () => { await bridge.invoke("install"); await refreshStatus(); });
btn("b-chosen", "Your familiar choices are saved", async () => { await bridge.invoke("providersChosen"); await refreshStatus(); });
btn("b-toast", "Overlay test requested. Look for the notice over WoW while the Glass is visible.", () => bridge.invoke("testToast"));
const openFile = async (cmd: string) => {
  const error = await bridge.invoke(cmd);
  // Electron shell.openPath resolves to an error string rather than rejecting.
  if (typeof error === "string" && error) throw new Error(error);
};
btn("b-config", "Config opened", () => openFile("openConfig"));
btn("b-reload", "Config reloaded", async () => { await bridge.invoke("reloadConfig"); await refreshStatus(); });
btn("b-logs", "Log file opened", () => openFile("openLogs"));
btn("b-diag", "Diagnostics copied to the clipboard (redacted). Review before posting.", () => bridge.invoke("diagnostics"));
btn("b-refresh", "Desktop conversations rescanned", async () => { await bridge.invoke("refresh"); await refreshStatus(); });
$("c-login").addEventListener("change", (e) => act("Windows startup preference updated", () => bridge.invoke("launchAtLogin", (e.target as HTMLInputElement).checked)));
$("journey-action").addEventListener("click", (e) => {
  const action = $("journey-action").dataset.action;
  if (action === "providers") {
    // The link jumps to #familiars; when the card is inside the closed Advanced section, open that first.
    const advanced = $("advanced") as HTMLDetailsElement;
    if (advanced.contains($("familiars"))) advanced.open = true;
    return;
  }
  e.preventDefault();
  $(action === "pause" ? "b-pause" : "b-config").click();
});

// In game: text size, sounds, notices as raid warnings.
const fontSel = $("ui-font") as HTMLSelectElement;
for (let p = 80; p <= 160; p += 10) fontSel.add(new Option(`${p}%${p === 100 ? " (default)" : ""}`, String(p / 100)));
// Display only: warn while the chosen default lets new quests act without asking.
const risky = (v: string) => v === "edits" || v === "auto";
let wasRisky = false;
function setModeWarn(v: string) {
  $("ui-mode-warn").hidden = !risky(v);
  // Open Advanced once when the default turns risky (the first render included), so the warning box is not
  // hidden; after that the player may close it again.
  if (risky(v) && !wasRisky) ($("advanced") as HTMLDetailsElement).open = true;
  wasRisky = risky(v);
  const b = $("modebadge");
  b.hidden = !risky(v);
  b.textContent = risky(v) ? `Default: ${v === "auto" ? "Auto" : "Accept edits"}` : "";
}
function renderUi(ui?: { fontScale: number; sound: boolean; raidWarnings: boolean; trayNotices?: boolean; quiet?: boolean; privateMode?: boolean; streamSafe?: boolean; defaultMode?: string; approveKey?: string }) {
  if (!ui) return;
  if (document.activeElement !== fontSel) fontSel.value = String(Math.round(ui.fontScale * 10) / 10);
  ($("ui-sound") as HTMLInputElement).checked = ui.sound;
  ($("ui-raid") as HTMLInputElement).checked = ui.raidWarnings;
  ($("ui-tray") as HTMLInputElement).checked = ui.trayNotices !== false; // on unless switched off
  ($("ui-quiet") as HTMLInputElement).checked = !!ui.quiet;
  ($("ui-private") as HTMLInputElement).checked = !!ui.privateMode;
  ($("ui-stream") as HTMLInputElement).checked = !!ui.streamSafe;
  if (ui.defaultMode) { ($("ui-mode") as HTMLSelectElement).value = ui.defaultMode; setModeWarn(ui.defaultMode); }
  const key = $("ui-approve-key") as HTMLInputElement;
  if (document.activeElement !== key) key.value = ui.approveKey ?? "";
  savedKey = ui.approveKey ?? "";
  showApproveKey();
}
// The live line under the Approve key field: what is registered, and a warning for keys used for playing.
let savedKey = "";
function showApproveKey() {
  const st = approveKeyStatus(savedKey, ($("ui-approve-key") as HTMLInputElement).value);
  text("approve-key-line", st.text);
  $("approve-key-line").className = st.level === "muted" ? "" : st.level;
  text("approve-key-warn", st.warning);
}
const setUi = (patch: object, message = "In-game display preferences updated") => act(message, () => bridge.invoke("uiSettings", patch).then(renderUi));
const modeNames: Record<string, string> = { ask: "Ask first", edits: "Accept edits", plan: "Plan only", auto: "Auto" };
fontSel.addEventListener("change", () => setUi({ fontScale: Number(fontSel.value) }));
$("ui-sound").addEventListener("change", (e) => setUi({ sound: (e.target as HTMLInputElement).checked }));
$("ui-quiet").addEventListener("change", (e) => setUi({ quiet: (e.target as HTMLInputElement).checked }));
$("ui-private").addEventListener("change", (e) => setUi({ privateMode: (e.target as HTMLInputElement).checked }));
$("ui-stream").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  setUi({ streamSafe: on }, on ? "Stream-safe on: names hidden and replies blurred on the Glass. Approval cards stay readable." : "Stream-safe off");
});
$("ui-mode").addEventListener("change", (e) => {
  const mode = (e.target as HTMLSelectElement).value;
  setModeWarn(mode);
  setUi({ defaultMode: mode }, `New quests will start in ${modeNames[mode] ?? mode}`);
});
$("ui-approve-key").addEventListener("input", showApproveKey);
$("ui-approve-key").addEventListener("change", (e) => setUi({ approveKey: (e.target as HTMLInputElement).value }));
$("ui-raid").addEventListener("change", (e) => setUi({ raidWarnings: (e.target as HTMLInputElement).checked }));
$("ui-tray").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  setUi({ trayNotices: on }, on ? "Windows notices on: you'll get one when a request is waiting and WoW isn't in front." : "Windows notices off");
});
btn("b-pause", "Overlay preference updated", async () => {
  paused = await bridge.invoke("pause", !paused);
  await refreshStatus();
});
// Projects: folders added by hand, folders of projects, and how many Familiar finds in the agents' history.
interface ProjectsStatus { explicit: string[]; roots: string[]; history: number }
const projectsOf = (v: any): ProjectsStatus | null =>
  v && typeof v === "object" && Array.isArray(v.explicit) && Array.isArray(v.roots) && v.explicit.every((p: unknown) => typeof p === "string") && v.roots.every((p: unknown) => typeof p === "string")
    ? { explicit: v.explicit, roots: v.roots, history: Number.isFinite(v.history) ? v.history : 0 } : null;
function renderProjects(value: unknown) {
  const p = projectsOf(value);
  $("projects").hidden = !p; // an older main process has no folder commands (and reports a plain count)
  if (!p) return;
  placeProjects(!p.explicit.length && !p.roots.length);
  text("project-history", p.history > 0 ? ` Found from your agents so far: ${p.history}.` : "");
  const row = (label: string, path: string) => `<div class="prov"><span class="g">▪</span><span class="n">${label}</span><span class="d">${esc(path)}</span><span class="a"><button class="small" type="button" data-remove="${esc(path)}" aria-label="Remove ${esc(path)}">✕</button></span></div>`;
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
  text("project-result", "");
  await act(() => (added ? `Added ${added}` : "No folder was added."), async () => {
    const r = await bridge.invoke("projectAdd", { kind });
    if (r?.ok) { added = typeof r.path === "string" && r.path ? r.path : "the folder"; await refreshStatus(); }
    else if (typeof r?.why === "string" && r.why) throw new Error(r.why);
    text("project-result", added ? `Added ${added}. It is offered the next time you pick a project.` : "No folder was added.");
  }, { group: $("b-project-add").closest<HTMLElement>(".btns")!, label: "Projects" });
  buttons.forEach((b) => (b.disabled = false));
}
$("b-project-add").addEventListener("click", () => addFolder("project"));
$("b-root-add").addEventListener("click", () => addFolder("root"));
$("project-rows").addEventListener("click", (e) => {
  const path = (e.target as HTMLElement).closest<HTMLElement>("[data-remove]")?.dataset.remove;
  if (path) act(`Removed ${path}`, async () => {
    const r = await bridge.invoke("projectRemove", { path });
    await refreshStatus();
    if (!r?.ok) throw new Error("that folder was not in your list any more");
  });
});

// Save what Familiar sees: a small crop of the strip corner, written by the companion; named here, never shown.
btn("b-snapshot", () => "", async () => { // the line under the button is the answer
  text("snapshot-result", "");
  const r = await bridge.invoke("captureSnapshot");
  if (!r?.ok) throw new Error(typeof r?.why === "string" && r.why ? r.why : "Familiar has no picture of the game to save yet");
  const name = typeof r.file === "string" ? r.file.split(/[\\/]/).pop() : "";
  text("snapshot-result", `Saved ${name || "a picture"} in your Familiar folder (%APPDATA%\\Familiar). It shows the top-left 320×32 pixels of the game window; look at it before attaching it to a bug report.`);
});

// Check for updates: one request to GitHub, only on this click. The download page opens only on a second, explicit click.
function showUpdate(result: unknown) {
  const line = updateLine(result as any);
  const el = $("update-result");
  el.className = `hint res ${line.level === "muted" ? "" : line.level}`;
  const lead = document.createElement(line.open ? "b" : "span");
  lead.textContent = line.text;
  el.replaceChildren(lead);
  if (!line.open) return;
  const open = document.createElement("button");
  open.type = "button";
  open.id = "b-open-release";
  open.className = "linklike";
  open.textContent = "Open the download page";
  open.addEventListener("click", (e) => { if (e.isTrusted) act("Download page opened in your browser", () => bridge.invoke("openUrl", { url: line.open })); });
  el.append(" · ", open);
}
btn("b-update", () => "", async () => { showUpdate(await bridge.invoke("checkUpdate")); }); // the result line is the answer

btn("b-suggest", "Opened a pre-filled GitHub issue in your browser. Nothing is sent until you submit it there.", () =>
  bridge.invoke("suggest", ($("suggest-text") as HTMLTextAreaElement).value));

export {};

// Desktop control panel: link health, game window, agents, addon install, logs.
import { journey } from "./journey";
import { buildPresentation, restartGuidance } from "./build";

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const kv = (rows: [string, unknown, string?][]) => rows.map(([k, v, cls]) => `<div>${esc(k)}</div><div class="${cls ?? ""}">${esc(v)}</div>`).join("");
const text = (id: string, value: string) => { if ($(id).textContent !== value) $(id).textContent = value; };

let paused = false;

function render(s: any) {
  paused = !!s.overlay?.paused;
  $("b-pause").textContent = paused ? "Resume overlay" : "Pause overlay";
  const j = journey(s);
  text("journey-title", j.title);
  $("journey-title").className = j.level;
  text("journey-text", j.text);
  $("journey-steps").innerHTML = j.steps.map((step, i) => `<li><b class="${step.done ? "ok" : ""}">${step.done ? "✓" : i + 1} ${esc(step.label)}</b><span class="hint">${esc(step.text)}</span></li>`).join("");
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
  $("ver").textContent = `v${s.version}`;
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
    ["Status", s.linked ? "Linked" : s.game ? "Searching for the Runestrip…" : "Waiting for WoW", s.linked ? "ok" : "warn"],
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
      .map(([id, x]): [string, unknown, string] => [x?.label ?? id, be(x), x?.ready ? "ok" : x?.error ? "err" : ""]),
    ["Quests", s.threads],
    ["Zones", s.projects],
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
  renderProviders(s.providers ?? [], s.backends ?? {});
  renderChat(s);
  ($("onboard") as HTMLElement).hidden = !!s.providersChosen;
  $("notes").innerHTML = (s.installNotes ?? []).map((n: string) => `<li>${esc(n)}</li>`).join("");
}

// One row per agent: installed? signed in? used in Familiar? — plus Install / Sign in buttons.
function renderProviders(list: any[], backends: Record<string, any>) {
  const html = list
    .map((p) => {
      const be = backends[p.id];
      const state = !p.installed
        ? `<span class="muted">${esc(p.detail)}</span>${p.installCommand ? ` — <code>${esc(p.installCommand)}</code>` : ""}`
        : `<span class="${p.signedIn === false ? "warn" : "ok"}">${esc(p.detail)}</span>${be?.error && p.enabled ? ` <span class="err">· ${esc(be.error)}</span>` : ""}`;
      const actions = [
        !p.installed && p.installUrl ? `<button class="small" data-install="${esc(p.id)}">Install…</button>` : "",
        p.installed && p.canLogin ? `<button class="small" data-login="${esc(p.id)}">${p.signedIn ? "Sign in again" : "Sign in"}</button>` : "",
        `<label class="hint"><input type="checkbox" data-enable="${esc(p.id)}" aria-label="Use ${esc(p.label)} in Familiar" ${p.enabled ? "checked" : ""} ${p.installed ? "" : "disabled"}> Use</label>`,
      ].join("");
      return `<div class="prov ${p.enabled ? "" : "off"}"><span class="g">${esc(p.glyph)}</span><span class="n">${esc(p.label)}</span><span class="d">${state}</span><span class="a">${actions}</span></div>`;
    })
    .join("");
  const el = $("providers");
  if (el.dataset.html !== html) {
    const active = el.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusKey = active && ["install", "login", "enable"].find(key => active.dataset[key]);
    const focusId = focusKey ? active!.dataset[focusKey] : undefined;
    el.dataset.html = html;
    el.innerHTML = html;
    // A status tick may update a row while someone is using it with the keyboard.
    if (focusKey) [...el.querySelectorAll<HTMLElement>(`[data-${focusKey}]`)].find(node => node.dataset[focusKey] === focusId)?.focus();
  }
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
    act("Chat defaults updated", async () => { await window.familiar.invoke("chatSettings", { [key]: (e.target as HTMLSelectElement).value }); await refreshStatus(); }),
  );

$("providers").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset.install) act("Installation page opened", () => window.familiar.invoke("providerInstall", t.dataset.install));
  if (t.dataset.login) act("Sign-in window opened. Complete sign-in there; Familiar will check again.", () => window.familiar.invoke("providerLogin", t.dataset.login));
});
$("providers").addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.enable) act("Familiar choices updated", async () => { await window.familiar.invoke("providerEnable", { id: t.dataset.enable, on: t.checked }); await refreshStatus(); });
});

function addLog(line: string) {
  const el = $("log");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.textContent += line + "\n";
  if (el.textContent!.length > 60000) el.textContent = el.textContent!.slice(-40000);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

window.familiar.on("status", render);
window.familiar.on("log", addLog);
window.familiar.invoke("status").then(render);
window.familiar.invoke("logs").then((lines: string[]) => lines.forEach(addLog));

const refreshStatus = () => window.familiar.invoke("status").then(render);
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
async function act(message: string, fn: () => unknown, local?: { group: HTMLElement; label: string }) {
  if (local) localFeedback(local.group, "");
  try { await fn(); $("feedback").textContent = message; $("feedback").className = "wide ok"; }
  catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    $("feedback").textContent = local ? `${local.label} failed: ${reason}` : `Could not complete that action: ${reason}`;
    $("feedback").className = "wide err";
    if (local) localFeedback(local.group, `${local.label}: ${reason}`);
    await refreshStatus().catch(() => {});
  }
}
const btn = (id: string, message: string, fn: () => unknown) => $(id).addEventListener("click", async () => {
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
btn("b-install", "Addon install checked. See the installation notes in Link details.", async () => { await window.familiar.invoke("install"); await refreshStatus(); });
btn("b-chosen", "Your familiar choices are saved", async () => { await window.familiar.invoke("providersChosen"); await refreshStatus(); });
btn("b-toast", "Overlay test requested. Look for the notice over WoW while the Glass is visible.", () => window.familiar.invoke("testToast"));
const openFile = async (cmd: string) => {
  const error = await window.familiar.invoke(cmd);
  // Electron shell.openPath resolves to an error string rather than rejecting.
  if (typeof error === "string" && error) throw new Error(error);
};
btn("b-config", "Config opened", () => openFile("openConfig"));
btn("b-reload", "Config reloaded", async () => { await window.familiar.invoke("reloadConfig"); await refreshStatus(); });
btn("b-logs", "Log file opened", () => openFile("openLogs"));
btn("b-diag", "Diagnostics copied to the clipboard (redacted). Review before posting.", () => window.familiar.invoke("diagnostics"));
btn("b-refresh", "Desktop conversations rescanned", async () => { await window.familiar.invoke("refresh"); await refreshStatus(); });
$("c-login").addEventListener("change", (e) => act("Windows startup preference updated", () => window.familiar.invoke("launchAtLogin", (e.target as HTMLInputElement).checked)));
$("journey-action").addEventListener("click", (e) => {
  const action = $("journey-action").dataset.action;
  if (action === "providers") return;
  e.preventDefault();
  $(action === "pause" ? "b-pause" : "b-config").click();
});

// In game: text size, sounds, notices as raid warnings.
const fontSel = $("ui-font") as HTMLSelectElement;
for (let p = 80; p <= 160; p += 10) fontSel.add(new Option(`${p}%${p === 100 ? " (default)" : ""}`, String(p / 100)));
function renderUi(ui?: { fontScale: number; sound: boolean; raidWarnings: boolean; quiet?: boolean; defaultMode?: string; approveKey?: string }) {
  if (!ui) return;
  if (document.activeElement !== fontSel) fontSel.value = String(Math.round(ui.fontScale * 10) / 10);
  ($("ui-sound") as HTMLInputElement).checked = ui.sound;
  ($("ui-raid") as HTMLInputElement).checked = ui.raidWarnings;
  ($("ui-quiet") as HTMLInputElement).checked = !!ui.quiet;
  if (ui.defaultMode) ($("ui-mode") as HTMLSelectElement).value = ui.defaultMode;
  const key = $("ui-approve-key") as HTMLInputElement;
  if (document.activeElement !== key) key.value = ui.approveKey ?? "";
}
const setUi = (patch: object) => act("In-game display preferences updated", () => window.familiar.invoke("uiSettings", patch).then(renderUi));
fontSel.addEventListener("change", () => setUi({ fontScale: Number(fontSel.value) }));
$("ui-sound").addEventListener("change", (e) => setUi({ sound: (e.target as HTMLInputElement).checked }));
$("ui-quiet").addEventListener("change", (e) => setUi({ quiet: (e.target as HTMLInputElement).checked }));
$("ui-mode").addEventListener("change", (e) => setUi({ defaultMode: (e.target as HTMLSelectElement).value }));
$("ui-approve-key").addEventListener("change", (e) => setUi({ approveKey: (e.target as HTMLInputElement).value }));
$("ui-raid").addEventListener("change", (e) => setUi({ raidWarnings: (e.target as HTMLInputElement).checked }));
btn("b-pause", "Overlay preference updated", async () => {
  paused = await window.familiar.invoke("pause", !paused);
  await refreshStatus();
});

export {};

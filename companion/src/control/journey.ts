// Presentation only: derive guidance from the existing status snapshot, never change settings.
import type { ProviderSetup } from "../agents/setup";
import { bindingToVk } from "../main/physical";

/** status.doctor: the Link Doctor's one line (main/doctor.ts). */
export interface DoctorStatus { step?: string; level?: string; text?: string }
/** status.claude: the in-app Claude Code download (agents/claude-download.ts). `pct` is 0-100, `mb` the whole download. */
export interface ClaudeStatus { state?: string; pct?: number; mb?: number; error?: string }
/** status.backends[id]: what a running backend reports. `ready` means the program started and answered; only
 * Codex's `account` comes from a real sign-in check ("signed out" when there is none). */
export interface BackendLine { ready?: boolean; error?: string; account?: string }

export interface JourneyStatus {
  linked?: boolean;
  install?: unknown;
  game?: { minimized?: boolean; foreground?: boolean } | null;
  layout?: { panel?: boolean; ui?: boolean } | null;
  overlay?: { paused?: boolean; shown?: boolean };
  capture?: { error?: string };
  providers?: ProviderSetup[];
  backends?: Record<string, BackendLine>;
  doctor?: DoctorStatus | null;
  claude?: ClaudeStatus | null;
  work?: { working?: number; approvals?: number } | null;
}

/** The Claude row of the Familiars card (and step 1) while Claude Code is not on disk; null once it is there. */
export function claudeLine(c?: ClaudeStatus | null): { state: "missing" | "downloading" | "failed"; level: "warn" | "muted"; text: string; pct?: number; retry: string } | null {
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);
  if (c?.state === "downloading") {
    const pct = num(c.pct) == null ? undefined : Math.min(100, num(c.pct)!);
    const mb = num(c.mb);
    const bits = [pct != null ? `${Math.round(pct)} %` : "", mb != null ? `${pct != null ? "of " : ""}${Math.round(mb)} MB` : ""].filter(Boolean).join(" ");
    return { state: "downloading", level: "muted", text: `Downloading Claude Code${bits ? ` · ${bits}` : "…"}`, pct, retry: "" };
  }
  if (c?.state === "failed") {
    const why = typeof c.error === "string" && c.error.trim() ? ` (${c.error.trim()})` : "";
    return { state: "failed", level: "warn", text: `Claude Code couldn't be downloaded${why}. Other agents still work.`, retry: "Retry" };
  }
  if (c?.state === "missing") return { state: "missing", level: "muted", text: "Claude Code isn't downloaded yet. Click Retry to download it (about 112 MB).", retry: "Retry" };
  return null;
}

/** Which painted portrait the header shows (dist/assets/<name>-192.png); `current` is journey().current. A request
 * waiting on the player outranks work in progress: the familiar is asking. */
export function portraitFor(s: JourneyStatus, current: number): "idle" | "working" | "puzzled" | "asking" {
  const count = (n: unknown) => (typeof n === "number" && n > 0 ? n : 0);
  if (current === 2) return "puzzled"; // the Link step is the one undone
  if (current === -1 && count(s.work?.approvals)) return "asking";
  if (claudeLine(s.claude)?.state === "downloading") return "working";
  if (current === -1 && count(s.work?.working)) return "working";
  return "idle";
}

const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function journey(s: JourneyStatus) {
  const enabled = (s.providers ?? []).filter(p => p.enabled && p.installed);
  const ready = enabled.some(p => s.backends?.[p.id]?.ready);
  const prepared = enabled.some(p => p.signedIn === true || s.backends?.[p.id]?.ready);
  const unknownSignIn = enabled.some(p => p.signedIn == null && !s.backends?.[p.id]?.error);
  const starters = enabled.filter(p => (p.id === "claude" || p.id === "codex") && s.backends?.[p.id]?.ready);
  const firstReady = enabled.find(p => s.backends?.[p.id]?.ready);
  // Claude and Codex have + buttons in the Quest Log; any other familiar starts a quest from the chat line.
  const startHint = !starters.length && firstReady ? `Start a quest with /fam ${firstReady.id} <message>.` : "";
  const readyLabels = enabled.filter(p => s.backends?.[p.id]?.ready).map(p => p.label).filter(Boolean);
  const readyText = `${readyLabels.length ? readyLabels.join(", ") : "An agent"} ready`;
  const signedLabels = enabled.filter(p => p.signedIn).map(p => p.label).filter(Boolean);
  const signInText = signedLabels.length ? `Sign-in found (${signedLabels.join(", ")}); agents start with WoW` : "Sign-in found; agents start with WoW";
  const download = claudeLine(s.claude);
  // The Link Doctor's sentence says why the link is not up; an ok-level line never overrides a link that is not.
  const doctorText = typeof s.doctor?.text === "string" && s.doctor.level !== "ok" ? s.doctor.text.trim() : "";
  const steps: { label: string; done: boolean; text: string; level?: "ok" | "warn" | "muted" }[] = [
    { label: "Agents", done: prepared || unknownSignIn, text: ready ? readyText : prepared ? signInText : unknownSignIn ? "Installed; sign-in is not yet verified" : download ? (download.state === "downloading" ? download.text : `Claude Code isn't downloaded; use ${download.retry} below`) : "Enable an agent and check its sign-in below" },
    { label: "WoW", done: !!s.game, text: s.game ? "Game window found" : "Use Windowed or Windowed (Fullscreen)" },
    { label: "Link", done: !!s.linked, ...(s.linked ? { text: "Game link working" }
      : doctorText ? { text: doctorText, level: s.doctor?.level === "warn" ? "warn" as const : "muted" as const }
      : { text: "Restart WoW, tick Familiar and Familiar Sync at character select (Load out of date AddOns), then press Enter and type /fam" }) },
  ];
  // The strip shows one short line per step; the whole sentence above is its tooltip. While the link is not up the
  // Link line only says so: the doctor's sentence (or the fixed wording) is the journey text, under the title.
  const hints = [
    ready ? `${readyLabels.length ? andList(readyLabels) : "An agent"} ready` : prepared ? "Sign-in found" : unknownSignIn ? "Sign-in not yet verified"
      : download ? (download.state !== "downloading" ? "Claude Code isn't downloaded" : download.pct != null ? `Downloading Claude Code · ${Math.round(download.pct)} %` : "Downloading Claude Code")
      : enabled.length ? "Not signed in yet" : "No familiar chosen yet",
    s.game ? "Game window found" : "Not found yet",
    s.linked ? "Game link working" : "Not linked yet",
  ];
  // The panel's one status line: "All set" or the single thing in the way, with its action. The step strip shows
  // while setup is incomplete (current: the first undone step; -1 when all three are done).
  const current = steps.findIndex(step => !step.done);
  const guide = (title: string, text: string, level: "ok" | "warn" | "muted", action?: "providers" | "config" | "pause", textLevel?: "warn" | "muted") =>
    ({ title, text, level, action, steps, hints, current, ...(textLevel ? { textLevel } : {}) });
  if (s.overlay?.paused) return guide("The Glass is paused", "Resume it to see live replies again. Your quests are kept.", "warn", "pause");
  if (!enabled.length && download?.state === "downloading") return guide("Downloading Claude Code", "This happens once and takes a few minutes. Progress is under Familiars.", "muted");
  if (!enabled.length && download) return guide(download.state === "failed" ? "Claude Code couldn't be downloaded" : "Claude Code isn't downloaded yet", `Use ${download.retry} under Familiars. Codex and other agents do not need it.`, "warn", "providers");
  if (!enabled.length) return guide("Choose your familiar", "Turn on an installed agent under Familiars. You can add more whenever you like.", "warn", "providers");
  if (!prepared && !ready && !unknownSignIn) return guide("Check your familiar’s sign-in", "Use Sign in under Familiars, or complete setup in the agent’s own tool. A saved sign-in is checked again when the agent starts.", "warn", "providers");
  if (!s.install && !s.linked) return guide("Familiar couldn't find World of Warcraft", "Start WoW: Forever once so Familiar can see its folder, then choose Reinstall addon under Troubleshooting. If it still isn't found, Open config and set wowRoot and wowFlavor to _forever_.", "warn", "config");
  if (!s.game) return guide("I'm waiting for WoW.", "Open WoW in Windowed or Windowed (Fullscreen). Familiar stays in the tray while you’re away; agents start when WoW opens.", "muted");
  // WoW minimized or in the background is normal while this window is open: it is not a step in the way.
  if (s.capture?.error) return guide("The Runestrip needs attention", "Capture reported an error. Check Troubleshooting, keep WoW visible, and make sure its coloured strip is uncovered.", "warn");
  if (!s.linked) return doctorText
    ? guide("I can't see the game yet.", doctorText, "warn", undefined, s.doctor?.level === "warn" ? "warn" : "muted")
    : guide("I can't see the game yet.", "The coloured dots top-left are how Familiar talks to your PC. Enable Familiar in AddOns and type /fam. Restart WoW once after first installation. If the dots are covered, /fam strip tr moves them to the top-right.", "warn");
  if (!ready) return guide("Linked; waiting for a familiar", "The game link is working. Check the status under Familiars before sending a message.", "warn", "providers");
  if (s.layout?.ui === false) return guide("Your game UI is hidden", "Show the game UI again (Alt+Z) to read Familiar’s live replies.", "muted");
  return guide("All set — type /fam in WoW", startHint, "ok");
}

/** The words for "Always" on a request, here and on the Glass: Claude and Codex keep the grant for the rest of
 * this quest; other agents decide its scope themselves. `done` is what the panel says after the click. `agent` is
 * an id ("claude") or, from status.requests[], the label the hub names it by ("Claude"). */
export function alwaysLabel(agent: unknown): { label: string; done: string } {
  const id = typeof agent === "string" ? agent.toLowerCase() : "";
  return id === "claude" || id === "codex"
    ? { label: "Always (this quest)", done: "Approved for the rest of this quest" }
    : { label: "Always (agent decides how long)", done: "Approved; the agent decides how long it lasts" };
}

/** One status per Familiars row. `ready` only says the program started and answered (an ACP agent such as Grok
 * is "ready" after its handshake, agents/acp.ts connect()); it never checks a sign-in. The sign-in check
 * (agents/setup.ts: the agent's own sign-in file or API key) is the signal about signing in, and Codex's account
 * answer ("signed out") overrides it. So a missing sign-in wins over "ready", and Sign in shows only then. */
export interface FamiliarStatus { level: "ok" | "warn" | "err" | "muted"; text: string; signIn: boolean; retry: string; install: boolean; downloading: boolean; pct?: number }
export function familiarStatus(p: ProviderSetup, be?: BackendLine | null, claude?: ClaudeStatus | null): FamiliarStatus {
  const base = { signIn: false, retry: "", install: false, downloading: false };
  const dl = p.id === "claude" ? claudeLine(claude) : null; // the in-app Claude Code download, until it is on disk
  if (dl) return { ...base, level: dl.level, text: `${dl.state === "failed" ? "!" : "◌"} ${dl.text}`, retry: dl.retry, downloading: dl.state === "downloading", ...(dl.pct != null ? { pct: dl.pct } : {}) };
  if (!p.installed) return { ...base, level: "muted", text: `◌ ${p.detail || "Not installed"}`, install: !!p.installUrl };
  if (!p.enabled) return { ...base, level: "muted", text: "◌ Off" };
  if (be?.error) return { ...base, level: "err", text: `✗ Can't start: ${be.error}`, signIn: p.canLogin };
  const how = /^Not signed in · (.+)$/.exec(p.detail ?? "")?.[1];
  if (p.signedIn === false || be?.account === "signed out") return { ...base, level: "warn", text: `! Not signed in${how ? ` · ${how}` : ""}`, signIn: p.canLogin };
  if (be?.ready) {
    const account = typeof be.account === "string" && be.account && be.account !== "unknown" && be.account !== p.label ? ` · ${be.account}` : "";
    return { ...base, level: "ok", text: `✓ Ready${account}` };
  }
  if (p.signedIn === true) return { ...base, level: "muted", text: "◌ Signed in · starts when WoW is running" };
  return { ...base, level: "muted", text: "◌ Starts when WoW is running; sign-in is checked then" };
}

/** Privacy is one control with three levels over two saved settings (privateMode, and blurTranscript reported as
 * streamSafe = privateMode && blurTranscript). Main reports the level as ui.privacy and takes it back as
 * uiSettings { privacy } in one write; privacyLevel reads it from the two flags when ui.privacy is missing. */
export type PrivacyLevel = "off" | "names" | "blur";
export const PRIVACY: Record<PrivacyLevel, { label: string; hint: string; done: string }> = {
  off: { label: "Off", hint: "Zone and quest names show on the Glass.", done: "Privacy off: names show on the Glass" },
  names: { label: "Hide names", hint: "Zones and quests become Project 1 / Quest #1; notices are generic. Replies, approval cards and what you type stay readable.", done: "Names hidden on the Glass" },
  blur: { label: "Hide names and blur replies", hint: "Names hidden, and replies blurred until you click one. Approval cards are never blurred: you must see what you approve.", done: "Names hidden and replies blurred on the Glass" },
};
export function privacyLevel(ui?: { privacy?: unknown; privateMode?: boolean; streamSafe?: boolean } | null): PrivacyLevel {
  if (ui?.privacy === "off" || ui?.privacy === "names" || ui?.privacy === "blur") return ui.privacy;
  return ui?.streamSafe ? "blur" : ui?.privateMode ? "names" : "off";
}

const PLAYING = "That key is used for playing; pick an F-key or a Ctrl/Shift combination.";
// Bare letters, digits, Space and arrows are what WoW players press all game long.
const isPlayKey = (vk: number) => (vk >= 0x41 && vk <= 0x5a) || (vk >= 0x30 && vk <= 0x39) || vk === 0x20 || (vk >= 0x25 && vk <= 0x28);

/** The line under the Approve key. `saved` is what the companion registered; `byClick` is the opt-in "Approve by
 * mouse click". Warns (never refuses) about keys that are also used for playing. */
export function approveKeyStatus(saved: string, byClick = false): { level: "ok" | "warn" | "muted"; text: string; warning: string } {
  const registered = saved.trim().toUpperCase();
  const bind = bindingToVk(registered);
  const warning = bind && !bind.ctrl && !bind.shift && !bind.alt && isPlayKey(bind.vk) ? PLAYING : "";
  if (registered && bind) return { level: "ok", text: `Registered: ${registered} — Familiar checks the real keyboard for it`, warning };
  return byClick
    ? { level: "muted", text: "None set: approve by clicking the in-game card, or here", warning: "" }
    : { level: "warn", text: ONLY_HERE, warning: "" };
}
const ONLY_HERE = "No key set: requests can only be approved in this window until you set one.";

/** With no Approve key Familiar can check and click approval off, nothing in the game can approve: only this window. */
export function approveOnlyHere(ui?: { approveKey?: string; approveByClick?: boolean } | null): boolean {
  return !!ui && ui.approveByClick !== true && approveKeyStatus(ui.approveKey ?? "").level !== "ok";
}

/** The status line while requests wait and the game cannot approve them (approveOnlyHere): says so, with Set key. */
export function waitingOnlyHere(ui: { approveKey?: string; approveByClick?: boolean } | null | undefined, waiting: number) {
  if (waiting < 1 || !approveOnlyHere(ui)) return null;
  return { title: `${waiting === 1 ? "A request is" : `${waiting} requests are`} waiting above`, text: ONLY_HERE, level: "warn" as const, action: "key" as const };
}

// KeyboardEvent.code -> WoW binding names (the set main/physical.ts can check). Letters follow the keyboard
// layout (event.key), like Windows' virtual keys; punctuation is the US position, as physical.ts assumes.
const CODE_NAMES: Record<string, string> = {
  Space: "SPACE", Enter: "ENTER", NumpadEnter: "ENTER", Backspace: "BACKSPACE", Insert: "INSERT", Delete: "DELETE",
  Home: "HOME", End: "END", PageUp: "PAGEUP", PageDown: "PAGEDOWN", ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT",
  NumpadAdd: "NUMPADPLUS", NumpadSubtract: "NUMPADMINUS", NumpadMultiply: "NUMPADMULTIPLY", NumpadDivide: "NUMPADDIVIDE", NumpadDecimal: "NUMPADDECIMAL",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
};
/** The Approve key as pressed, in WoW's binding text ("F9", "CTRL-F9", "ALT-SHIFT-NUMPAD5"); null while only a
 * modifier is down, and for keys Familiar can't check (Escape and Tab stay free to cancel and move on). */
export function keyToBinding(e: { key?: string; code?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }): string | null {
  const code = e.code ?? "";
  const letter = typeof e.key === "string" && /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : /^Key([A-Z])$/.exec(code)?.[1];
  const key = CODE_NAMES[code] ?? (/^Key[A-Z]$/.test(code) ? letter : undefined) ?? /^Digit(\d)$/.exec(code)?.[1]
    ?? (/^Numpad\d$/.test(code) ? `NUMPAD${code.slice(6)}` : undefined) ?? (/^F([1-9]|1\d|2[0-4])$/.test(code) ? code : undefined);
  if (!key) return null;
  const text = `${e.altKey ? "ALT-" : ""}${e.ctrlKey ? "CTRL-" : ""}${e.shiftKey ? "SHIFT-" : ""}${key}`;
  return bindingToVk(text) ? text : null;
}

// Presentation only: derive guidance from the existing status snapshot, never change settings.
import type { ProviderSetup } from "../agents/setup";
import { bindingToVk } from "../main/physical";

/** status.doctor: the Link Doctor's one line (main/doctor.ts). */
export interface DoctorStatus { step?: string; level?: string; text?: string }
/** status.claude: the in-app Claude Code download (agents/claude-download.ts). `pct` is 0-100, `mb` the whole download. */
export interface ClaudeStatus { state?: string; pct?: number; mb?: number; error?: string }

export interface JourneyStatus {
  linked?: boolean;
  install?: unknown;
  game?: { minimized?: boolean; foreground?: boolean } | null;
  layout?: { panel?: boolean; ui?: boolean } | null;
  overlay?: { paused?: boolean; shown?: boolean };
  capture?: { error?: string };
  providers?: ProviderSetup[];
  backends?: Record<string, { ready?: boolean; error?: string }>;
  chat?: { agent?: string };
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
  const startHint = starters.length ? `Choose ${starters.map(p => `+ ${p.label}`).join(" / ")} and a project.` : firstReady ? `Use /fam ${firstReady.id} <message> to start a quest in the current zone.` : "";
  const readyLabels = enabled.filter(p => s.backends?.[p.id]?.ready).map(p => p.label).filter(Boolean);
  const readyText = `${readyLabels.length ? readyLabels.join(", ") : "An agent"} ready · change under Advanced`;
  const chatReady = enabled.some(p => p.id === s.chat?.agent && (p.id === "claude" || p.id === "codex") && s.backends?.[p.id]?.ready);
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
  // The panel shows content for the first undone step (-1: all three are done).
  const current = steps.findIndex(step => !step.done);
  const guide = (title: string, text: string, level: "ok" | "warn" | "muted", action?: "providers" | "config" | "pause", textLevel?: "warn" | "muted") =>
    ({ title, text, level, action, steps, hints, current, ...(textLevel ? { textLevel } : {}) });
  if (s.overlay?.paused) return guide("The Glass is paused", "Resume the overlay to see live replies again. Your conversations are kept.", "warn", "pause");
  if (!enabled.length && download?.state === "downloading") return guide("Downloading Claude Code", "This happens once and takes a few minutes. Progress is on the Familiars card below.", "muted");
  if (!enabled.length && download) return guide(download.state === "failed" ? "Claude Code couldn't be downloaded" : "Claude Code isn't downloaded yet", `Use ${download.retry} on the Familiars card below. Codex and other agents do not need it.`, "warn", "providers");
  if (!enabled.length) return guide("Choose your familiar", "Use an installed agent below. You can add more familiars whenever you like.", "warn", "providers");
  if (!prepared && !ready && !unknownSignIn) return guide("Check your familiar’s sign-in", "Use Sign in below, or complete setup in the agent’s own tool. A saved sign-in is checked again when the agent starts.", "warn", "providers");
  if (!s.install && !s.linked) return guide("Familiar couldn't find World of Warcraft", "Start WoW: Forever once so Familiar can see its folder, then choose Reinstall addon under Advanced → Link details. If it still isn't found, Open config and set wowRoot and wowFlavor to _forever_.", "warn", "config");
  if (!s.game) return guide("I'm waiting for WoW.", "Open WoW in Windowed or Windowed (Fullscreen). Familiar stays in the tray while you’re away; agents start when WoW opens.", "muted");
  if (s.game.minimized || s.game.foreground === false) return guide("Return to your WoW window", "The Glass waits while WoW is minimized or in the background. Return to the game when you’re ready.", "muted");
  if (s.capture?.error) return guide("The Runestrip needs attention", "Capture reported an error. Check Advanced → Link details, keep WoW visible, and make sure its coloured strip is uncovered.", "warn");
  if (!s.linked) return doctorText
    ? guide("I can't see the game yet.", doctorText, "warn", undefined, s.doctor?.level === "warn" ? "warn" : "muted")
    : guide("I can't see the game yet.", "The coloured dots top-left are how Familiar talks to your PC. Enable Familiar in AddOns and type /fam. Restart WoW once after first installation. If the dots are covered, /fam strip tr moves them to the top-right.", "warn");
  if (!ready) return guide("Linked; waiting for a familiar", "The game link is working. Check the agent status below before sending a message.", "warn", "providers");
  if (s.layout?.ui === false) return guide("Your game UI is hidden", "Show the game UI again when you want to read Familiar’s live replies.", "muted");
  if (!s.layout?.panel) return guide("Ready when you are.", `Type /fam or click the minimap owl to open your Quest Log. Pick an existing conversation to continue.${chatReady ? " Use + Chat for a quick question." : " " + startHint}`, "ok");
  return guide("Linked. Your next quest awaits.", `Pick a conversation to continue. ${startHint} Enter sends; Shift+Enter adds a line. Approvals appear in the conversation.`, "ok");
}

const PLAYING = "That key is used for playing; pick an F-key or a Ctrl/Shift combination.";
// Bare letters, digits, Space and arrows are what WoW players press all game long.
const isPlayKey = (vk: number) => (vk >= 0x41 && vk <= 0x5a) || (vk >= 0x30 && vk <= 0x39) || vk === 0x20 || (vk >= 0x25 && vk <= 0x28);

/** The live line under the Approve key field. `saved` is what the companion registered, `typed` is the field
 * as it stands. Warns (never refuses) about keys that are also used for playing. */
export function approveKeyStatus(saved: string, typed: string = saved): { level: "ok" | "warn" | "muted"; text: string; warning: string } {
  const registered = saved.trim().toUpperCase();
  const draft = typed.trim().toUpperCase();
  const bind = bindingToVk(draft);
  const warning = bind && !bind.ctrl && !bind.shift && !bind.alt && isPlayKey(bind.vk) ? PLAYING : "";
  if (draft && draft !== registered)
    return bind
      ? { level: "muted", text: "Not saved yet — press Enter or click away to register it.", warning }
      : { level: "warn", text: "That isn't a key Familiar can check. Use a name like F9 or CTRL-F9.", warning: "" };
  if (registered) return { level: "ok", text: `Registered: ${registered} — Familiar checks the real keyboard for it`, warning };
  return { level: "muted", text: "None registered — click the card or Approve button instead", warning: "" };
}

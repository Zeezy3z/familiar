import * as fs from "node:fs";
import * as path from "node:path";
import type { AcpProviderConfig } from "../agents/providers";
import type { AgentKind, Mode } from "../agents/types";

export interface Config {
  /** Folders whose immediate subfolders are offered as projects ("zones"). */
  projectRoots: string[];
  /** Extra explicit project folders. */
  projects: string[];
  /** Case-insensitive path fragments (substring match on the lower-cased path) that are never
   * listed, scanned or offered. Folders containing a `.nofamiliar` file are skipped as well. */
  exclude: string[];
  defaultMode: Mode;
  defaultAgent: AgentKind;
  /** WoW install root (contains _classic_beta_, _classic_era_, ...). */
  wowRoot: string;
  /** Client flavor folder; empty = auto-detect the most recently used. */
  wowFlavor: string;
  claudeExecutable?: string;
  claudeModel?: string;
  codexExe?: string;
  /** WoW binding text of "Approve the pending request" (e.g. "F9" or "CTRL-F9"), so an approval from that
   * keybind can be checked against the real keyboard. Unset: keybind approvals are refused. */
  approveKey?: string;
  /** Also approve by clicking Approve on the Glass. Off: only the Approve key approves in game.
   * A click is easier to bait than a key (something in the game can draw where you are about to
   * click), so this is opt-in. */
  approveByClick: boolean;
  /** Quests started from Familiar load your own agent configuration (allow rules, hooks, MCP
   * servers). Off: they start without it. */
  inheritAgentConfig: boolean;
  /** Show desktop-app threads touched within this many days (pinned/starred/running: always). */
  externalDays: number;
  /** Hide threads archived in the Claude/Codex desktop apps. */
  followDesktopArchive: boolean;
  /** Desktop threads listed per zone before a "+N more" row. */
  externalPerZone: number;
  /** Cues (synthesized in the Glass) when a quest starts, needs approval, is approved, completes,
   * a chat answers, or a turn fails. Off: nothing is sent to the Glass. */
  sound: boolean;
  /** Master volume of the cues, 0-100 (/fam sound 0-100, the panel's slider); see clampVolume. */
  soundVolume: number;
  /** Defer ordinary completion notifications until the player returns. Approvals/errors remain. */
  quiet: boolean;
  /** Streamer mode: the Glass, notices and the FamiliarSync snapshot show "Project n" / "Quest #n"
   * instead of real names and hide desktop threads. Pending approval cards still show the full
   * request. */
  privateMode: boolean;
  /** Stream-safe (with privateMode): replies, tool lines and objectives are blurred on the Glass
   * until clicked. Approval cards never are: you must see what you approve. */
  blurTranscript: boolean;
  /** "A Familiar Face" (the tutorial quest) has been offered once; afterwards only /fam tutorial
   * or the welcome page's link bring it back. */
  tutorialSeen: boolean;
  /** Overlay font scale multiplier (0.8 - 1.6). */
  fontScale: number;
  /** Notices (done, approval needed, failed, settings) big in the middle of the screen like raid
   * warnings; off: small, at the top of the Familiar window, only while it's open. */
  raidWarnings: boolean;
  /** A Windows notice (tray balloon) when a request is waiting and WoW isn't in front. Local only. */
  trayNotices: boolean;
  /** Start the companion (in the tray) when you sign in to Windows. */
  launchAtLogin: boolean;
  /** Agent Client Protocol agents by id (defaults: hermes, grok). Add any ACP agent here:
   * { "gemini": { "command": "gemini", "args": ["--experimental-acp"] } }; "enabled": false hides one. */
  providers?: Record<string, Partial<AcpProviderConfig>>;
  /** Chats (no repo, web search only): which agent, model and reasoning effort. */
  chatAgent: AgentKind;
  chatModel: string;
  chatEffort: string;
  /** Tool calls in transcripts: "compact" groups runs into one line, "full" lists each, "hidden". */
  toolDetail: "compact" | "full" | "hidden";
  /** List Hermes's messaging-gateway sessions (Telegram, Discord, Slack, ...) too. Off by default:
   * their transcripts can hold other people's messages. When on, their message text is read from
   * Hermes's local state.db like any other session. CLI, desktop and ACP sessions are always listed. */
  hermesBotSessions: boolean;
}

export const DEFAULT_CONFIG: Config = {
  // Empty by default: zones also come from Claude/Codex history, so existing CLI users still see
  // their projects. Add folders whose subfolders should be offered as zones.
  projectRoots: [],
  projects: [],
  // Generic noise only. Add your own folders to `exclude` in %APPDATA%\Familiar\config.json
  // (case-insensitive substring match against the lower-cased path plus a trailing "\"); these
  // defaults are always merged back in. A folder containing an empty `.nofamiliar` file is never
  // listed or offered either.
  exclude: ["\\node_modules", "\\.git\\", "\\appdata\\local\\temp", "\\$recycle.bin"],
  defaultMode: "ask",
  defaultAgent: "claude",
  approveByClick: false,
  inheritAgentConfig: false,
  wowRoot: "C:\\Program Files (x86)\\World of Warcraft",
  wowFlavor: "",
  externalDays: 21,
  followDesktopArchive: true,
  externalPerZone: 6,
  sound: true,
  soundVolume: 70,
  quiet: false,
  privateMode: false,
  blurTranscript: false,
  tutorialSeen: false,
  fontScale: 1,
  raidWarnings: true,
  trayNotices: true,
  launchAtLogin: false,
  toolDetail: "compact",
  // Haiku 5.5 at medium: answers general questions in seconds without searching, searches once
  // for game facts. Codex gpt-6-luna (low) is the faster alternative for search-heavy questions.
  chatAgent: "claude",
  chatModel: "haiku",
  chatEffort: "medium",
  hermesBotSessions: false,
};

const appDataPath = () => path.join(process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"), "Familiar");

export function appDataDir(): string {
  const dir = appDataPath();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write via a temp file and rename, so a crash mid-write never leaves a half-written file. */
export function writeFileAtomic(file: string, text: string, expected?: Buffer) {
  fs.writeFileSync(file + ".tmp", text, "utf8");
  if (expected) {
    // Recovery only: narrow the second-writer window immediately before replacing the source.
    // This is not multi-process locking or an atomic compare-and-swap.
    let same = false;
    try { same = fs.readFileSync(file).equals(expected); } catch { /* Missing/unreadable also conflicts. */ }
    if (!same) throw Object.assign(new Error("source changed before replacement"), { code: "ESTALE" });
  }
  fs.renameSync(file + ".tmp", file);
}

/** The saved config over the defaults, read-only: never creates, moves or rewrites config.json (for
 * readers outside main, such as agent catalogs). */
export function peekConfig(): Config {
  try {
    const user = JSON.parse(fs.readFileSync(path.join(appDataPath(), "config.json"), "utf8"));
    if (user && typeof user === "object" && !Array.isArray(user)) return withDefaults(user);
  } catch {
    /* missing or unreadable: defaults */
  }
  return { ...DEFAULT_CONFIG };
}

/** Settings earlier versions saved that nothing reads any more: dropped at the next save. */
const RETIRED = new Set(["speak", "autostartOffered"]);
/** Optional settings with no default, and the type each must have. */
const OPTIONAL: Record<string, string> = { claudeExecutable: "string", claudeModel: "string", codexExe: "string", approveKey: "string", providers: "object" };

/** The saved values over the defaults. A value of the wrong type (a hand edit, another version) is
 * left out, so the default holds: a "false" written as text can never switch on approveByClick.
 * Unknown keys are kept (a newer version may have written them). */
function withDefaults(user: Record<string, unknown>, log: (line: string) => void = () => {}): Config {
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const [k, v] of Object.entries(user)) {
    if (k === "__proto__" || RETIRED.has(k)) continue;
    const d = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[k];
    const want = Array.isArray(d) ? "list" : d !== undefined ? typeof d : OPTIONAL[k];
    const is = Array.isArray(v) ? (v.every((x) => typeof x === "string") ? "list" : "mixed list") : v === null ? "null" : typeof v;
    if (want && is !== want) log(`[config] ignored ${k} (${is}, expected ${want}); using the default`);
    else out[k] = v;
  }
  out.exclude = [...new Set([...DEFAULT_CONFIG.exclude, ...(out.exclude as string[])])];
  out.soundVolume = clampVolume(out.soundVolume) ?? DEFAULT_CONFIG.soundVolume;
  return out as unknown as Config;
}

/** The one rule for soundVolume: a finite number, rounded and kept in 0-100; anything else is
 * undefined (config load falls back to the default, /fam sound and the panel ignore it). */
export function clampVolume(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : undefined;
}

export function loadConfig(log: (line: string) => void = () => {}): Config {
  const p = path.join(appDataDir(), "config.json");
  let user: Record<string, unknown> = {};
  if (!fs.existsSync(p)) writeFileAtomic(p, JSON.stringify(DEFAULT_CONFIG, null, 2));
  else {
    try {
      user = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!user || typeof user !== "object" || Array.isArray(user)) throw new Error("not a JSON object");
    } catch (e: any) {
      // A typo in a hand edit must not cost every setting: keep the file for fixing, start from defaults.
      const aside = `${p}.bad-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.renameSync(p, aside);
      log(`[config] couldn't use config.json (${e?.message ?? e}); moved it to ${aside} and started from defaults`);
      user = {};
      writeFileAtomic(p, JSON.stringify(DEFAULT_CONFIG, null, 2));
    }
  }
  return withDefaults(user, log);
}

export function saveConfig(c: Config) {
  writeFileAtomic(path.join(appDataDir(), "config.json"), JSON.stringify(c, null, 2));
}

export function normPath(p: string): string {
  return path.resolve(p).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function isExcluded(p: string, c: Config): boolean {
  const n = normPath(p) + "\\";
  return c.exclude.some((frag) => n.includes(frag.toLowerCase()));
}

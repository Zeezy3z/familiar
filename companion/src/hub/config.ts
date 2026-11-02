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
  /** Show desktop-app threads touched within this many days (pinned/starred/running: always). */
  externalDays: number;
  /** Hide threads archived in the Claude/Codex desktop apps. */
  followDesktopArchive: boolean;
  /** Desktop threads listed per zone before a "+N more" row. */
  externalPerZone: number;
  /** Chimes when a quest finishes, needs approval or fails. */
  sound: boolean;
  speak: boolean;
  /** Defer ordinary completion notifications until the player returns. Approvals/errors remain. */
  quiet: boolean;
  /** Overlay font scale multiplier (0.8 - 1.6). */
  fontScale: number;
  /** Notices (done, approval needed, failed, settings) big in the middle of the screen like raid
   * warnings; off: small, at the top of the Familiar window, only while it's open. */
  raidWarnings: boolean;
  /** Start the companion (in the tray) when you sign in to Windows. */
  launchAtLogin: boolean;
  /** Launch-at-login has been switched on once by default (afterwards it's the user's choice). */
  autostartOffered: boolean;
  /** Agent Client Protocol agents by id (defaults: hermes, grok). Add any ACP agent here:
   * { "gemini": { "command": "gemini", "args": ["--experimental-acp"] } }; "enabled": false hides one. */
  providers?: Record<string, Partial<AcpProviderConfig>>;
  /** The user has reviewed which agents Familiar uses (control panel onboarding). */
  providersChosen: boolean;
  /** Chats (no repo, web search only): which agent, model and reasoning effort. */
  chatAgent: AgentKind;
  chatModel: string;
  chatEffort: string;
  /** Tool calls in transcripts: "compact" groups runs into one line, "full" lists each, "hidden". */
  toolDetail: "compact" | "full" | "hidden";
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
  wowRoot: "C:\\Program Files (x86)\\World of Warcraft",
  wowFlavor: "",
  externalDays: 21,
  followDesktopArchive: true,
  externalPerZone: 6,
  sound: true,
  speak: false,
  quiet: false,
  fontScale: 1,
  raidWarnings: true,
  launchAtLogin: false,
  autostartOffered: false,
  toolDetail: "compact",
  providersChosen: false,
  // Haiku 5.5 at medium: answers general questions in seconds without searching, searches once
  // for game facts. Codex gpt-6-luna (low) is the faster alternative for search-heavy questions.
  chatAgent: "claude",
  chatModel: "haiku",
  chatEffort: "medium",
};

export function appDataDir(): string {
  const dir = path.join(process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? ".", "AppData", "Roaming"), "Familiar");
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

export function loadConfig(log: (line: string) => void = () => {}): Config {
  const p = path.join(appDataDir(), "config.json");
  let user: Partial<Config> = {};
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
  return { ...DEFAULT_CONFIG, ...user, exclude: [...new Set([...(DEFAULT_CONFIG.exclude), ...(user.exclude ?? [])])] };
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

// Neither the release download (scripts/prebuilt.mjs, marked by .prebuilt) nor the installed app
// carries Anthropic code: the Claude Agent SDK and its Claude Code binary are downloaded on first
// run (fetch-claude.cjs, pinned versions, sha512-checked) into claudeHome(), by Run Familiar.cmd
// for the zip and by the companion itself (main.ts, downloadClaude below) for both. A clone gets
// them from npm ci. Until they are there, the Familiars card and a Claude quest say why in these
// words.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { redact } from "../main/log-file";

export const CLAUDE_NOT_DOWNLOADED = "Not downloaded yet — click Retry in Familiar's control panel to download Claude Code (about 112 MB)";

/** Where this companion runs from. `root`: the companion folder (dist/.. in the bundle, companion/
 * from source). `packaged`: the installed app (main sets it from app.isPackaged). Tests point both
 * at fixtures. */
export const companionDir = {
  root: path.basename(__dirname) === "dist" ? path.resolve(__dirname, "..") : path.resolve(__dirname, "..", ".."),
  packaged: false,
};

const SCOPE = ["node_modules", "@anthropic-ai"];
const SDK = "claude-agent-sdk";
const exeName = () => (process.platform === "win32" ? "claude.exe" : "claude");
const binaryDir = (home: string) => path.join(home, ...SCOPE, `${SDK}-${process.platform}-${process.arch}`);

/** How this companion got here: a git clone (npm ci installs Claude), the release zip, or the
 * installed app. Only the last two download Claude themselves. */
export function claudeRoute(): "clone" | "zip" | "installed" {
  if (companionDir.packaged) return "installed";
  return fs.existsSync(path.join(companionDir.root, ".prebuilt")) ? "zip" : "clone";
}

/** Where the Claude packages live (node_modules\@anthropic-ai\... below it): the companion folder
 * for a clone or the release download, %LOCALAPPDATA%\Familiar\claude for the installed app. */
export function claudeHome(): string {
  if (!companionDir.packaged) return companionDir.root;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "Familiar", "claude");
}

/** Both packages are in claudeHome(): the SDK and this PC's Claude Code binary. */
function claudePresent(): boolean {
  const home = claudeHome();
  return fs.existsSync(path.join(home, ...SCOPE, SDK, "package.json")) && fs.existsSync(path.join(binaryDir(home), exeName()));
}

/** The in-app download of Claude Code, as the control panel shows it. */
export interface ClaudeDownload {
  state: "present" | "missing" | "downloading" | "failed";
  /** downloading: percent of the current package. */
  pct?: number;
  /** downloading: size of the current package in MB. */
  mb?: number;
  /** failed: why, in words. */
  error?: string;
}

/** The running or failed download (undefined: none since the last success). */
let current: ClaudeDownload | undefined;
let running: Promise<ClaudeDownload> | undefined;

/** The download state. Packages already there win: a download that only updates them to newly
 * pinned versions (or failed to) leaves Claude usable meanwhile. */
export function claudeStatus(): ClaudeDownload {
  if (claudeRoute() === "clone" || claudePresent()) return { state: "present" };
  return current ? { ...current } : { state: "missing" };
}

/** The Familiars card's line and a Claude quest's error while Claude can't run (no final period:
 * the quest page continues the sentence). */
export function claudeDownloadText(s: ClaudeDownload): string {
  if (s.state === "downloading")
    return s.pct === undefined ? "Downloading Claude Code…" : `Downloading Claude Code · ${s.pct} %${s.mb ? ` of ${s.mb} MB` : ""}`;
  if (s.state === "failed")
    return `Claude Code couldn't be downloaded (${s.error ?? "unknown error"}). Codex and the other agents work; click Retry in Familiar's control panel`;
  return CLAUDE_NOT_DOWNLOADED;
}

/** Why Claude can't run yet (downloading, failed, not downloaded), else undefined. A clone never
 * downloads: npm ci installed the SDK and the SDK finds its own binary. */
export function claudeNotDownloaded(): string | undefined {
  const s = claudeStatus();
  return s.state === "present" ? undefined : claudeDownloadText(s);
}

/** The Claude Code executable for the SDK (pathToClaudeCodeExecutable): the downloaded one, when it
 * is there; undefined for a clone (the SDK's own lookup). */
export function claudeExecutable(): string | undefined {
  if (claudeRoute() === "clone") return undefined;
  const exe = path.join(binaryDir(claudeHome()), exeName());
  return fs.existsSync(exe) ? exe : undefined;
}

/** Where the installed app's claude.exe will be (for --self-test, which skips it until downloaded). */
export function claudeExePath(): string {
  return path.join(binaryDir(claudeHome()), exeName());
}

/** What to import() for the SDK: the package by name where Node resolves it (a clone, the zip:
 * companion\node_modules), the downloaded file for the installed app (outside app.asar). The entry
 * comes from the package's own "exports", so a renamed entry file keeps working. */
export function claudeSdkSpecifier(): string {
  if (claudeRoute() !== "installed") return "@anthropic-ai/claude-agent-sdk";
  const dir = path.join(claudeHome(), ...SCOPE, SDK);
  let entry = "sdk.mjs";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const dot = pkg.exports?.["."];
    const e = typeof dot === "string" ? dot : dot?.import ?? dot?.default ?? pkg.module ?? pkg.main;
    if (typeof e === "string" && e) entry = e;
  } catch {
    /* the default entry; the import reports a broken package */
  }
  return pathToFileURL(path.join(dir, entry)).href;
}

/** fetch-claude.cjs's fetchClaude bound to claudeHome() and the pins (main supplies it). */
export type ClaudeFetch = (onProgress: (got: number, total: number, label?: string) => void) => Promise<unknown>;

/** Download (or update) Claude Code into claudeHome(): one at a time; `onChange` hears every
 * state and each whole percent. Never throws: a failure is the "failed" state with its reason
 * (paths and secrets scrubbed, it can reach the Glass). */
export function downloadClaude(fetch: ClaudeFetch, onChange: (s: ClaudeDownload) => void = () => {}): Promise<ClaudeDownload> {
  if (running) return running;
  current = { state: "downloading" };
  onChange(claudeStatus());
  running = (async () => {
    try {
      await fetch((got, total) => {
        const pct = total > 0 ? Math.min(100, Math.floor((got * 100) / total)) : undefined;
        const mb = total > 0 ? Math.max(1, Math.round(total / 2 ** 20)) : undefined;
        if (current?.pct === pct && current?.mb === mb) return;
        current = { state: "downloading", ...(pct === undefined ? {} : { pct }), ...(mb === undefined ? {} : { mb }) };
        onChange(claudeStatus());
      });
      current = claudePresent() ? undefined : { state: "failed", error: "the download finished but Claude Code is not in place" };
    } catch (e: any) {
      current = { state: "failed", error: redact(String(e?.message ?? e)).replace(/\s+/g, " ").slice(0, 200) };
    } finally {
      running = undefined;
    }
    const s = claudeStatus();
    onChange(s);
    return s;
  })();
  return running;
}

/** The last failure, even when older packages are still there (for the log). */
export function claudeDownloadError(): string | undefined {
  return current?.state === "failed" ? current.error : undefined;
}

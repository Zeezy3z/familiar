// The release download (scripts/prebuilt.mjs, marked by .prebuilt) carries no Anthropic code: the
// Claude Agent SDK and its Claude Code binary arrive on the first run of Run Familiar.cmd
// (fetch-claude.cjs). Until then the Familiars card and a Claude quest say so in these words.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CLAUDE_NOT_DOWNLOADED = "Not downloaded yet — run Run Familiar.cmd again to download Claude Code (about 112 MB)";

/** Where this companion runs from. `root`: the companion folder (dist/.. in the bundle, companion/
 * from source). `packaged`: the installed app (main sets it from app.isPackaged). Tests point both
 * at fixtures. */
export const companionDir = {
  root: path.basename(__dirname) === "dist" ? path.resolve(__dirname, "..") : path.resolve(__dirname, "..", ".."),
  packaged: false,
};

/** Where the Claude packages live (node_modules\@anthropic-ai\... below it): the companion folder
 * for a clone or the release download, %LOCALAPPDATA%\Familiar\claude for the installed app. */
export function claudeHome(): string {
  if (!companionDir.packaged) return companionDir.root;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "Familiar", "claude");
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

/** CLAUDE_NOT_DOWNLOADED in a prebuilt download still missing either package, else undefined. */
export function claudeNotDownloaded(): string | undefined {
  const root = companionDir.root;
  if (!fs.existsSync(path.join(root, ".prebuilt"))) return undefined; // a clone (npm ci) or the installer
  const scope = path.join(root, "node_modules", "@anthropic-ai");
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const there = fs.existsSync(path.join(scope, "claude-agent-sdk", "package.json")) && fs.existsSync(path.join(scope, `claude-agent-sdk-${process.platform}-${process.arch}`, exe));
  return there ? undefined : CLAUDE_NOT_DOWNLOADED;
}

/** The download state for the control panel. */
export function claudeStatus(): ClaudeDownload {
  return { state: claudeNotDownloaded() ? "missing" : "present" };
}

// The release download (scripts/prebuilt.mjs, marked by .prebuilt) carries no Anthropic code: the
// Claude Agent SDK and its Claude Code binary arrive on the first run of Run Familiar.cmd
// (fetch-claude.cjs). Until then the Familiars card and a Claude quest say so in these words.
import * as fs from "node:fs";
import * as path from "node:path";

export const CLAUDE_NOT_DOWNLOADED = "Not downloaded yet — run Run Familiar.cmd again to download Claude Code (about 112 MB)";

/** The companion folder (dist/.. in the bundle). Tests point it at a fixture. */
export const companionDir = { root: path.resolve(__dirname, "..") };

/** CLAUDE_NOT_DOWNLOADED in a prebuilt download still missing either package, else undefined. */
export function claudeNotDownloaded(): string | undefined {
  const root = companionDir.root;
  if (!fs.existsSync(path.join(root, ".prebuilt"))) return undefined; // a clone (npm ci) or the installer
  const scope = path.join(root, "node_modules", "@anthropic-ai");
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const there = fs.existsSync(path.join(scope, "claude-agent-sdk", "package.json")) && fs.existsSync(path.join(scope, `claude-agent-sdk-${process.platform}-${process.arch}`, exe));
  return there ? undefined : CLAUDE_NOT_DOWNLOADED;
}

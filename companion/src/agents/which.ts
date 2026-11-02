// Find an executable on PATH the way the Windows shell would (PATHEXT), without running a shell.
import * as fs from "node:fs";
import * as path from "node:path";

export function resolveCommand(cmd: string): string | null {
  if (!cmd) return null;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  const candidates = (base: string) => (path.extname(base) ? [base] : [...exts.map((e) => base + e.toLowerCase()), base]);
  if (path.isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) {
    return candidates(path.resolve(cmd)).find(isFile) ?? null;
  }
  // PATH as Familiar was started with, plus where installers put CLIs (so an agent installed while
  // Familiar runs is found without a restart).
  for (const dir of [...(process.env.PATH ?? "").split(path.delimiter), ...installDirs()]) {
    if (!dir) continue;
    const hit = candidates(path.join(dir.replace(/^"|"$/g, ""), cmd)).find(isFile);
    if (hit) return hit;
  }
  return null;
}

function isFile(p: string) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function installDirs(): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  return [
    path.join(local, "Microsoft", "WinGet", "Links"),
    path.join(home, ".grok", "bin"),
    path.join(local, "hermes", "bin"),
    path.join(roaming, "npm"),
    path.join(home, ".local", "bin"),
  ];
}

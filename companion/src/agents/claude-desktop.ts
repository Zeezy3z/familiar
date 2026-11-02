// What the Claude desktop app knows about its Code-tab sessions, read from its own plain-JSON files:
//   %APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_<id>.json, or for the Store app
//   %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\... (title, archived, starred,
//     scheduled-task runs, the project a worktree session belongs to)
//   ~/.claude/sessions/<pid>.json  (sessions whose process is alive right now, and whether busy)
// Read-only. Never touch the *.key files next to the pid files.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Mode } from "./types";

export interface DesktopSession {
  /** Desktop id (local_…). */
  id: string;
  /** Transcript id in ~/.claude/projects — the Agent SDK's sessionId. */
  cliSessionId: string;
  title?: string;
  archived: boolean;
  starred: boolean;
  scheduled: boolean;
  /** The repo a worktree session was started from (zone), when it differs from cwd. */
  originCwd?: string;
  lastActivityAt?: number;
  completedTurns?: number;
  /** The session's permission mode as a game mode (see gameMode). */
  mode?: Mode;
}

const cache = new Map<string, { mtimeMs: number; rec: DesktopSession | null }>();

/** Desktop records keyed by cliSessionId. Files are re-parsed only when they change. When a session
 * has records in more than one root, the most recently active one wins. */
export function readDesktopSessions(roots: string | string[] = defaultRoots()): Map<string, DesktopSession> {
  const out = new Map<string, DesktopSession>();
  const seen = new Set<string>();
  for (const file of (Array.isArray(roots) ? roots : [roots]).flatMap(sessionFiles)) {
    seen.add(file);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    let hit = cache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      hit = { mtimeMs: st.mtimeMs, rec: parse(file) };
      cache.set(file, hit);
    }
    const prev = hit.rec && out.get(hit.rec.cliSessionId);
    if (hit.rec && (!prev || (hit.rec.lastActivityAt ?? 0) > (prev.lastActivityAt ?? 0))) out.set(hit.rec.cliSessionId, hit.rec);
  }
  for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  return out;
}

/** Claude sessions open right now in a desktop-app tab or a terminal (their process is alive),
 * by transcript id, and whether each is working. SDK runs (Familiar's own quests) count only with
 * `withSdk`. */
export function readLiveSessions(dir = path.join(os.homedir(), ".claude", "sessions"), withSdk = false): Map<string, { busy: boolean }> {
  const live = new Map<string, { busy: boolean }>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return live;
  }
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (typeof j?.sessionId !== "string" || (!withSdk && /^sdk/i.test(String(j.entrypoint ?? "")))) continue;
      if (pidAlive(Number(j.pid))) live.set(j.sessionId, { busy: j.status === "busy" || !!live.get(j.sessionId)?.busy });
    } catch {
      /* being rewritten */
    }
  }
  return live;
}

/** Transcript ids of Claude sessions whose process is alive and working right now. */
export function readBusySessions(dir?: string): Set<string> {
  return new Set([...readLiveSessions(dir)].filter(([, s]) => s.busy).map(([id]) => id));
}

/** Where the desktop app keeps its records. The Windows app is a Store (MSIX) package: what it writes
 * to %APPDATA% really lands in its package cache, which only the package itself sees at %APPDATA%.
 * Familiar runs outside the package, so it reads the package cache directly, plus the classic path. */
export function defaultRoots(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const roots = [path.join(appData, "Claude", "claude-code-sessions")];
  const packages = path.join(localAppData, "Packages");
  try {
    for (const d of fs.readdirSync(packages, { withFileTypes: true }))
      if (d.isDirectory() && /^Claude_[a-z0-9]+$/i.test(d.name))
        roots.push(path.join(packages, d.name, "LocalCache", "Roaming", "Claude", "claude-code-sessions"));
  } catch {
    /* no Store packages */
  }
  return roots;
}

function sessionFiles(root: string): string[] {
  const files: string[] = [];
  const dirs = (p: string) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
    } catch {
      return [];
    }
  };
  for (const acct of dirs(root))
    for (const org of dirs(acct)) {
      try {
        for (const n of fs.readdirSync(org)) if (/^local_.*\.json$/.test(n)) files.push(path.join(org, n));
      } catch {
        /* gone */
      }
    }
  return files;
}

function parse(file: string): DesktopSession | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof j?.cliSessionId !== "string" || !j.cliSessionId) return null;
    return {
      id: String(j.sessionId ?? path.basename(file, ".json")),
      cliSessionId: j.cliSessionId,
      title: typeof j.title === "string" && j.title.trim() ? j.title.trim() : undefined,
      archived: j.isArchived === true,
      starred: j.isStarred === true,
      scheduled: !!j.scheduledTaskId,
      originCwd: typeof j.originCwd === "string" && j.originCwd && j.originCwd !== j.cwd ? j.originCwd : undefined,
      lastActivityAt: typeof j.lastActivityAt === "number" ? j.lastActivityAt : undefined,
      completedTurns: typeof j.completedTurns === "number" ? j.completedTurns : undefined,
      mode: gameMode(j.permissionMode),
    };
  } catch {
    return null;
  }
}

/** A desktop session's permission mode as a Familiar mode. Modes that skip asking (auto, bypass,
 * don't ask) and unknown ones become Ask first in the game; no recorded mode leaves the default. */
function gameMode(permissionMode: unknown): Mode | undefined {
  if (typeof permissionMode !== "string" || !permissionMode) return undefined;
  return permissionMode === "plan" ? "plan" : permissionMode === "acceptEdits" ? "edits" : "ask";
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

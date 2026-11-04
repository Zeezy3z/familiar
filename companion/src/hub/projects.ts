// Project ("zone") registry: configured roots + explicit folders + folders seen in Claude/Codex
// history, merged by normalized path, excluding anything on the exclusion list, any folder inside
// one marked with a `.nofamiliar` file, the home folder and drive roots.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appDataDir, Config, isExcluded, normPath } from "./config";

/** An empty file with this name hides its folder (and everything below it) from Familiar. */
export const OPT_OUT_FILE = ".nofamiliar";

/** The folder or one of its ancestors carries the opt-out marker. */
function optedOut(p: string): boolean {
  for (let d = path.resolve(p); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, OPT_OUT_FILE))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/** The home folder or a drive root is never a zone: an agent there would see everything. */
function tooBroad(p: string): boolean {
  const n = normPath(p);
  // A drive root (`C:`), the POSIX root (`/`, as on CI), or the home folder.
  return /^[a-z]:$/.test(n) || n === "" || n === "/" || path.parse(p).root === p || n === normPath(os.homedir());
}

/** Why a folder can never be a zone, in words for the control panel (one rule for listing a
 * folder and for adding one there), or undefined. */
export function zoneRefusal(p: string, c: Config): string | undefined {
  const root = projectRootOf(p);
  if (tooBroad(root)) return "A drive or your home folder can't be a zone: an agent there could see everything.";
  if (isExcluded(root, c) || isExcluded(p, c)) return "That folder is excluded by your config.";
  if (optedOut(p)) return `That folder (or one above it) has a ${OPT_OUT_FILE} file, so Familiar never offers it.`;
  return undefined;
}

export interface Project {
  key: string; // normalized path
  name: string;
  path: string;
  lastActivity: number;
}

// Codex keeps worktrees outside the repo: ~/.codex/worktrees/<hash>/<repo-name>.
const CODEX_WT = /^(.*?[\\/]\.codex[\\/]worktrees[\\/][^\\/]+[\\/]([^\\/]+))/i;
// Codex desktop chats without a project get a scratch folder: ~/Documents/Codex/<date>/<slug>.
const CODEX_CHATS = /^(.*?[\\/]Documents[\\/]Codex)[\\/]\d{4}-\d{2}-\d{2}[\\/][^\\/]+/i;

/** The "Chats" zone: Familiar's own chats (no repo) plus Codex desktop chats without a project. */
export const CHATS_KEY = "chats";

/** Neutral folder Familiar's chats run in (no repo, no CLAUDE.md/AGENTS.md). */
export function chatDir(): string {
  const d = path.join(appDataDir(), "chat");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function isChatPath(p: string): boolean {
  if (CODEX_CHATS.test(p.replace(/^\\\\\?\\/, ""))) return true;
  const n = normPath(p);
  const c = normPath(chatDir());
  return n === c || n.startsWith(c + "\\");
}

/** Map worktree checkouts to the project they belong to. A Codex worktree can't name its repo's
 * folder, so it maps to itself here; ProjectRegistry.add() folds it into a known project by name. */
export function projectRootOf(p: string): string {
  p = p.replace(/^\\\\\?\\/, "");
  const cx = p.match(CODEX_WT);
  if (cx) return cx[1];
  const m = p.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/i);
  if (m) return m[1];
  const wt = p.match(/^(.*?)-worktrees[\\/][^\\/]+/i);
  if (wt) return wt[1];
  return p;
}

export class ProjectRegistry {
  private map = new Map<string, Project>();

  constructor(private cfg: () => Config) {}

  scanRoots() {
    const c = this.cfg();
    for (const root of c.projectRoots) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("_")) continue;
        if (/(-worktrees|^wt|-wt)$/i.test(e.name)) continue; // worktree containers, not projects
        this.add(path.join(root, e.name), 0);
      }
    }
    for (const p of c.projects) this.add(p, 0);
  }

  /** Add or touch a folder. Returns the project (or null if excluded / missing). */
  add(p: string, activity = 0): Project | null {
    if (!p) return null;
    p = p.replace(/^\\\\\?\\/, "");
    if (isChatPath(p)) return this.chats(activity);
    try {
      p = fs.realpathSync.native(p); // resolve junctions / 8.3 short names before the boundary check
    } catch {
      /* missing folders are rejected below */
    }
    const root = projectRootOf(p);
    if (zoneRefusal(p, this.cfg())) return null;
    const cx = root.match(CODEX_WT);
    if (cx) {
      const name = cx[2].toLowerCase();
      const home = [...this.map.values()].find((x) => !CODEX_WT.test(x.path) && path.basename(x.path).toLowerCase() === name);
      if (home) {
        if (activity > home.lastActivity) home.lastActivity = activity;
        return home;
      }
    }
    const key = normPath(root);
    let proj = this.map.get(key);
    if (!proj) {
      if (!fs.existsSync(root)) return null;
      proj = { key, name: path.basename(root), path: path.resolve(root), lastActivity: activity };
      this.map.set(key, proj);
      this.dedupeNames();
    } else if (activity > proj.lastActivity) proj.lastActivity = activity;
    return proj;
  }

  get(key: string) {
    return this.map.get(key);
  }

  byPath(p: string) {
    return this.map.get(normPath(projectRootOf(p)));
  }

  /** The Chats zone (always available; not offered as a project to start coding quests in). */
  chats(activity = 0): Project {
    let p = this.map.get(CHATS_KEY);
    if (!p) {
      p = { key: CHATS_KEY, name: "Chats", path: chatDir(), lastActivity: activity };
      this.map.set(CHATS_KEY, p);
    } else if (activity > p.lastActivity) p.lastActivity = activity;
    return p;
  }

  /** Project folders, most recently active first (the Chats zone is not one). */
  list(): Project[] {
    return [...this.map.values()].filter((p) => p.key !== CHATS_KEY).sort((a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
  }

  private dedupeNames() {
    const seen = new Map<string, Project[]>();
    for (const p of this.map.values()) {
      if (p.key === CHATS_KEY) continue;
      const base = path.basename(p.path);
      seen.set(base.toLowerCase(), [...(seen.get(base.toLowerCase()) ?? []), p]);
    }
    for (const group of seen.values()) {
      for (const p of group) p.name = group.length > 1 ? `${path.basename(p.path)} (${path.basename(path.dirname(p.path))})` : path.basename(p.path);
    }
  }
}

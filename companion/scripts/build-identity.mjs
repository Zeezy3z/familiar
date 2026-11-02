// Build-time metadata only. Never invoke Git from the running companion.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function buildIdentity(repo) {
  const unknown = { commit: null, dirty: null };
  // An archive nested in some other Git repository must not borrow its parent's identity.
  if (!existsSync(join(repo, ".git"))) return unknown;
  const git = args => execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    { cwd: repo, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 }).trim();
  let commit;
  try { commit = git(["rev-parse", "--verify", "HEAD"]); } catch { return unknown; }
  if (!/^[a-f0-9]{40}$/.test(commit)) return unknown;
  let dirty = null;
  try { dirty = !!git(["status", "--porcelain", "--untracked-files=normal"]); } catch { /* unknown is not clean */ }
  return { commit, dirty };
}

export const buildDefine = identity => ({ __FAMILIAR_BUILD__: JSON.stringify(identity) });

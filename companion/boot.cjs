// Electron entry point. Rebuilds dist/ when it is missing or older than the sources, then starts
// the companion — so "start with Windows" keeps working after a git pull or a fresh clone, without
// going through Run Familiar.cmd.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = __dirname;
const main = path.join(root, "dist", "main.js");

function newest(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let t = 0;
  for (const name of fs.readdirSync(p)) t = Math.max(t, newest(path.join(p, name)));
  return t;
}

function note(line) {
  try {
    const dir = path.join(process.env.APPDATA || path.join(require("node:os").homedir(), "AppData", "Roaming"), "Familiar");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "familiar.log"), `${new Date().toISOString()} [boot] ${line}\n`);
  } catch {
    /* logging is best effort */
  }
}

let stale = true;
try {
  // What the bundle is built from: sources, build scripts (build identity too) and locked dependencies.
  const inputs = ["src", "scripts", "package-lock.json"].map((p) => newest(path.join(root, p)));
  stale = Math.max(...inputs) > fs.statSync(main).mtimeMs;
} catch {
  /* no dist yet */
}
// A second launch while Familiar runs only opens its control panel (main.ts). That panel loads
// dist/ from disk, so rebuilding here would pair new panel code with the old main process.
if (stale && !require("electron").app.requestSingleInstanceLock()) stale = false;
if (stale) {
  // process.execPath is electron.exe; ELECTRON_RUN_AS_NODE makes it a plain Node for the build.
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs")], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    encoding: "utf8",
  });
  if (r.status === 0) note("rebuilt dist (sources changed)");
  else {
    note(`rebuild failed (${r.status}): ${String(r.stderr || r.error || "").slice(0, 2000)}`);
    if (!fs.existsSync(main)) process.exit(1);
    note("starting the previous build");
  }
}

require(main);

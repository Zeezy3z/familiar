// Checks that this install can run, without starting it: no windows, no login entry, no AddOns
// link. `electron.exe <companion folder> --self-test` runs it from boot.cjs before the companion
// loads (release.yml runs it on the extracted download). One line per check; ok is false if any
// check failed. A skipped check does not fail: the release download has no Claude Code until its
// first run fetches it (fetch-claude.cjs).
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/** @param {{ appRoot: string, addonDir: string, claudeExe?: string }} where */
function selfTest({ appRoot, addonDir, claudeExe }) {
  const lines = [];
  let ok = true;
  const check = (name, fn) => {
    try {
      lines.push(`ok   ${name}: ${fn()}`);
    } catch (e) {
      ok = false;
      lines.push(`FAIL ${name}: ${(e && e.message) || e}`);
    }
  };
  const file = (p) => {
    if (!fs.statSync(p).isFile()) throw new Error(`${p} is not a file`);
    return "found";
  };
  check("companion bundle (dist/main.js)", () => file(path.join(appRoot, "dist", "main.js")));
  check("addon (Familiar.toc)", () => file(path.join(addonDir, "Familiar.toc")));
  // The Win32 calls in main go through koffi's native module; one harmless read-only call proves it loads.
  check("koffi", () => {
    const koffi = require("koffi");
    const pid = koffi.load("kernel32.dll").func("uint32_t GetCurrentProcessId()")();
    if (pid !== process.pid) throw new Error(`GetCurrentProcessId returned ${pid}, expected ${process.pid}`);
    return `${koffi.version}, native call ok`;
  });
  const claude = "Claude Code (claude --version)";
  const sdk = path.join(appRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
  if ((!claudeExe || !fs.existsSync(sdk)) && fs.existsSync(path.join(appRoot, ".prebuilt"))) lines.push(`skip ${claude}: not downloaded yet (first run fetches it)`);
  else check(claude, () => {
    if (!claudeExe) throw new Error("bundled Claude Code binary not found");
    // A cold first start of a ~250 MB binary can be slow while antivirus scans it.
    const r = spawnSync(claudeExe, ["--version"], { encoding: "utf8", timeout: 120_000, windowsHide: true });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${String(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return String(r.stdout).trim().split(/\r?\n/)[0];
  });
  return { ok, lines };
}

module.exports = { selfTest };

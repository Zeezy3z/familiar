// Packaged-app self-test (`Familiar.exe --self-test`, run by CI against win-unpacked).
// Minimal version for the installer branch; the full one is owned elsewhere and keeps this contract:
//   selfTest({ appRoot, addonDir, claudeExe }) -> { ok: boolean, lines: string[] }
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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
  check("koffi", () => {
    const koffi = require("koffi");
    if (typeof koffi.load !== "function") throw new Error("koffi.load missing");
    return "loaded";
  });
  check("claude.exe", () => {
    if (!claudeExe) throw new Error("no path");
    const r = spawnSync(claudeExe, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${String(r.stderr).trim().slice(0, 200)}`);
    return String(r.stdout).trim();
  });
  check("dist/main.js", () => {
    if (!fs.existsSync(path.join(appRoot, "dist", "main.js"))) throw new Error(`missing under ${appRoot}`);
    return "present";
  });
  check("addon", () => {
    const toc = path.join(addonDir, "Familiar.toc");
    if (!fs.existsSync(toc)) throw new Error(`missing ${toc}`);
    return /^## Version:\s*(\S+)/m.exec(fs.readFileSync(toc, "utf8"))?.[1] ?? "no ## Version";
  });
  return { ok, lines };
}

module.exports = { selfTest };

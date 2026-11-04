// The release download FamiliarApp-<tag>-windows.zip: the repository as `git archive` exports it,
// plus companion/dist, the production node_modules and the stock Electron binary, so Run
// Familiar.cmd starts it with no Node or npm on the player's PC. Same folder layout as a clone.
// Windows only: npm installs the win32 builds of Electron and koffi. The Claude Agent SDK and its
// Claude Code binary package are left out (Anthropic's, not ours to redistribute): Run
// Familiar.cmd's first run fetches the versions the lockfile pins from npm (companion/fetch-claude.cjs).
//
//   node companion/scripts/prebuilt.mjs build <out.zip> [git ref, default HEAD]
//   node companion/scripts/prebuilt.mjs check <out.zip>
//
// check extracts the zip into a temp folder, checks the files, and with every folder holding
// node.exe removed from PATH runs the companion's --self-test there (Claude Code skipped: not
// downloaded yet), then fetch-claude.cjs as Run Familiar.cmd does (a real npm download), then the
// self-test again, which now runs claude --version, and imports the downloaded SDK.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const system32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
const tar = join(system32, "tar.exe"); // Windows' bsdtar writes and reads .zip (Git's GNU tar does not)
const ELECTRON = "companion/node_modules/electron/dist/electron.exe";
/** What Run Familiar.cmd, boot.cjs and the release checks rely on. */
const REQUIRED = ["Run Familiar.cmd", "addon/Familiar/Familiar.toc", "companion/package-lock.json", "companion/.prebuilt",
  "companion/boot.cjs", "companion/self-test.cjs", "companion/fetch-claude.cjs", "companion/dist/main.js", "companion/dist/claude-pins.json", ELECTRON];
/** Anthropic's proprietary packages under companion/node_modules/@anthropic-ai/: the Claude Agent
 * SDK and its Claude Code binary packages. (@anthropic-ai/sdk, the MIT API client, stays.) */
const CLAUDE = /^claude-agent-sdk(-|$)/;
const claudeLeft = (app) => readdirSync(join(app, "companion", "node_modules", "@anthropic-ai")).filter((n) => CLAUDE.test(n));

function run(cmd, args, opts = {}) {
  console.log(`> ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${[cmd, ...args].join(" ")} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
}
// npm is npm.cmd on Windows, which needs a shell; the arguments are fixed strings.
const npm = (cwd, args) => run(`npm ${args} --ignore-scripts --no-audit --no-fund`, [], { cwd, shell: true });
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const mb = (bytes) => `${(bytes / 2 ** 20).toFixed(0)} MB`;
const size = (p) => (statSync(p).isDirectory() ? readdirSync(p).reduce((t, n) => t + size(join(p, n)), 0) : statSync(p).size);

/**
 * Deletes what no runtime reads: source maps, type declarations, docs (license and readme files
 * stay), and the folders prune leaves empty.
 */
function strip(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      strip(p);
      if (!readdirSync(p).length) rmSync(p, { recursive: true });
    } else if (/\.(map|d\.[cm]?ts)$/i.test(e.name) || (/\.md$/i.test(e.name) && !/^(licen[cs]e|notice|copying|readme)/i.test(e.name))) rmSync(p);
  }
}

function build(out, ref) {
  const stage = mkdtempSync(join(dirname(out), "familiar-stage-"));
  try {
    const app = join(stage, "Familiar");
    const companion = join(app, "companion");
    const nm = join(companion, "node_modules");
    // git archive applies .gitattributes, so Run Familiar.cmd keeps its CRLF line endings.
    run("git", ["-C", repo, "archive", "--format=tar", "--prefix=Familiar/", "-o", join(stage, "src.tar"), ref]);
    run(tar, ["-x", "-f", join(stage, "src.tar"), "-C", stage]);
    rmSync(join(stage, "src.tar"));
    const lockFile = join(companion, "package-lock.json");
    const lock = readFileSync(lockFile);
    npm(companion, "ci");
    // Electron's package downloads its binary only from this script (checked against its checksums.json).
    run(process.execPath, ["node_modules/electron/install.js"], { cwd: companion });
    run(process.execPath, ["scripts/build.mjs"], { cwd: companion });

    // electron is a devDependency, and the runtime needs only its dist/ (main resolves
    // require("electron") inside Electron itself). Keep the package aside while the dev tooling goes.
    const electron = join(stage, "electron");
    renameSync(join(nm, "electron"), electron);
    npm(companion, "prune --omit=dev");
    writeFileSync(lockFile, lock); // prune must not change the lockfile the marker names
    for (const f of ["dist", "LICENSE", "package.json", "index.js", "path.txt"]) cpSync(join(electron, f), join(nm, "electron", f), { recursive: true });
    rmSync(electron, { recursive: true });

    // .bin holds npm's command shims (they need Node); koffi's vendor/ and doc/ are build headers and docs.
    for (const d of [".bin", "koffi/vendor", "koffi/doc"]) rmSync(join(nm, d), { recursive: true, force: true });
    strip(nm);
    // Chromium's UI strings; it falls back to en-US for any other system language.
    const locales = join(nm, "electron", "dist", "locales");
    for (const f of readdirSync(locales)) if (f !== "en-US.pak") rmSync(join(locales, f));
    // Not ours to redistribute; the player's PC downloads it on first run (fetch-claude.cjs).
    for (const n of claudeLeft(app)) rmSync(join(nm, "@anthropic-ai", n), { recursive: true });

    const version = JSON.parse(readFileSync(join(companion, "package.json"), "utf8")).version;
    writeFileSync(join(companion, ".prebuilt"), `version=${version}\nlock=${sha256(lock)}\n`);
    const missing = REQUIRED.filter((f) => !existsSync(join(app, f)));
    if (missing.length) throw new Error(`missing from the staged app: ${missing.join(", ")}`);

    rmSync(out, { force: true });
    run(tar, ["-a", "-c", "-f", out, "-C", stage, "Familiar"]);
    console.log(`built ${out}: ${mb(statSync(out).size)}, ${mb(size(app))} extracted`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function check(zip) {
  const dir = mkdtempSync(join(tmpdir(), "familiar-check-"));
  try {
    run(tar, ["-x", "-f", zip, "-C", dir]);
    const app = join(dir, "Familiar");
    const missing = REQUIRED.filter((f) => !existsSync(join(app, f)));
    if (missing.length) throw new Error(`missing from ${zip}: ${missing.join(", ")}`);
    if (claudeLeft(app).length) throw new Error(`${zip} must not contain Anthropic's Claude packages: ${claudeLeft(app).join(", ")}`);
    const cmd = readFileSync(join(app, "Run Familiar.cmd"), "latin1");
    const lf = cmd.split("\n").length - 1;
    const crlf = cmd.split("\r\n").length - 1;
    if (!lf || crlf !== lf) throw new Error(`Run Familiar.cmd must have CRLF line endings (LF=${lf}, CRLF=${crlf})`);
    process.stdout.write(`companion/.prebuilt:\n${readFileSync(join(app, "companion", ".prebuilt"), "utf8")}`);
    const extracted = size(app);

    // The player's PC has no Node: hide every node.exe from the app and everything it starts.
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^path$/i.test(k)) env[k] = v.split(delimiter).filter((d) => d && !existsSync(join(d, "node.exe"))).join(delimiter);
      else if (!/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/i.test(k)) env[k] = v;
    }
    if (spawnSync(join(system32, "where.exe"), ["node"], { env, stdio: "ignore" }).status === 0) throw new Error("node is still on PATH");
    const electron = (args, extra = {}, timeout = 300_000) => {
      console.log(`> ${ELECTRON} ${args.join(" ")} (no node on PATH${extra.ELECTRON_RUN_AS_NODE ? ", ELECTRON_RUN_AS_NODE=1" : ""})`);
      const r = spawnSync(join(app, ELECTRON), args, { cwd: join(app, "companion"), env: { ...env, ...extra }, encoding: "utf8", timeout });
      process.stdout.write(r.stdout || "");
      process.stderr.write(r.stderr || "");
      if (r.status !== 0) throw new Error(`${args.join(" ")} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
      return r.stdout;
    };
    const selfTest = (claudeLine) => {
      if (!claudeLine.test(electron([join(app, "companion"), "--self-test"]))) throw new Error(`self-test: no line matching ${claudeLine}`);
    };
    selfTest(/^skip Claude Code/m); // as extracted: Claude Code is not in the zip
    // Run Familiar.cmd's first-run step: download from npm, check the lockfile's sha512, unpack.
    electron(["fetch-claude.cjs"], { ELECTRON_RUN_AS_NODE: "1" }, 600_000);
    selfTest(/^ok {3}Claude Code/m);
    // The companion loads the SDK lazily, as ESM: this proves it and its dependencies (left in the zip) load.
    const sdk = electron(["-e", 'import("@anthropic-ai/claude-agent-sdk").then((m) => console.log("SDK query:", typeof m.query))'], { ELECTRON_RUN_AS_NODE: "1" });
    if (!/SDK query: function/.test(sdk)) throw new Error("the downloaded Claude Agent SDK does not load");
    if (electron(["fetch-claude.cjs"], { ELECTRON_RUN_AS_NODE: "1" }).trim()) throw new Error("a second fetch-claude.cjs run should find Claude in place and print nothing");
    console.log(`checked ${zip}: ${mb(statSync(zip).size)}, ${mb(extracted)} extracted, ${mb(size(app))} with Claude Code`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  if (process.platform !== "win32") throw new Error("Windows only");
  const [cmd, zip, ref = "HEAD"] = process.argv.slice(2);
  if (!["build", "check"].includes(cmd) || !/\.zip$/i.test(zip ?? "")) throw new Error("usage: prebuilt.mjs build <out.zip> [ref] | check <out.zip>");
  if (cmd === "build") {
    mkdirSync(dirname(resolve(zip)), { recursive: true });
    build(resolve(zip), ref);
  } else check(resolve(zip));
} catch (e) {
  console.error(`prebuilt: ${e.message}`);
  process.exit(1);
}

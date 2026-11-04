// Build the real identity entry, then run only that entry under Node. No Electron or agents.
import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefine, buildIdentity } from "../scripts/build-identity.mjs";
import { PRELOADS, preloadBuilds } from "../scripts/bundles.mjs";

const fixtures = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "familiar-build-"));
  fixtures.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: repo, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
  git("init");
  writeFileSync(join(repo, "source.txt"), "first build");
  git("add", "."); git("commit", "-m", "Fixture first");
  return { dir, repo, git };
}
async function compile(dir, identity) {
  const entry = fileURLToPath(new URL("../src/main/build.ts", import.meta.url));
  const result = await build({ stdin: { contents: readFileSync(entry, "utf8"), loader: "ts", sourcefile: "build.ts" }, tsconfigRaw: {},
    bundle: true, platform: "node", format: "cjs", write: false, define: buildDefine(identity) });
  const file = join(dir, "identity.cjs");
  writeFileSync(file, result.outputFiles[0].text);
  return () => JSON.parse(execFileSync(process.execPath, ["-e", "const b = require(process.argv[1]); process.stdout.write(JSON.stringify({identity:b.RUNNING_BUILD,frozen:Object.isFrozen(b.RUNNING_BUILD)}))", file], { encoding: "utf8" }));
}
describe("identity embedded in the running build", () => {
  it("retains its built commit after source and Git metadata change", async () => {
    const { dir, repo, git } = fixture();
    const first = buildIdentity(repo);
    expect(first).toEqual({ commit: git("rev-parse", "HEAD"), dirty: false });
    const readBuild = await compile(dir, first);
    writeFileSync(join(repo, "source.txt"), "later checkout");
    git("add", "."); git("commit", "-m", "Fixture later");
    expect(buildIdentity(repo).commit).not.toBe(first.commit);
    expect(readBuild()).toEqual({ identity: first, frozen: true });
  });
  it("marks tracked and untracked local changes without including filenames", () => {
    const { repo } = fixture();
    writeFileSync(join(repo, "source.txt"), "local edit");
    writeFileSync(join(repo, "private-name.txt"), "never included in the stamp");
    expect(buildIdentity(repo).dirty).toBe(true);
    expect(JSON.stringify(buildIdentity(repo))).not.toMatch(/private-name|familiar-build|repo/);
  });
  it("keeps a Git-less package explicitly unavailable, even inside another Git checkout", async () => {
    const { dir, repo } = fixture();
    const packaged = join(repo, "package");
    mkdirSync(packaged);
    const identity = buildIdentity(packaged);
    expect(identity).toEqual({ commit: null, dirty: null });
    expect((await compile(dir, identity))().identity).toEqual(identity);
  });
});

// The real boot.cjs in a throwaway app folder, run by Node: a stand-in build script and dist/main.js
// record what ran, and a stand-in electron module says whether Familiar is already running.
describe("boot.cjs, the start-with-Windows entry", () => {
  function app() {
    const base = mkdtempSync(join(tmpdir(), "familiar-boot-"));
    fixtures.push(base);
    const dir = join(base, "companion"); // beside addon/Familiar, as in a clone or the download
    for (const d of ["src", "scripts", "dist", "node_modules/electron", "node_modules/koffi", "../addon/Familiar"]) mkdirSync(join(dir, d), { recursive: true });
    for (const f of ["boot.cjs", "self-test.cjs"]) copyFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), join(dir, f));
    writeFileSync(join(base, "addon/Familiar/Familiar.toc"), "## Interface: 16001\n");
    writeFileSync(join(dir, "node_modules/koffi/index.js"),
      'exports.version = "stand-in"; exports.load = () => ({ func: () => () => process.pid });');
    writeFileSync(join(dir, "node_modules/electron/index.js"),
      'exports.app = { requestSingleInstanceLock: () => process.env.FAMILIAR_TEST_RUNNING !== "1", quit() {} };');
    writeFileSync(join(dir, "scripts/build.mjs"),
      'import { appendFileSync, utimesSync } from "node:fs"; appendFileSync("ran.txt", "build "); utimesSync("dist/main.js", new Date(), new Date());');
    writeFileSync(join(dir, "dist/main.js"), 'require("node:fs").appendFileSync(require("node:path").join(__dirname, "..", "ran.txt"), "start ");');
    const files = ["src/main.ts", "scripts/build.mjs", "scripts/build-identity.mjs", "package-lock.json", "dist/main.js"];
    for (const f of [files[0], files[2], files[3]]) writeFileSync(join(dir, f), "");
    const at = (t, ...names) => { for (const f of names) utimesSync(join(dir, f), t, t); };
    const hourAgo = Date.now() / 1000 - 3600;
    at(hourAgo, ...files.slice(0, 4));
    at(hourAgo + 60, "dist/main.js"); // built after the checkout
    // A later pull: newer than every file so far, including the last build.
    const touch = (name) => at(Math.max(...files.map((f) => statSync(join(dir, f)).mtimeMs / 1000)) + 60, name);
    const boot = (running = false) => {
      rmSync(join(dir, "ran.txt"), { force: true });
      // APPDATA points into the fixture so boot's log line never reaches the real familiar.log.
      execFileSync(process.execPath, [join(dir, "boot.cjs")], { cwd: dir, stdio: "ignore",
        env: { ...process.env, APPDATA: dir, FAMILIAR_TEST_RUNNING: running ? "1" : "0" } });
      return readFileSync(join(dir, "ran.txt"), "utf8").trim().split(" ");
    };
    // Exit status, output and what ran, for runs that may fail or must not start anything.
    const spawn = (...args) => {
      rmSync(join(dir, "ran.txt"), { force: true });
      const r = spawnSync(process.execPath, [join(dir, "boot.cjs"), ...args], { cwd: dir, encoding: "utf8",
        env: { ...process.env, APPDATA: dir, FAMILIAR_TEST_RUNNING: "0" } });
      return { status: r.status, out: r.stdout, ran: existsSync(join(dir, "ran.txt")) ? readFileSync(join(dir, "ran.txt"), "utf8").trim() : "" };
    };
    return { dir, boot, touch, spawn };
  }

  it("rebuilds after a pull that changed the build scripts or the dependency lock", () => {
    const { boot, touch } = app();
    expect(boot()).toEqual(["start"]);
    touch("package-lock.json");
    expect(boot()).toEqual(["build", "start"]);
    expect(boot()).toEqual(["start"]);
    touch("scripts/build-identity.mjs");
    expect(boot()).toEqual(["build", "start"]);
  });

  it("never rebuilds under a running Familiar: a second launch only opens its panel", () => {
    const { boot, touch } = app();
    touch("src/main.ts");
    expect(boot(true)).toEqual(["start"]); // main.js then hands over to the running instance and quits
    expect(boot()).toEqual(["build", "start"]);
  });

  // The release download has no Node or dev dependencies, and unzipping can leave src/ newer than dist/.
  it("never rebuilds the prebuilt download, and stops if its bundle is missing", () => {
    const { dir, boot, touch, spawn } = app();
    writeFileSync(join(dir, ".prebuilt"), "version=0.0.0\n");
    touch("src/main.ts");
    touch("package-lock.json");
    expect(boot()).toEqual(["start"]);
    rmSync(join(dir, "dist/main.js"));
    expect(spawn()).toMatchObject({ status: 1, ran: "" });
  });

  it("--self-test reports each check and exits without building or starting the companion", () => {
    const { dir, touch, spawn } = app();
    touch("src/main.ts"); // stale: a normal start would rebuild first
    const r = spawn("--self-test");
    expect(r.ran).toBe(""); // never main.js, so never the login entry or the AddOns link
    expect(r.out.trim().split("\n").map((l) => l.replace(/:.*/, ""))).toEqual([
      "ok   companion bundle (dist/main.js)",
      "ok   addon (Familiar.toc)",
      "ok   koffi",
      "FAIL Claude Code (claude --version)", // no bundled binary in the fixture
    ]);
    expect(r.status).toBe(1);
    rmSync(join(dir, "../addon/Familiar/Familiar.toc"));
    expect(spawn("--self-test").out).toMatch(/^FAIL addon \(Familiar\.toc\)/m);
  });

  // The download leaves Claude Code out; Run Familiar.cmd's first run fetches it (fetch-claude.cjs).
  it("--self-test of the prebuilt download skips Claude Code until it is downloaded, and still passes", () => {
    const { dir, spawn } = app();
    writeFileSync(join(dir, ".prebuilt"), "version=0.0.0\n");
    const r = spawn("--self-test");
    expect(r.out.trim().split("\n").at(-1)).toBe("skip Claude Code (claude --version): not downloaded yet (first run fetches it)");
    expect(r).toMatchObject({ status: 0, ran: "" });
  });
});

// The real fetch-claude.cjs in a throwaway companion folder, with the network replaced by a
// downloader that serves stand-in npm tarballs (built here with the same tar.exe the script uses).
describe("fetch-claude.cjs, the release download's first-run Claude download", () => {
  const { fetchClaude } = createRequire(import.meta.url)("../fetch-claude.cjs");
  const SDK = "@anthropic-ai/claude-agent-sdk";
  const BIN = "@anthropic-ai/claude-agent-sdk-win32-x64";
  const MAC = "@anthropic-ai/claude-agent-sdk-darwin-arm64";
  const url = (name) => `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-0.9.9.tgz`;
  const tar = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  function companion({ resolved = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "familiar-fetch-"));
    fixtures.push(dir);
    const files = {
      [SDK]: { "package.json": JSON.stringify({ name: SDK, version: "0.9.9" }), "manifest.json": JSON.stringify({ version: "9.1.999" }), "sdk.mjs": "export const query = () => {};" },
      [BIN]: { "package.json": JSON.stringify({ name: BIN, version: "0.9.9" }), "claude.exe": "stand-in for the Claude Code binary" },
      [MAC]: { "package.json": JSON.stringify({ name: MAC, version: "0.9.9" }), claude: "another platform's binary" },
    };
    const bytes = {};
    const packages = {};
    for (const [name, content] of Object.entries(files)) {
      const pack = join(dir, "pack", name.split("/")[1]);
      mkdirSync(join(pack, "package"), { recursive: true });
      for (const [f, text] of Object.entries(content)) writeFileSync(join(pack, "package", f), text);
      const tgz = join(pack, "p.tgz");
      execFileSync(tar, ["-c", "-z", "-f", tgz, "-C", pack, "package"]);
      bytes[name] = readFileSync(tgz);
      packages[`node_modules/${name}`] = { version: "0.9.9", resolved: resolved[name] ?? url(name), integrity: "sha512-" + createHash("sha512").update(bytes[name]).digest("base64"),
        ...(name === BIN ? { os: ["win32"], cpu: ["x64"], optional: true } : name === MAC ? { os: ["darwin"], cpu: ["arm64"], optional: true } : {}) };
    }
    const root = join(dir, "companion");
    mkdirSync(join(root, "node_modules/@anthropic-ai/sdk"), { recursive: true }); // the MIT API client, which stays in the zip
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages }));
    const urls = [];
    let out = "";
    const fetch = (tamper) => fetchClaude({ root, platform: "win32", arch: "x64", tar, log: (s) => (out += s),
      download: async (u, file, progress) => {
        urls.push(u);
        const name = Object.keys(bytes).find((n) => u === url(n));
        const serve = Buffer.from(bytes[name]);
        if (name === tamper) serve[serve.length >> 1] ^= 0xff;
        progress(0, serve.length);
        writeFileSync(file, serve);
        progress(serve.length, serve.length);
      } });
    const at = (name, f) => join(root, "node_modules", name, f);
    const scope = () => readdirSync(join(root, "node_modules/@anthropic-ai")).sort();
    return { root, urls, fetch, at, scope, out: () => out };
  }

  it("installs exactly the pinned SDK and this PC's Claude Code where npm would, and a second run downloads nothing", async () => {
    const c = companion();
    await expect(c.fetch()).resolves.toBe("installed");
    expect(c.urls).toEqual([url(SDK), url(BIN)]); // never another platform's binary
    expect(c.out()).toMatch(/^Downloading the Claude Agent SDK 0\.9\.9 from npm \(about 1 MB\)\.\.\.$/m);
    expect(c.out()).toMatch(/^Downloading Claude Code 9\.1\.999 from npm \(about 1 MB\)\.\.\.$/m);
    expect(readFileSync(c.at(BIN, "claude.exe"), "utf8")).toBe("stand-in for the Claude Code binary");
    expect(readFileSync(c.at(SDK, "sdk.mjs"), "utf8")).toBe("export const query = () => {};");
    expect(c.scope()).toEqual(["claude-agent-sdk", "claude-agent-sdk-win32-x64", "sdk"]); // no leftovers
    await expect(c.fetch()).resolves.toBe("present");
    expect(c.urls).toHaveLength(2);
  });

  it("replaces only what is missing or older, as after extracting a new download over an old folder", async () => {
    const c = companion();
    await c.fetch();
    writeFileSync(c.at(BIN, "package.json"), JSON.stringify({ name: BIN, version: "0.9.8" }));
    writeFileSync(c.at(BIN, "claude.exe"), "older binary");
    await expect(c.fetch()).resolves.toBe("installed");
    expect(c.urls.slice(2)).toEqual([url(BIN)]);
    expect(readFileSync(c.at(BIN, "claude.exe"), "utf8")).toBe("stand-in for the Claude Code binary");
    expect(c.scope()).toEqual(["claude-agent-sdk", "claude-agent-sdk-win32-x64", "sdk"]);
  });

  it.each([["the SDK", SDK], ["Claude Code", BIN]])("refuses a download of %s that does not match the lockfile's sha512, and installs neither", async (_, tampered) => {
    const c = companion();
    await expect(c.fetch(tampered)).rejects.toThrow(new RegExp(`^${tampered}@0\\.9\\.9: the download does not match package-lock\\.json's sha512 integrity`));
    expect(c.scope()).toEqual(["sdk"]);
  });

  it("downloads only over https from registry.npmjs.org", async () => {
    for (const name of [SDK, BIN])
      for (const bad of [url(name).replace("https:", "http:"), url(name).replace("registry.npmjs.org", "registry.example.com"), "https://registry.npmjs.org/other-package/-/other-package-0.9.9.tgz"]) {
        const c = companion({ resolved: { [name]: bad } });
        await expect(c.fetch()).rejects.toThrow(/refusing to download/);
        expect(c.urls).toEqual([]);
      }
  });
});

// The shipped preload options (inline sourcemap included), bundled into a temp folder, never dist/.
describe("per-window preloads", () => {
  it("bundle, and only the control panel's exposes invoke / the cmd channel", async () => {
    const out = mkdtempSync(join(tmpdir(), "familiar-preload-"));
    fixtures.push(out);
    const root = fileURLToPath(new URL("..", import.meta.url));
    const opts = preloadBuilds(root, out);
    expect(opts.map((o) => o.outfile)).toEqual(PRELOADS.map((n) => join(out, `preload-${n}.js`)));
    await Promise.all(opts.map((o) => build({ ...o, logLevel: "silent" })));
    const text = Object.fromEntries(PRELOADS.map((n) => [n, readFileSync(join(out, `preload-${n}.js`), "utf8")]));
    expect(text.control).toMatch(/\binvoke\b/);
    expect(text.control).toMatch(/"cmd"/);
    for (const n of ["overlay", "capture"]) {
      expect(text[n]).toMatch(/exposeInMainWorld/);
      expect(text[n]).not.toMatch(/invoke/);
      expect(text[n]).not.toMatch(/cmd/);
    }
  });
});

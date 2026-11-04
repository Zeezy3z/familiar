// Build the real identity entry, then run only that entry under Node. No Electron or agents.
import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
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

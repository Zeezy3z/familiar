// Build the real identity entry, then run only that entry under Node. No Electron or agents.
import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefine, buildIdentity } from "../scripts/build-identity.mjs";

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
    const dir = mkdtempSync(join(tmpdir(), "familiar-boot-"));
    fixtures.push(dir);
    for (const d of ["src", "scripts", "dist", "node_modules/electron"]) mkdirSync(join(dir, d), { recursive: true });
    copyFileSync(fileURLToPath(new URL("../boot.cjs", import.meta.url)), join(dir, "boot.cjs"));
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
    return { boot, touch };
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
});

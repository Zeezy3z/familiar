// Downloads Claude for the release download. The prebuilt FamiliarApp zip carries no Anthropic
// code (THIRD_PARTY_NOTICES.md): not the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) and not
// its Claude Code binary package (@anthropic-ai/claude-agent-sdk-<platform>-<arch>). On first run
// this fetches exactly the versions package-lock.json pins for this PC, from registry.npmjs.org
// only, checks each against the lockfile's sha512 integrity (fail closed) and unpacks them where
// npm would have (node_modules/@anthropic-ai/...), so the companion finds them as usual. The SDK's
// own dependencies stay in the zip. Nothing from the packages is run. Run Familiar.cmd starts this
// with the bundled Electron as Node:
//
//   set ELECTRON_RUN_AS_NODE=1
//   node_modules\electron\dist\electron.exe fetch-claude.cjs
//
// Exit 0: installed, or already there at the pinned versions. Exit 1: not installed (message on stderr).
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SDK = "@anthropic-ai/claude-agent-sdk";
const REGISTRY = "registry.npmjs.org";
// Windows' own bsdtar (System32), not whichever tar comes first on PATH (Git's GNU tar can't take C:\ paths).
const systemTar = () => (process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar");

/**
 * The lockfile's Claude packages npm would install on this PC: the SDK and the binary package for
 * this platform and CPU (os/cpu fields as npm reads them). Checked before anything is fetched.
 */
function pinned(root, platform = process.platform, arch = process.arch) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const pins = [];
  for (const [key, e] of Object.entries(lock.packages || {})) {
    const m = /^node_modules\/(@anthropic-ai\/claude-agent-sdk(?:-[^/]+)?)$/.exec(key);
    if (!m || (e.os && !e.os.includes(platform)) || (e.cpu && !e.cpu.includes(arch)) || (e.libc && !e.libc.includes("glibc"))) continue;
    const name = m[1];
    let url;
    try {
      url = new URL(e.resolved);
    } catch {
      throw new Error(`${name}: no valid download URL in package-lock.json`);
    }
    if (url.protocol !== "https:" || url.host !== REGISTRY || !url.pathname.startsWith(`/${name}/-/`)) throw new Error(`${name}: refusing to download from ${e.resolved} (only https://${REGISTRY})`);
    const sri = String(e.integrity || "").split(/\s+/).find((s) => s.startsWith("sha512-"));
    if (!sri) throw new Error(`${name}: package-lock.json has no sha512 integrity`);
    // The binary package must hold the executable; the SDK only its package.json is checked for.
    const exe = name === SDK ? undefined : platform === "win32" ? "claude.exe" : "claude";
    pins.push({ name, version: e.version, url: url.href, sha512: sri.slice(7), dir: path.join(root, "node_modules", ...name.split("/")), exe });
  }
  if (!pins.some((p) => p.name === SDK)) throw new Error(`package-lock.json pins no ${SDK}`);
  if (!pins.some((p) => p.exe)) throw new Error(`package-lock.json pins no Claude Code binary for ${platform}-${arch}`);
  return pins.sort((a, b) => (a.exe ? 1 : 0) - (b.exe ? 1 : 0)); // the SDK first: its manifest names the Claude Code version
}

/** dir holds package p, complete, at the pinned version. */
function holds(dir, p) {
  try {
    if (p.exe && !fs.statSync(path.join(dir, p.exe)).isFile()) return false;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return meta.name === p.name && meta.version === p.version;
  } catch {
    return false;
  }
}

/** The Claude Code version the SDK expects (its manifest), only for the progress line. */
function claudeVersion(...sdkDirs) {
  for (const d of sdkDirs) {
    try {
      return JSON.parse(fs.readFileSync(path.join(d, "manifest.json"), "utf8")).version;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** GET url into file. Redirects are refused: the registry serves its tarballs directly. */
function httpsDownload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60_000, headers: { "user-agent": "familiar-fetch-claude" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`${url}: HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers["content-length"]) || 0;
      let got = 0;
      onProgress(0, total);
      const out = fs.createWriteStream(file);
      res.on("data", (chunk) => {
        got += chunk.length;
        onProgress(got, total);
      });
      res.on("error", reject);
      out.on("error", reject);
      out.on("finish", () => (total && got !== total ? reject(new Error(`download ended early (${got} of ${total} bytes)`)) : resolve()));
      res.pipe(out);
    });
    req.on("timeout", () => req.destroy(new Error("no response from the npm registry for 60 s")));
    req.on("error", reject);
  });
}

function sha512(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha512");
    fs.createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("base64")));
  });
}

/** rename, retried for a few seconds: antivirus briefly locks a freshly written ~250 MB exe. */
async function rename(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

const mb = (n) => `${Math.max(1, Math.round(n / 2 ** 20))} MB`;

/**
 * @param {{ root: string, platform?: string, arch?: string, tar?: string, log?: (s: string) => void,
 *   download?: (url: string, file: string, onProgress: (got: number, total: number) => void) => Promise<void> }} o
 * @returns {Promise<"present" | "installed">}
 */
async function fetchClaude(o) {
  const log = o.log || ((s) => process.stdout.write(s));
  const todo = pinned(o.root, o.platform, o.arch).filter((p) => !holds(p.dir, p));
  if (!todo.length) return "present";

  const scope = path.join(o.root, "node_modules", "@anthropic-ai");
  fs.mkdirSync(scope, { recursive: true });
  // Working files sit beside the targets (same volume, so the final renames are moves, not
  // copies). Leftovers of an interrupted run go first.
  for (const n of fs.readdirSync(scope)) if (n.startsWith(".fetch-claude-")) fs.rmSync(path.join(scope, n), { recursive: true, force: true });
  const work = path.join(scope, `.fetch-claude-${process.pid}`);
  fs.mkdirSync(work);
  try {
    // Every package is downloaded, checked and unpacked before any is moved into place.
    const ready = [];
    for (const [i, p] of todo.entries()) {
      const tgz = path.join(work, `${i}.tgz`);
      const sdkDir = ready.find((r) => !r.p.exe)?.pkg;
      const label = p.exe ? `Claude Code ${claudeVersion(...[sdkDir, path.join(scope, "claude-agent-sdk")].filter(Boolean)) || p.version}` : `the Claude Agent SDK ${p.version}`;
      const tty = !!process.stdout.isTTY;
      let last = -1;
      await (o.download || httpsDownload)(p.url, tgz, (got, total) => {
        if (last === -1) log(`Downloading ${label} from npm${total ? ` (about ${mb(total)})` : ""}...\n`);
        if (!total) return void (last = 0);
        const pct = Math.floor((got * 100) / total);
        const shown = tty ? pct : pct - (pct % 25); // a console redraws one line; a log (CI) gets every 25 %
        if (shown !== last) log(tty ? `\r  ${pct}% of ${mb(total)}` : `  ${shown}%\n`);
        last = shown;
      });
      if (tty && last !== -1) log("\n");

      if ((await sha512(tgz)) !== p.sha512) throw new Error(`${p.name}@${p.version}: the download does not match package-lock.json's sha512 integrity; refused and deleted`);
      const unpack = path.join(work, `x${i}`);
      fs.mkdirSync(unpack);
      const r = spawnSync(o.tar || systemTar(), ["-x", "-z", "-f", tgz, "-C", unpack], { encoding: "utf8", windowsHide: true });
      if (r.status !== 0) throw new Error(`could not unpack ${p.name}: ${r.error ? r.error.message : String(r.stderr).trim().slice(0, 300)}`);
      fs.rmSync(tgz);
      const pkg = path.join(unpack, "package"); // npm tarballs keep everything under package/
      if (!holds(pkg, p)) throw new Error(`the tarball for ${p.name}@${p.version} does not hold that package${p.exe ? ` with ${p.exe}` : ""}`);
      ready.push({ p, pkg });
    }

    // Swap in: an older or half-copied folder goes aside first, so each target is either the old
    // folder or the complete new one.
    for (const [i, { p, pkg }] of ready.entries()) {
      const old = path.join(work, `old${i}`);
      if (fs.existsSync(p.dir)) await rename(p.dir, old);
      await rename(pkg, p.dir);
    }
    log(`Claude Code is ready (${ready.map(({ p }) => `${p.name}@${p.version}`).join(", ")}).\n`);
    return "installed";
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* removed by the next run */
    }
  }
}

module.exports = { fetchClaude, pinned };

if (require.main === module) {
  fetchClaude({ root: __dirname }).then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`Claude Code download failed: ${(e && e.message) || e}\n`, () => process.exit(1));
    },
  );
}

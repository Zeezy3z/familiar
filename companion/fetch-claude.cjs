// Downloads Claude Code for the release download. The prebuilt FamiliarApp zip does not carry
// Anthropic's Claude Code binary (THIRD_PARTY_NOTICES.md); on first run this fetches exactly the
// platform package package-lock.json pins, from registry.npmjs.org only, checks it against the
// lockfile's sha512 integrity (fail closed) and unpacks it where npm would have:
// node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/, so the Agent SDK finds it as usual.
// Nothing from the package is run. Run Familiar.cmd starts it with the bundled Electron as Node:
//
//   set ELECTRON_RUN_AS_NODE=1
//   node_modules\electron\dist\electron.exe fetch-claude.cjs
//
// Exit 0: installed, or already there at the pinned version. Exit 1: not installed (message on stderr).
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCOPE = "@anthropic-ai";
const REGISTRY = "registry.npmjs.org";
const exeName = (platform) => (platform === "win32" ? "claude.exe" : "claude");
// Windows' own bsdtar (System32), not whichever tar comes first on PATH (Git's GNU tar can't take C:\ paths).
const systemTar = () => (process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar");

/** The lockfile's entry for this platform's binary package, checked before anything is fetched. */
function pinned(root, platform = process.platform, arch = process.arch) {
  const name = `${SCOPE}/claude-agent-sdk-${platform}-${arch}`;
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const e = lock.packages && lock.packages[`node_modules/${name}`];
  if (!e) throw new Error(`package-lock.json pins no ${name}`);
  let url;
  try {
    url = new URL(e.resolved);
  } catch {
    throw new Error(`${name}: no valid download URL in package-lock.json`);
  }
  if (url.protocol !== "https:" || url.host !== REGISTRY || !url.pathname.startsWith(`/${name}/-/`)) throw new Error(`${name}: refusing to download from ${e.resolved} (only https://${REGISTRY})`);
  const sri = String(e.integrity || "").split(/\s+/).find((s) => s.startsWith("sha512-"));
  if (!sri) throw new Error(`${name}: package-lock.json has no sha512 integrity`);
  return { name, version: e.version, url: url.href, sha512: sri.slice(7), dir: path.join(root, "node_modules", ...name.split("/")), exe: exeName(platform) };
}

/** The Claude Code version the Agent SDK expects (its manifest), only for the progress line. */
function claudeVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "node_modules", SCOPE, "claude-agent-sdk", "manifest.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

function installedVersion(p) {
  try {
    if (!fs.statSync(path.join(p.dir, p.exe)).isFile()) return undefined;
    return JSON.parse(fs.readFileSync(path.join(p.dir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
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

const mb = (n) => `${Math.round(n / 2 ** 20)} MB`;

/**
 * @param {{ root: string, platform?: string, arch?: string, tar?: string, log?: (s: string) => void,
 *   download?: (url: string, file: string, onProgress: (got: number, total: number) => void) => Promise<void> }} o
 * @returns {Promise<"present" | "installed">}
 */
async function fetchClaude(o) {
  const log = o.log || ((s) => process.stdout.write(s));
  const p = pinned(o.root, o.platform, o.arch);
  if (installedVersion(p) === p.version) return "present";

  const parent = path.dirname(p.dir);
  fs.mkdirSync(parent, { recursive: true });
  // Working files sit beside the target (same volume, so the final rename is a move, not a copy).
  // Leftovers of an interrupted run go first.
  for (const n of fs.readdirSync(parent)) if (n.startsWith(".fetch-claude-")) fs.rmSync(path.join(parent, n), { recursive: true, force: true });
  const work = path.join(parent, `.fetch-claude-${process.pid}`);
  fs.mkdirSync(work);
  try {
    const tgz = path.join(work, "package.tgz");
    const label = `Claude Code ${claudeVersion(o.root) || `for Agent SDK ${p.version}`}`;
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

    const actual = await sha512(tgz);
    if (actual !== p.sha512) throw new Error(`${p.name}@${p.version}: the download does not match package-lock.json's sha512 integrity; refused and deleted`);

    const unpack = path.join(work, "x");
    fs.mkdirSync(unpack);
    const r = spawnSync(o.tar || systemTar(), ["-x", "-z", "-f", tgz, "-C", unpack], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) throw new Error(`could not unpack ${p.name}: ${r.error ? r.error.message : String(r.stderr).trim().slice(0, 300)}`);
    const pkg = path.join(unpack, "package"); // npm tarballs keep everything under package/
    const meta = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
    if (meta.name !== p.name || meta.version !== p.version) throw new Error(`the tarball holds ${meta.name}@${meta.version}, expected ${p.name}@${p.version}`);
    if (!fs.statSync(path.join(pkg, p.exe)).isFile()) throw new Error(`${p.exe} is missing from ${p.name}@${p.version}`);

    // Swap in: an older or half-copied folder goes aside first, so the target is either the old
    // folder or the complete new one.
    const old = path.join(work, "old");
    if (fs.existsSync(p.dir)) await rename(p.dir, old);
    await rename(pkg, p.dir);
    log(`Claude Code is ready (${p.name}@${p.version}).\n`);
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

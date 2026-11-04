// Checks a packaged app folder (electron-builder's release/win-unpacked) before anything is signed or
// published: no Anthropic Claude package anywhere in it, neither as files nor inside app.asar (the
// installed app downloads them on first run, fetch-claude.cjs), and the files that download needs.
//
//   node scripts/installer-check.mjs release/win-unpacked
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

/** Anthropic's proprietary packages: the Claude Agent SDK and its Claude Code binary packages
 * (as in prebuilt.mjs). @anthropic-ai/sdk, the MIT API client the SDK depends on, stays. */
const CLAUDE = /(^|[\\/])@anthropic-ai[\\/]claude-agent-sdk(-[^\\/]*)?([\\/]|$)|(^|[\\/])claude(\.exe)?$/i;
/** Inside app.asar: what the first-run download and the self-test read. */
const NEEDED = ["package.json", "self-test.cjs", "fetch-claude.cjs", "dist/main.js", "dist/claude-pins.json"];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) walk(p, out);
  }
  return out;
}

try {
  const dir = process.argv[2];
  if (!dir || !existsSync(join(dir, "resources", "app.asar"))) throw new Error("usage: installer-check.mjs <win-unpacked folder holding resources/app.asar>");
  const files = walk(dir).map((p) => relative(dir, p));
  const asar = join(dir, "resources", "app.asar");
  const inAsar = createRequire(import.meta.url)("@electron/asar").listPackage(asar, { isPack: false }).map((p) => p.replace(/^[\\/]/, "").split(/[\\/]/).join("/"));
  const found = [...files.filter((f) => CLAUDE.test(f)), ...inAsar.filter((f) => CLAUDE.test(f)).map((f) => `resources/app.asar/${f}`)];
  if (found.length) throw new Error(`the package must not contain Anthropic's Claude packages:\n  ${found.slice(0, 20).join("\n  ")}${found.length > 20 ? `\n  ... ${found.length - 20} more` : ""}`);
  const missing = NEEDED.filter((f) => !inAsar.includes(f));
  if (missing.length) throw new Error(`missing from app.asar: ${missing.join(", ")}`);
  const mb = (n) => `${(n / 2 ** 20).toFixed(0)} MB`;
  const total = files.reduce((t, f) => t + (statSync(join(dir, f)).isFile() ? statSync(join(dir, f)).size : 0), 0);
  console.log(`checked ${dir}: ${files.length} files (${mb(total)}), ${inAsar.length} entries in app.asar (${mb(statSync(asar).size)}); no Claude Agent SDK or Claude Code; ${NEEDED.join(", ")} present`);
} catch (e) {
  console.error(`installer-check: ${e.message}`);
  process.exit(1);
}

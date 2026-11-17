// esbuild options shared by build.mjs and the build tests (so tests bundle exactly what ships), and
// the build's file steps that the tests and the release checks share.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

// Source maps go beside each bundle (main.js.map), not inline: the packaged app and the release zip
// leave *.map out (electron-builder.yml, prebuilt.mjs), so players download no map.
export const common = { bundle: true, sourcemap: "linked", logLevel: "warning", target: "es2023" };
/** One preload per window: each exposes only the IPC its renderer uses (only control gets invoke). */
export const PRELOADS = ["control", "overlay", "capture"];
export const preloadBuilds = (root, outdir) =>
  PRELOADS.map((name) => ({ ...common, entryPoints: [join(root, `src/main/preload-${name}.ts`)], outfile: join(outdir, `preload-${name}.js`),
    platform: "node", format: "cjs", external: ["electron"] }));

/** Packages esbuild bundles into the app. They are devDependencies, so their own folders are never
 * packaged: each one's licence file(s) ship in dist/licenses/<package>/ instead. */
export const BUNDLED = ["marked", "dompurify", "highlight.js", "@agentclientprotocol/sdk", "@fontsource/marcellus"];
const LICENCE = /^(licen[cs]e|notice|copying)/i;
/** Copies every bundled package's licence files into <out>/licenses/<package>/; throws if one has none. */
export function copyLicenses(root, out) {
  for (const pkg of BUNDLED) {
    const dir = join(root, "node_modules", pkg);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => LICENCE.test(f)) : [];
    if (!files.length) throw new Error(`no licence file for ${pkg} (${dir})`);
    mkdirSync(join(out, "licenses", pkg), { recursive: true });
    for (const f of files) cpSync(join(dir, f), join(out, "licenses", pkg, f));
  }
}
/** The bundled packages with no licence file among `files` (paths relative to dist/, "/"-separated). */
export const missingLicenses = (files) => BUNDLED.filter((pkg) => !files.some((f) => f.startsWith(`licenses/${pkg}/`) && LICENCE.test(f.slice(`licenses/${pkg}/`.length))));

/** Puts the finished build `next` where `dist` was. The previous build is moved aside first and
 * comes back if the swap fails, so a failed build never leaves dist/ empty (boot.cjs starts it). */
export function swapIn(next, dist) {
  const old = `${dist}.old`;
  rmSync(old, { recursive: true, force: true });
  const had = existsSync(dist);
  if (had) renameSync(dist, old);
  try {
    renameSync(next, dist);
  } catch (e) {
    if (had) renameSync(old, dist);
    throw e;
  }
  rmSync(old, { recursive: true, force: true });
}

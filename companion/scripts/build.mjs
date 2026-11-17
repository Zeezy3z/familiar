// Bundles the companion: main + per-window preloads (node/cjs), renderers (browser/iife), and copies static files.
//   node scripts/build.mjs [out dir, default dist/]
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefine, buildIdentity } from "./build-identity.mjs";
import { common, copyLicenses, preloadBuilds, swapIn } from "./bundles.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ? resolve(process.argv[2]) : join(root, "dist");
const identity = buildIdentity(join(root, ".."));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Built into an empty sibling folder, so nothing an older build wrote (a renamed bundle, the old
// dist/preload.js) can ship, and swapped into place only once every step succeeded: a failed build
// leaves the previous one where it was (boot.cjs then starts it).
const up = relative(target, root);
if (!up || (!up.startsWith("..") && !isAbsolute(up))) throw new Error(`refusing to replace ${target}: it holds the companion`);
const dist = `${target}.next`;
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });

try {
await Promise.all([
  build({ ...common, entryPoints: [join(root, "src/main/main.ts")], outfile: join(dist, "main.js"), platform: "node", format: "cjs",
    // The app's version comes from package.json only (main.ts reads __FAMILIAR_VERSION__).
    define: { ...buildDefine(identity), __FAMILIAR_VERSION__: JSON.stringify(version) },
    external: ["electron", "koffi", "@anthropic-ai/claude-agent-sdk"] }),
  ...preloadBuilds(root, dist).map((o) => build(o)),
  build({ ...common, entryPoints: [join(root, "src/overlay/overlay.ts")], outfile: join(dist, "overlay.js"), platform: "browser", format: "iife" }),
  build({ ...common, entryPoints: [join(root, "src/capture/capture.ts")], outfile: join(dist, "capture.js"), platform: "browser", format: "iife" }),
  build({ ...common, entryPoints: [join(root, "src/control/control.ts")], outfile: join(dist, "control.js"), platform: "browser", format: "iife" }),
  build({ ...common, entryPoints: [join(root, "src/fakewow/fakewow.ts")], outfile: join(dist, "fakewow.js"), platform: "browser", format: "iife" }),
  build({ ...common, entryPoints: [join(root, "src/fakewow/fakewow-main.ts")], outfile: join(dist, "fakewow-main.js"), platform: "node", format: "cjs", external: ["electron"] }),
]);
for (const f of ["overlay/overlay.html", "overlay/overlay.css", "capture/capture.html", "control/control.html", "fakewow/fakewow.html"]) {
  cpSync(join(root, "src", f), join(dist, f.split("/")[1]));
}
cpSync(join(root, "node_modules/@fontsource/marcellus/files/marcellus-latin-400-normal.woff2"), join(dist, "assets/marcellus-latin-400-normal.woff2"));
// The familiar's painted face, the Quest Complete seals and the control panel's workshop header
// (src/assets/*.png, *.jpg): one file per expression, sized by CSS. Everything in src/assets ships;
// test/build.test.mjs pins the list and the 1 MB budget.
for (const f of readdirSync(join(root, "src/assets")).filter((n) => /\.(png|jpg)$/.test(n))) cpSync(join(root, "src/assets", f), join(dist, "assets", f));
// Tray icon: hand-tuned 16 px art plus a 32 px @2x that Electron picks on high-DPI displays.
cpSync(join(root, "..", "docs/media/icon-tray-16.png"), join(dist, "assets/tray.png"));
cpSync(join(root, "..", "docs/media/icon-tray-32.png"), join(dist, "assets/tray@2x.png"));
// For offline inspection / safe previews. The running main process uses its embedded literal,
// never this file, which may be replaced by a later build while that process is still running.
writeFileSync(join(dist, "build-info.json"), JSON.stringify(identity));
// What the installed app downloads on first run (fetch-claude.cjs pinsFrom): it has no
// package-lock.json, and its only platform is win32-x64 (electron-builder.yml).
const { pinned } = createRequire(import.meta.url)("../fetch-claude.cjs");
writeFileSync(join(dist, "claude-pins.json"), JSON.stringify(pinned(root, "win32", "x64").map(({ dir, ...pin }) => pin), null, 2) + "\n");
// The bundled packages' licences (their own folders are not packaged): fails the build if one is missing.
copyLicenses(root, dist);
} catch (e) {
  rmSync(dist, { recursive: true, force: true });
  throw e;
}
swapIn(dist, target);
console.log("built", target);

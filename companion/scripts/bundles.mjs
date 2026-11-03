// esbuild options shared by build.mjs and the build tests (so tests bundle exactly what ships).
import { join } from "node:path";

export const common = { bundle: true, sourcemap: "inline", logLevel: "warning", target: "es2023" };
/** One preload per window: each exposes only the IPC its renderer uses (only control gets invoke). */
export const PRELOADS = ["control", "overlay", "capture"];
export const preloadBuilds = (root, outdir) =>
  PRELOADS.map((name) => ({ ...common, entryPoints: [join(root, `src/main/preload-${name}.ts`)], outfile: join(outdir, `preload-${name}.js`),
    platform: "node", format: "cjs", external: ["electron"] }));

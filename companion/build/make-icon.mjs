// Writes build/icon.ico (16-256 px) for electron-builder from the painted sources in build/:
// icon-1024.png is the master; any other icon-<n>.png is a hand-tuned variant and every size up to
// n is drawn from the smallest variant that is at least that big (so icon-24.png serves 16/20/24,
// icon-64.png serves 32/40/48/64, and the master serves the rest). Resampling is done by Electron's
// Chromium (halving steps, then one high-quality pass), so no npm dependency is needed: run
// `node build/make-icon.mjs` from companion/ and it relaunches itself under the devDependency
// Electron binary. The .ico is committed. `--png <dir>` also writes icon-<size>.png per size.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

if (!process.versions.electron) {
  // Plain Node: hand over to Electron (the only renderer available) with the same arguments.
  const electron = createRequire(import.meta.url)("electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env });
  process.exit(r.status ?? 1);
}

const { app, BrowserWindow } = await import("electron");

/** Source PNGs by their pixel size, from build/icon-<n>.png. */
function sources() {
  const out = new Map();
  for (const f of readdirSync(HERE)) {
    const m = /^icon-(\d+)\.png$/.exec(f);
    if (m) out.set(Number(m[1]), "data:image/png;base64," + readFileSync(join(HERE, f)).toString("base64"));
  }
  if (!out.size) throw new Error("no build/icon-<n>.png sources");
  return out;
}

/** The smallest source at least `size` px (else the largest). */
function sourceFor(size, srcs) {
  const sizes = [...srcs.keys()].sort((a, b) => a - b);
  return sizes.find((n) => n >= size) ?? sizes[sizes.length - 1];
}

/** Page that resamples a PNG data URL to `size` and returns straight-alpha RGBA as base64. */
const PAGE = `data:text/html,<!doctype html><meta charset="utf-8"><script>
  window.render = async (src, size) => {
    const img = new Image();
    await new Promise((res, rej) => ((img.onload = res), (img.onerror = () => rej(new Error("png failed to load")), (img.src = src))));
    // Halve until the next step would go below 2x the target, then one high-quality pass: a single
    // 1024 -> 16 resample drops most of the pixels, this keeps the brushwork's edges.
    let cur = img, w = img.width;
    while (w / 2 >= size * 2) {
      w = Math.round(w / 2);
      const c = document.createElement("canvas"); c.width = c.height = w;
      const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high";
      ctx.drawImage(cur, 0, 0, w, w); cur = c;
    }
    const c = document.createElement("canvas"); c.width = c.height = size;
    const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cur, 0, 0, size, size);
    const d = ctx.getImageData(0, 0, size, size).data;
    let s = "";
    for (let i = 0; i < d.length; i += 0x2000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x2000));
    return btoa(s);
  };
</script>`;

/** Returns Map<size, RGBA Buffer> for the given sizes. Call after `ready`. */
async function rasterise(sizes = SIZES) {
  const srcs = sources();
  const win = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { offscreen: true } });
  await win.loadURL(PAGE);
  const out = new Map();
  for (const s of sizes) {
    const n = sourceFor(s, srcs);
    const b64 = await win.webContents.executeJavaScript(`render(${JSON.stringify(srcs.get(n))}, ${s})`);
    out.set(s, Buffer.from(b64, "base64"));
    console.log(`${s} px <- icon-${n}.png`);
  }
  win.destroy();
  return out;
}

function png(s, rgba) {
  const raw = Buffer.alloc(s * (s * 4 + 1));
  for (let y = 0; y < s; y++) {
    raw[y * (s * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (s * 4 + 1) + 1, y * s * 4, (y + 1) * s * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Classic 32-bit DIB entry (bottom-up BGRA, straight alpha, empty AND mask): what NSIS and old shells read. */
function dib(s, rgba) {
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(s, 4);
  head.writeInt32LE(s * 2, 8); // XOR + AND masks
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(s * s * 4, 20);
  const xor = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const o = ((s - 1 - y) * s + x) * 4;
      xor[o] = rgba[i + 2];
      xor[o + 1] = rgba[i + 1];
      xor[o + 2] = rgba[i];
      xor[o + 3] = rgba[i + 3];
    }
  const and = Buffer.alloc(Math.ceil(s / 32) * 4 * s);
  return Buffer.concat([head, xor, and]);
}

function ico(frames) {
  const images = SIZES.map((s) => (s === 256 ? png(s, frames.get(s)) : dib(s, frames.get(s))));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(SIZES.length, 4);
  let offset = 6 + 16 * SIZES.length;
  const dir = SIZES.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s === 256 ? 0 : s;
    e[1] = s === 256 ? 0 : s;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...images]);
}

// Not `await app.whenReady()` at top level: with an ESM entry Electron emits `ready` only after
// the module graph has finished evaluating, so a top-level await on it never returns.
app.whenReady().then(async () => {
  try {
    const frames = await rasterise();
    const out = join(HERE, "icon.ico");
    const bytes = ico(frames);
    writeFileSync(out, bytes);
    console.log("wrote", out, bytes.length, "bytes");
    const at = process.argv.indexOf("--png");
    if (at > 0 && process.argv[at + 1]) {
      const dir = resolve(process.argv[at + 1]);
      mkdirSync(dir, { recursive: true });
      for (const [s, rgba] of frames) writeFileSync(join(dir, `icon-${s}.png`), png(s, rgba));
      console.log("wrote", frames.size, "png previews to", dir);
    }
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});

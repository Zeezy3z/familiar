// Writes build/icon.ico (16-256 px) for electron-builder: the tray icon's violet orb (main.ts
// trayIcon), drawn at each size with an anti-aliased edge. The repo has no other app art.
// Regenerate with `node build/make-icon.mjs` from companion/; the .ico is committed.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Straight-alpha BGRA pixels, top row first. Same colours as the tray icon, scaled to `s`. */
function orb(s) {
  const px = Buffer.alloc(s * s * 4);
  const c = (s - 1) / 2;
  const r = (7 / 16) * s;
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, r - d + 0.5)); // 1 px soft edge
      if (!a) continue;
      const glow = Math.max(0, 1 - d / r);
      const o = (y * s + x) * 4;
      px[o] = 255; // B
      px[o + 1] = Math.round(90 + 80 * glow); // G
      px[o + 2] = Math.round(150 + 100 * glow); // R
      px[o + 3] = Math.round(255 * a);
    }
  return px;
}

function png(s, bgra) {
  const raw = Buffer.alloc(s * (s * 4 + 1));
  for (let y = 0; y < s; y++) {
    raw[y * (s * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const o = y * (s * 4 + 1) + 1 + x * 4;
      raw[o] = bgra[i + 2];
      raw[o + 1] = bgra[i + 1];
      raw[o + 2] = bgra[i];
      raw[o + 3] = bgra[i + 3];
    }
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
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Classic 32-bit DIB entry (bottom-up BGRA + empty AND mask): what NSIS and old shells read. */
function dib(s, bgra) {
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(s, 4);
  head.writeInt32LE(s * 2, 8); // XOR + AND masks
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(s * s * 4, 20);
  const xor = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) bgra.copy(xor, (s - 1 - y) * s * 4, y * s * 4, (y + 1) * s * 4);
  const and = Buffer.alloc((Math.ceil(s / 32) * 4) * s);
  return Buffer.concat([head, xor, and]);
}

const images = SIZES.map((s) => (s === 256 ? png(s, orb(s)) : dib(s, orb(s))));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
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
const out = join(dirname(fileURLToPath(import.meta.url)), "icon.ico");
writeFileSync(out, Buffer.concat([header, ...dir, ...images]));
console.log("wrote", out, offset, "bytes");

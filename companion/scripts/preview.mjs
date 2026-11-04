// Read-only visual QA of the actual built renderers. No Electron, game capture, IPC, or agents.
// Build first, then: node scripts/preview.mjs; open http://127.0.0.1:47812
// FAMILIAR_PREVIEW_PORT moves it (parallel worktrees, or a second server beside a running one).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.FAMILIAR_PREVIEW_PORT) || 47812;
const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const allowed = new Set(["control.html", "control.js", "overlay.html", "overlay.js", "overlay.css", "assets/marcellus-latin-400-normal.woff2"]);
const types = { html: "text/html", js: "text/javascript", css: "text/css", woff2: "font/woff2", png: "image/png", jpg: "image/jpeg" };
const isAsset = (file) => /^assets\/[a-z0-9@-]+\.(png|jpg)$/.test(file); // the painted faces, seals and workshop header (no path segments, so no traversal)
createServer((req, res) => {
  const file = new URL(req.url, "http://localhost").pathname.slice(1) || "control.html";
  res.setHeader("Cache-Control", "no-store");
  if (file === "preview-fixtures.js") {
    res.setHeader("Content-Type", "text/javascript");
    const identity = JSON.parse(readFileSync(join(dist, "build-info.json"), "utf8"));
    return res.end(`window.previewBuild = ${JSON.stringify(identity)};\n` + readFileSync(new URL("preview-fixtures.js", import.meta.url)));
  }
  if (!allowed.has(file) && !isAsset(file)) { res.writeHead(404); return res.end("Not found"); }
  try {
    let body = readFileSync(join(dist, file));
    if (file.endsWith(".html")) body = body.toString().replace('<script src=', '<script src="preview-fixtures.js"></script><script src=');
    res.setHeader("Content-Type", types[file.split(".").pop()] || "application/octet-stream");
    res.end(body);
  } catch { res.writeHead(500); res.end("Run node scripts/build.mjs first."); }
}).listen(port, "127.0.0.1", () => console.log(`Synthetic Familiar preview: http://127.0.0.1:${port} (Ctrl+C to stop)`));

// Read-only visual QA of the actual built renderers. No Electron, game capture, IPC, or agents.
// Build first, then: node scripts/preview.mjs; open http://127.0.0.1:47812
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const allowed = new Set(["control.html", "control.js", "overlay.html", "overlay.js", "overlay.css", "assets/marcellus-latin-400-normal.woff2"]);
const types = { html: "text/html", js: "text/javascript", css: "text/css", woff2: "font/woff2" };
createServer((req, res) => {
  const file = new URL(req.url, "http://localhost").pathname.slice(1) || "control.html";
  res.setHeader("Cache-Control", "no-store");
  if (file === "preview-fixtures.js") {
    res.setHeader("Content-Type", "text/javascript");
    const identity = JSON.parse(readFileSync(join(dist, "build-info.json"), "utf8"));
    return res.end(`window.previewBuild = ${JSON.stringify(identity)};\n` + readFileSync(new URL("preview-fixtures.js", import.meta.url)));
  }
  if (!allowed.has(file)) { res.writeHead(404); return res.end("Not found"); }
  try {
    let body = readFileSync(join(dist, file));
    if (file.endsWith(".html")) body = body.toString().replace('<script src=', '<script src="preview-fixtures.js"></script><script src=');
    res.setHeader("Content-Type", types[file.split(".").pop()] || "application/octet-stream");
    res.end(body);
  } catch { res.writeHead(500); res.end("Run node scripts/build.mjs first."); }
}).listen(47812, "127.0.0.1", () => console.log("Synthetic Familiar preview: http://127.0.0.1:47812 (Ctrl+C to stop)"));

// Launches the FakeWoW stand-in window: `electron dist/fakewow-main.js [--minutes N]`.
import { app, BrowserWindow, dialog } from "electron";
import * as path from "node:path";
import { devEnabled, serveDevHooks } from "../main/dev-hooks";

dialog.showErrorBox = (t, c) => console.error("[fakewow]", t, c);
// Keep presenting frames while covered by other windows (real WoW keeps rendering in background).
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
process.on("uncaughtException", (e) => console.error("[fakewow]", e));
const minutes = Number(process.argv[process.argv.indexOf("--minutes") + 1]) || 20;
setTimeout(() => app.exit(0), minutes * 60_000);

app.whenReady().then(() => {
  const w = new BrowserWindow({
    width: 1400,
    height: 860,
    x: 80,
    y: 60,
    title: "FakeWoW",
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  w.loadFile(path.join(__dirname, "fakewow.html"));
  w.on("page-title-updated", (e) => e.preventDefault());
  // Test hook (FAMILIAR_DEV=1 only; 127.0.0.1; per-run token): POST /eval with a JS expression
  // evaluated in the page (uses window.fake).
  if (devEnabled())
    serveDevHooks(
      47811,
      async (url, body) => {
        if (url !== "/eval") return { ok: false, error: "unknown" };
        try {
          return { ok: true, out: await w.webContents.executeJavaScript(body) };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },
      (s) => console.log("[fakewow]", s),
    ).catch((e) => console.error("[fakewow]", e));
});
app.on("window-all-closed", () => app.quit());

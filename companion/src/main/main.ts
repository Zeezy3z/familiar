// Familiar companion — Electron main process.
//   WoW window (pixels) --capture--> Runestrip decoder --> Hub --> agents (Claude / Codex)
//   Hub --> render model --> Glass overlay (click-through window aligned over the game)
// Account-safety rule: we only READ the game's pixels and draw our own window above it.
// No input, messages or focus changes are ever sent to the game process.
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpBackend } from "../agents/acp";
import { ClaudeBackend } from "../agents/claude";
import { CodexBackend } from "../agents/codex";
import { hermesCatalog } from "../agents/hermes";
import { DEFAULT_ACP_PROVIDERS, providerInfo, registerProvider } from "../agents/providers";
import { providerSetup, startLogin } from "../agents/setup";
import type { AgentBackend, Mode } from "../agents/types";
import { MODES } from "../agents/types";
import { resolveCommand } from "../agents/which";
import { claudeDownloadError, claudeExePath, claudeHome, claudeRoute, claudeStatus, companionDir, downloadClaude, type ClaudeFetch } from "../agents/claude-download";
import { appDataDir, DEFAULT_CONFIG, loadConfig, saveConfig } from "../hub/config";
import { FONT_MAX, FONT_MIN, Hub, type Toast } from "../hub/hub";
import { buildModel } from "../hub/viewmodel";
import { activity } from "../hub/activity";
import { isIssueUrl, suggestionUrl, type SuggestVersions } from "../hub/suggest";
import {
  clientRectOnScreen,
  extendedFrameBounds,
  findGameWindow,
  foregroundKey,
  GameWindow,
  hwndFromBuffer,
  hwndKey,
  isMinimized,
  isWindow,
  makeToolWindow,
  reassertTopmost,
  Rect,
  cursorPos,
  leftButtonDown,
  mouseButtonDown,
  keyDown,
  rightButtonDown,
  windowsAbove,
} from "./win32";
import { RefusalLog, screenCaptureTrusted, stripScreenBox, type Verdict } from "./capture-gate";
import { bindingToVk, corroborateClick, corroborateKey, NO_PROOF, PressLog, Proof, Rect as ClientRect, TRUSTED } from "./physical";
import { Drag, dragLayout, dragZone, LogMemo, logLayout, rememberLog } from "./geometry";
import { findWowInstall, installAddon, interfaceCheck, SnapshotWriter, tocInterfaces, uninstallAddon, WowInstall } from "./wow";
import { RUNNING_BUILD } from "./build";
import { devEnabled, serveDevHooks } from "./dev-hooks";
import { changedConfigKeys, describeAddonMessage, describeOverlayAction, diagnosticsText, logLine, redact, rotateLog } from "./log-file";
import { linkDoctor } from "./doctor";
import { trayNoticeFor } from "./notices";
import type { CheckUpdate } from "./update";

const VERSION = "0.2.0";

// ---- installed build (electron-builder) --------------------------------------------------------
// Packaged-only: a source run (electron.exe <companion dir>, via boot.cjs) skips all of this.
const PACKAGED = app.isPackaged;
companionDir.packaged = PACKAGED; // where Claude lives (claude-download.ts claudeHome)
/** The addon the companion installs: the repo's copy, or the installer's under resources\. */
const REPO_ADDON = PACKAGED ? path.join(process.resourcesPath, "addon", "Familiar") : path.resolve(__dirname, "..", "..", "addon", "Familiar");
if (PACKAGED) {
  delete process.env.FAMILIAR_DEV; // dev/test hooks never exist in an installed build
  // The source run's Chromium profile (%APPDATA%\<package.json name>), so both hold the same
  // single-instance lock and never run side by side, and Chromium's caches stay out of the
  // %APPDATA%\Familiar config folder (the packaged default, from productName).
  app.setPath("userData", path.join(app.getPath("appData"), "familiar-companion"));
  app.setAppUserModelId("io.github.zeezy3z.familiar"); // = appId in electron-builder.yml
  if (process.argv.includes("--self-test")) selfTestAndExit();
}

/** `Familiar.exe --self-test` (CI, on win-unpacked): before the log, the lock, the addon install
 * and the startup entry. Prints the checks to stdout and exits 0 (all ok) or 1. */
function selfTestAndExit(): never {
  let ok = false;
  let lines: string[];
  try {
    const appRoot = path.resolve(__dirname, "..");
    const { selfTest } = require(path.join(appRoot, "self-test.cjs"));
    // Claude Code is downloaded on first run (claudeHome()); the self-test skips it until then.
    ({ ok, lines } = selfTest({ appRoot, addonDir: REPO_ADDON, claudeExe: claudeExePath(), claudeHome: claudeHome() }));
  } catch (e: any) {
    lines = ["FAIL self-test: " + (e?.stack ?? e)];
  }
  try {
    fs.writeSync(1, [`Familiar ${VERSION} self-test`, ...lines, ok ? "PASS" : "FAIL"].join("\n") + "\n");
  } catch {
    /* no stdout: the exit code still says it */
  }
  process.exit(ok ? 0 : 1);
}

// ---- never show Electron error dialogs; log instead ------------------------------------------
const logFile = path.join(appDataDir(), "familiar.log");
rotateLog(logFile);
const logRing: string[] = [];
// Every line is redacted here (home folder, usernames, keys, tokens; see log-file.ts) before it
// reaches the ring, the file or the control panel.
function log(s: string) {
  const line = logLine(redact(s));
  logRing.push(line);
  if (logRing.length > 400) logRing.shift();
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {
    /* ignore */
  }
  control?.webContents.send("log", line);
}
dialog.showErrorBox = (title, content) => log(`[suppressed dialog] ${title}: ${content}`);
process.on("uncaughtException", (e) => log("[uncaught] " + (e?.stack ?? e)));
process.on("unhandledRejection", (e: any) => log("[unhandled] " + (e?.stack ?? e)));

// The capture/overlay renderers must keep running while hidden or covered.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
// Starting Familiar again while it runs (Start menu, Run Familiar.cmd) opens the control panel.
app.on("second-instance", () => {
  if (app.isReady()) createControl();
});

const ROOT = path.resolve(__dirname, ".."); // companion/
const DIST = __dirname;

let overlay: BrowserWindow | null = null;
let capture: BrowserWindow | null = null;
let control: BrowserWindow | null = null;
let cfg = loadConfig(log); // after `control`, which log() reads
let tray: Tray | null = null;
let hub: Hub;
let install: WowInstall | null = null;
/** Why no install is known (from findWowInstall), shown in the control panel. */
let installError: string | undefined;
let installNotes: string[] = [];
/** A Wow*.exe window running from a folder that is not the Forever client: watched, never linked. */
let wrongClient: { hwnd: GameWindow["hwnd"]; key: string; exe: string; dir: string } | null = null;
let snapshot: SnapshotWriter;

// Game / link state
let game: GameWindow | null = null;
let lastFind = 0;
let client: Rect | null = null;
let frameRect: Rect | null = null;
let fg = "0";
let minimized = false;
let layout: any = null;
/** Where the quest log sat in the last layout that showed it (to predict expanding it). */
let logMemo: LogMemo | undefined;
let captureStats: any = {};
let lastMsgAt = 0;
let overlayKey = "0";
let overlayShown = false;
/** When the Glass last turned visible: a decision key needs it showing for 400 ms (it was seen). */
let overlayShownAt = 0;
let paused = false;
let captureStarted = false;
let lastCaptureTry = 0;
let lastGeomChange = 0;
// Window capture (WGC on the game window) is primary; if it never locks we fall back to capturing
// the monitor the game is on (needs the game visible) and alternate every 15 s until one locks.
let captureMode: "window" | "screen" = process.env.FAMILIAR_CAPTURE === "screen" ? "screen" : "window";
let captureStartedAt = 0;
let nextScreenTryAt = 0;

const linked = () => Date.now() - (captureStats.lastOk ?? 0) < 3000;

/** Each window gets its own preload exposing only the IPC its page uses (only control gets cmd). */
function webPrefs(page: "control" | "overlay" | "capture") {
  return {
    preload: path.join(DIST, `preload-${page}.js`),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
  };
}

// ---- windows ------------------------------------------------------------------------------------
/** Our pages never navigate, open windows or host webviews; refuse all three. */
function harden(win: BrowserWindow) {
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
/** IPC sender allowlist: each channel answers only the window that legitimately uses it. */
const from = (e: { sender: Electron.WebContents }, w: BrowserWindow | null) => !!w && !w.isDestroyed() && e.sender === w.webContents;

function createOverlay() {
  overlay = new BrowserWindow({
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: "#00000000",
    title: "Familiar Glass",
    webPreferences: webPrefs("overlay"),
  });
  harden(overlay);
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setIgnoreMouseEvents(true);
  overlay.loadFile(path.join(DIST, "overlay.html"));
  const h = hwndFromBuffer(overlay.getNativeWindowHandle());
  overlayKey = hwndKey(h);
  try {
    makeToolWindow(h);
  } catch (e) {
    log("[overlay] style: " + e);
  }
  overlay.webContents.on("did-finish-load", () => pushAll());
}

function createCapture() {
  capture = new BrowserWindow({ show: false, width: 320, height: 200, title: "Familiar capture", webPreferences: webPrefs("capture") });
  harden(capture);
  capture.loadFile(path.join(DIST, "capture.html"));
  capture.webContents.on("did-finish-load", () => {
    captureStarted = false; // (re)start on the next tick
  });
}

function createControl() {
  if (control && !control.isDestroyed()) {
    control.show();
    control.focus();
    return;
  }
  control = new BrowserWindow({
    width: 760,
    height: 640,
    title: "Familiar",
    backgroundColor: "#0b0a0d",
    autoHideMenuBar: true,
    webPreferences: webPrefs("control"),
  });
  harden(control);
  control.loadFile(path.join(DIST, "control.html"));
  control.on("closed", () => (control = null));
}

function trayIcon() {
  const s = 16;
  const buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      const o = (y * s + x) * 4;
      if (d < 7) {
        const glow = 1 - d / 7;
        buf[o] = 255; // B
        buf[o + 1] = Math.round(90 + 80 * glow); // G
        buf[o + 2] = Math.round(150 + 100 * glow); // R
        buf[o + 3] = 255;
      }
    }
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("Familiar");
  const menu = () =>
    Menu.buildFromTemplate([
      { label: "Open Familiar", click: () => createControl() },
      { label: paused ? "Resume overlay" : "Pause overlay", click: () => ((paused = !paused), updateVisibility(), tray?.setContextMenu(menu())) },
      { label: "Reinstall addon", click: () => doInstall(true) },
      { type: "separator" },
      { label: "Uninstall Familiar…", click: () => uninstall().catch((e) => log("[uninstall] " + e)) },
      { label: "Quit", click: () => app.quit() },
    ]);
  tray.setContextMenu(menu());
  tray.on("click", () => createControl());
  tray.on("balloon-click", () => createControl()); // the player's own click on the notice
}

// ---- game tracking ------------------------------------------------------------------------------
function tick() {
  const now = Date.now();
  if (game && !isWindow(game.hwnd)) {
    log(`[wow] window closed (${game.exe})`);
    game = null;
    client = frameRect = null;
    captureStarted = false;
    capture?.webContents.send("stop", null);
    updateVisibility();
  }
  if (!game) {
    if (now - lastFind < 2000) return;
    lastFind = now;
    if (wrongClient && !isWindow(wrongClient.hwnd)) wrongClient = null;
    game = findGameWindow();
    if (!game) return;
    // Another client (retail, Anniversary...) next to a known Forever install: never wake or link to it.
    const exeDir = game.path ? path.dirname(game.path) : "";
    if (install && exeDir && !process.env.FAMILIAR_TARGET_TITLE && !sameFolder(exeDir, install.dir)) {
      if (wrongClient?.key !== game.key) {
        wrongClient = { hwnd: game.hwnd, key: game.key, exe: game.exe, dir: exeDir };
        log(`[wow] WoW running from ${exeDir} is not the Forever client; ignoring`);
      }
      game = null;
      return;
    }
    wrongClient = null;
    log(`[wow] found ${game.exe} "${game.title}" class=${game.cls}`);
    hub.wake().catch((e) => log("[hub] wake: " + e));
    // No install known yet: the running game's own folder is the install (doInstall probes with its exe path).
    if (!install) doInstall(false);
  }
  minimized = isMinimized(game.hwnd);
  fg = foregroundKey();
  const c = clientRectOnScreen(game.hwnd);
  const f = extendedFrameBounds(game.hwnd);
  if (c && (!client || c.x !== client.x || c.y !== client.y || c.width !== client.width || c.height !== client.height)) {
    client = c;
    placeOverlay();
  }
  if (f) {
    const resized = !frameRect || f.width !== frameRect.width || f.height !== frameRect.height;
    const moved = !frameRect || f.x !== frameRect.x || f.y !== frameRect.y;
    frameRect = f;
    if (resized || moved) lastGeomChange = now;
    if (captureMode === "screen" && moved && captureStarted) captureStarted = false; // client offset changed
    // Wait until a resize/move settles before (re)starting the pinned-size capture stream.
    if ((resized || !captureStarted) && now - lastGeomChange < 400) {
      if (resized) captureStarted = false;
      updateVisibility();
      return;
    }
    // Only fall back after 15 s with no decoded frame at all (a /reload's loading screen is shorter).
    if (captureStarted && now - (captureStats.lastOk ?? 0) > 15000 && now - captureStartedAt > 15000 && fg === game.key) {
      // No strip yet (e.g. character select, addon disabled, or window capture failing): try the
      // monitor once, then back off for 2 minutes so we don't burn CPU on 4K screen capture.
      if (captureMode === "window" && now >= nextScreenTryAt) {
        captureMode = "screen";
        nextScreenTryAt = now + 120_000;
        log("[capture] no Runestrip lock for 15 s via window capture; trying screen capture");
        captureStarted = false;
        lastCaptureTry = 0;
      } else if (captureMode === "screen") {
        captureMode = "window";
        log("[capture] screen capture found no Runestrip either; back to window capture");
        captureStarted = false;
        lastCaptureTry = 0;
      }
    }
    // The capture stream is pinned to the frame size, so restart it whenever the window resizes.
    if (!minimized && (resized || (!captureStarted && now - lastCaptureTry > 2000))) {
      captureStarted = true;
      lastCaptureTry = now;
      startCapture().catch((e) => log("[capture] " + e));
    }
  }
  updateVisibility();
}

async function startCapture() {
  if (!game || !frameRect || !client || !capture) return;
  captureStartedAt = Date.now();
  if (captureMode === "screen") return startScreenCapture();
  const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
  const id = `window:${game.key}:0`;
  const src = sources.find((s) => s.id === id) ?? sources.find((s) => s.id.startsWith(`window:${game!.key}:`));
  if (!src) {
    log(`[capture] no desktopCapturer source for ${id}`);
    captureStarted = false;
    return;
  }
  const cfgMsg = {
    sourceId: src.id,
    w: frameRect.width,
    h: frameRect.height,
    fps: 30,
    clientX: client.x - frameRect.x,
    clientY: client.y - frameRect.y,
  };
  log(`[capture] start ${src.id} ${cfgMsg.w}x${cfgMsg.h} client@${cfgMsg.clientX},${cfgMsg.clientY}`);
  capture.webContents.send("start", cfgMsg);
}

/** The monitor screen capture records for the game, and its top-left in physical px (frame origin). */
const gameDisplay = (c: Rect) => screen.getDisplayMatching(screen.screenToDipRect(null, c));
const displayOrigin = (d: Electron.Display) => ({ x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor) });

/** In screen-capture mode the frame is the whole monitor: strip messages count only while the game
 * (or our Glass) is in front and no other window sits over the strip (capture-gate.ts). */
const screenRefusals = new RefusalLog(5000);
function screenGate(): Verdict {
  if (captureMode !== "screen") return { ok: true };
  const lock = captureStats.lock as { x: number; y: number; pitch: number } | null | undefined;
  const strip = lock && client ? stripScreenBox(lock, displayOrigin(gameDisplay(client))) : null;
  const foreground = foregroundKey();
  const inFront = !!game && (foreground === game.key || foreground === overlayKey);
  const ours = overlay && !overlay.isDestroyed() ? [hwndFromBuffer(overlay.getNativeWindowHandle())] : [];
  const covering = game && strip && inFront ? windowsAbove(game.hwnd, strip, ours) : null;
  return screenCaptureTrusted({ captureMode, foreground, game: game?.key ?? null, overlay: overlayKey, strip, covering });
}

async function startScreenCapture() {
  if (!client || !capture) return;
  const disp = gameDisplay(client);
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
  const src = sources.find((x) => x.display_id === String(disp.id));
  if (!src) {
    log("[capture] no screen source for display " + disp.id);
    captureStarted = false;
    return;
  }
  const w = Math.round(disp.size.width * disp.scaleFactor);
  const h = Math.round(disp.size.height * disp.scaleFactor);
  const o = displayOrigin(disp);
  const cfgMsg = { sourceId: src.id, w, h, fps: 30, clientX: client.x - o.x, clientY: client.y - o.y };
  log(`[capture] start screen ${src.id} ${w}x${h} client@${cfgMsg.clientX},${cfgMsg.clientY}`);
  capture.webContents.send("start", cfgMsg);
}

function placeOverlay() {
  if (!overlay || !client) return;
  const dip = screen.screenToDipRect(overlay, client);
  overlay.setBounds(dip);
  overlay.setBounds(screen.screenToDipRect(overlay, client)); // second pass settles mixed-DPI moves
}

function overlayNeeded(model?: ReturnType<typeof buildModel>) {
  if (!layout || layout.ui === false) return false;
  const m = model ?? lastModel;
  return !!(layout.panel || (layout.tracker && m?.tracker.length) || m?.toasts.length);
}

function updateVisibility() {
  if (!overlay) return;
  const gameActive = !!game && !minimized && (fg === game.key || fg === overlayKey);
  const want = !paused && gameActive && linked() && overlayNeeded();
  if (want !== overlayShown) {
    overlayShown = want;
    if (want) {
      overlayShownAt = Date.now();
      placeOverlay();
      // The window stays up once shown; "hidden" is full transparency (click-through either way),
      // so coming back (Alt-Tab) is instant instead of a repaint from scratch.
      if (!overlay.isVisible()) overlay.showInactive();
      try {
        reassertTopmost(hwndFromBuffer(overlay.getNativeWindowHandle()));
      } catch {
        /* ignore */
      }
    }
    overlay.webContents.send("vis", { visible: want, devInput: devEnabled() });
  }
}

let lastFg = "0";
setInterval(() => {
  if (fg !== lastFg) {
    lastFg = fg;
    if (overlayShown && overlay) {
      try {
        reassertTopmost(hwndFromBuffer(overlay.getNativeWindowHandle()));
      } catch {
        /* ignore */
      }
    }
  }
}, 250);

// ---- addon messages -----------------------------------------------------------------------------
function onAddonMessages(msgs: any[]) {
  lastMsgAt = Date.now();
  for (const m of msgs) {
    switch (m.t) {
      case "layout":
        // Every layout says whether the character is in combat (PLAYER_REGEN_*): notices wait for it.
        hub.setCombat(!!m.combat);
        if (client && m.scr && (Math.abs(m.scr[0] - client.width) > client.width * 0.02 || Math.abs(m.scr[1] - client.height) > client.height * 0.02)) {
          if (!layout || layout.scr?.[0] !== m.scr[0]) log(`[layout] WoW reports ${m.scr[0]}x${m.scr[1]} but the window client is ${client.width}x${client.height}; Glass scales to fit`);
        }
        // Mid-drag layouts (periodic refresh, OnSizeChanged) are older than the cursor: ignore them;
        // the exact one follows the addon's dragstop.
        if (drag) break;
        layout = m;
        logMemo = rememberLog(m) ?? logMemo;
        overlay?.webContents.send("layout", m);
        updateVisibility();
        break;
      case "logtoggle":
        // The Log button: show the window's new shape now; the exact layout follows.
        if (!drag && layout?.win && Array.isArray(m.rect)) {
          layout = logLayout(layout, !!m.collapsed, m.rect, logMemo);
          overlay?.webContents.send("layout", layout);
        }
        break;
      case "dragstart":
        startDrag(m);
        break;
      case "dragstop":
        endDrag("dragstop");
        break;
      case "click": {
        // Hit-test where the mouse really was, and only let the resulting overlay action approve
        // anything if a physical release on that region backs this message (physical.ts).
        const rect = (["list", "detail", "tracker", "status"].includes(m.r) ? layout?.[m.r] : undefined) as ClientRect | undefined;
        const proof = corroborateClick(presses, rect, typeof m.x === "number" && typeof m.y === "number" ? { x: m.x, y: m.y } : undefined, Date.now(), toClient);
        if (proof.ok) {
          m.x = proof.x;
          m.y = proof.y;
        }
        log(`[addon] click ${m.r} ${m.x},${m.y} ${m.b} ${proof.ok ? "corroborated" : "unverified: " + proof.why}`);
        clickProof = { at: Date.now(), proof };
        overlay?.webContents.send("input", m);
        break;
      }
      case "wheel":
        overlay?.webContents.send("input", m); // not logged: one line per tick, written on this thread
        break;
      case "hover":
        overlay?.webContents.send("input", m);
        break;
      default:
        if (m.t === "error") log(`[addon] LUA ERROR in ${m.where}: ${m.err}`);
        else log(describeAddonMessage(m));
        hub.handleAddon(m, m.t === "key" ? keyProof(m) : NO_PROOF);
    }
  }
}

// ---- dragging a Familiar frame -------------------------------------------------------------------
// The Glass follows the OS cursor directly (read-only: GetCursorPos / button state) while a
// Familiar frame is dragged or resized, instead of waiting for updates through the Runestrip:
// * It starts the moment the left button is pressed on the window's frame (not a pane or button)
//   and the mouse moves: "predicted". The addon's "dragstart" confirms it (and gives the exact
//   start point); if none comes, the Glass goes back where it was.
// * It follows the cursor as of DRAG_LAG_MS ago: WoW draws its window a little behind the cursor.
// * It freezes the moment the button is released; "dragstop" + the exact layout end it.
const DRAG_LAG_MS = 25;
type DragState = Drag & {
  base: any;
  timer: NodeJS.Timeout;
  last?: string;
  upAt?: number;
  predicted: boolean;
  confirmedAt?: number;
  startedAt: number;
  updates: number;
  samples: { t: number; x: number; y: number }[];
};
let drag: DragState | null = null;

/** Screen px -> the addon's client physical px (layout rects). */
function toClient(x: number, y: number): { x: number; y: number } | null {
  if (!client || !layout?.scr || !client.width || !client.height) return null;
  return { x: (x - client.x) * (layout.scr[0] / client.width), y: (y - client.y) * (layout.scr[1] / client.height) };
}

function cursorInClient(): { x: number; y: number } | null {
  const c = cursorPos();
  return c ? toClient(c.x, c.y) : null;
}

function beginFollow(d: Drag, base: any, predicted: boolean) {
  if (drag) clearInterval(drag.timer);
  drag = { ...d, base, predicted, startedAt: Date.now(), updates: 0, samples: [], timer: setInterval(followCursor, 8) };
  if (!predicted) drag.confirmedAt = Date.now();
  followCursor();
}

// The addon's word that WoW really started moving/sizing a frame.
function startDrag(m: any) {
  if (!layout || typeof m.cx !== "number" || typeof m.cy !== "number") return;
  const kind = m.kind === "size" ? "size" : "move";
  const target = m.target === "tracker" ? "tracker" : "win";
  if (drag && drag.predicted && !drag.confirmedAt && drag.kind === kind && drag.target === target) {
    drag.confirmedAt = Date.now();
    drag.c0 = { x: m.cx, y: m.cy }; // exact: where WoW anchored the drag
    if (Array.isArray(m.min)) drag.min = m.min;
    if (Array.isArray(m.max)) drag.max = m.max;
    return;
  }
  const base = { ...(drag ? drag.base : layout) };
  if (Array.isArray(m.rect)) {
    if (target === "tracker") base.tracker = m.rect;
    else if (base.win && (base.win[0] !== m.rect[0] || base.win[1] !== m.rect[1] || base.win[2] !== m.rect[2] || base.win[3] !== m.rect[3])) {
      // The overlay's copy is stale: re-base on the frame's real rect.
      Object.assign(base, dragLayout(base, { kind: "move", target: "win", c0: { x: 0, y: 0 } }, m.rect[0] - base.win[0], m.rect[1] - base.win[1]));
    }
  }
  beginFollow({ kind, target, c0: { x: m.cx, y: m.cy }, min: Array.isArray(m.min) ? m.min : undefined, max: Array.isArray(m.max) ? m.max : undefined }, base, false);
}

function followCursor() {
  if (!drag) return;
  const now = Date.now();
  if (!mouseButtonDown()) {
    // Released: freeze where the frame stopped. Wait briefly for dragstop / a late dragstart.
    drag.upAt ??= now;
    if (drag.predicted && !drag.confirmedAt && now - drag.upAt > 400) return endDrag("not a drag", true);
    if (now - drag.upAt > 600) return endDrag("mouse released");
    return;
  }
  if (drag.predicted && !drag.confirmedAt && now - drag.startedAt > 400) return endDrag("not a drag", true);
  const c = cursorInClient();
  if (!c) return;
  drag.samples.push({ t: now, ...c });
  while (drag.samples.length > 2 && drag.samples[1].t <= now - DRAG_LAG_MS) drag.samples.shift();
  const s = drag.samples[0]; // the newest sample at least DRAG_LAG_MS old (or the first one)
  const next = dragLayout(drag.base, drag, s.x, s.y);
  const sig = JSON.stringify([next.win, next.tracker]);
  if (sig === drag.last) return;
  drag.last = sig;
  drag.updates++;
  layout = next;
  overlay?.webContents.send("layout", layout);
}

function endDrag(why: string, revert = false) {
  if (!drag) return;
  clearInterval(drag.timer);
  const d = drag;
  drag = null;
  // Layouts that arrived mid-drag are older than where the frame ended up: never re-apply them.
  // The exact layout follows the addon's dragstop.
  if (revert) {
    layout = d.base;
    overlay?.webContents.send("layout", layout);
  }
  log(
    `[drag] ${d.target} ${d.kind}: ${d.predicted ? "followed from the press" : "followed from dragstart"}` +
      `${d.confirmedAt ? `, confirmed after ${d.confirmedAt - d.startedAt} ms` : ""}, ${d.updates} updates, ended: ${why}`,
  );
}

// ---- physical input (read-only GetAsyncKeyState / GetCursorPos; nothing is ever sent) -----------
// One 10 ms sampler feeds two things: the PressLog that corroborates approvals from the game
// (physical.ts), and drag prediction below.
const presses = new PressLog();
const VK_SHIFT = 0x10,
  VK_CONTROL = 0x11,
  VK_MENU = 0x12;
const approveBind = () => (cfg.approveKey ? bindingToVk(cfg.approveKey) : undefined);

/** Decision keys must coincide with real input: the button under the mouse, or the registered key.
 * The addon's `src` only picks which check runs; lying about it never helps. */
const CORROBORATED_KEYS = new Set(["approve", "always", "mode"]);
function keyProof(m: any): Proof {
  if (!CORROBORATED_KEYS.has(m.k)) return TRUSTED;
  if (!overlayShown || Date.now() - overlayShownAt < 400) return { ok: false, how: "none", why: "Glass not showing" };
  if (m.src === "bind") return m.k === "mode" ? { ok: false, how: "bind", why: "Mode has no keybind" } : corroborateKey(presses, approveBind(), Date.now());
  if (m.src === "slash") return { ok: false, how: "none", why: "slash commands cannot approve" };
  return corroborateClick(presses, layout?.keys?.[m.k], undefined, Date.now(), toClient);
}

/** Proof for the overlay action that a forwarded click produces (within 250 ms; consumed once). */
let clickProof: { at: number; proof: Proof } | undefined;

// Drag prediction: watches for a press-and-move on the window's frame so following starts before
// "dragstart" arrives (that takes a strip frame or two).
let press: { x: number; y: number; zone: ReturnType<typeof dragZone> } | null = null;
setInterval(() => {
  if (!game) return;
  const c = cursorPos();
  const bind = approveBind();
  const down = new Set<number>();
  if (bind && keyDown(bind.vk)) down.add(bind.vk);
  const left = leftButtonDown();
  presses.sample({
    at: Date.now(),
    x: c?.x ?? -1e6,
    y: c?.y ?? -1e6,
    left,
    right: rightButtonDown(),
    down,
    ctrl: keyDown(VK_CONTROL),
    shift: keyDown(VK_SHIFT),
    alt: keyDown(VK_MENU),
  });
  if (drag || !overlayShown || !layout?.panel || !layout.win || !left) {
    if (!drag) press = null;
    return;
  }
  const cc = c && toClient(c.x, c.y);
  if (!cc) return;
  if (!press) {
    press = { x: cc.x, y: cc.y, zone: dragZone(layout, cc.x, cc.y) };
    return;
  }
  if (press.zone && Math.hypot(cc.x - press.x, cc.y - press.y) >= 4) {
    beginFollow({ ...press.zone, c0: { x: cc.x, y: cc.y } }, { ...layout }, true);
    press = null;
  }
}, 10);

// ---- render pushes ------------------------------------------------------------------------------
let lastModel: ReturnType<typeof buildModel> | undefined;
let pushTimer: NodeJS.Timeout | undefined;
function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    pushAll();
  }, 40);
}

/** Requests that already had a Windows notice (thread + request id): one balloon per request. */
const noticed = new Set<string>();
const noticeKey = (thread: string | undefined, requestId: string) => `${thread ?? ""}\0${requestId}`;
function markNoticed(key: string) {
  noticed.add(key);
  if (noticed.size > 500) noticed.delete(noticed.values().next().value!);
}
const gameInFront = () => !!game && !minimized && (fg === game.key || fg === overlayKey);

/** An approval toast while WoW isn't in front (or is minimized): a Windows notice, so a request
 * doesn't sit unseen while you're at the desk. Its click opens the control panel (balloon-click),
 * which lists every pending request. Never moves focus; generic under Hide names. */
function noticeFor(x: Toast) {
  if (x.kind !== "approval" || !x.requestId || noticed.has(noticeKey(x.threadId, x.requestId))) return;
  const t = x.threadId ? hub.threads.get(x.threadId) : undefined;
  const n = trayNoticeFor({ kind: x.kind, project: t ? hub.projectName(t) : undefined, questTitle: t?.title },
    { gameInFront: gameInFront(), privateMode: !!cfg.privateMode, trayNotices: cfg.trayNotices !== false });
  if (!n || !tray) return;
  markNoticed(noticeKey(x.threadId, x.requestId));
  tray.displayBalloon({ title: n.title, content: n.content, noSound: true, respectQuietTime: true });
  log("[notice] request waiting while WoW isn't in front: Windows notice shown");
}

/** A request too long for the in-game card waits on the PC: make the control panel easy to reach
 * without moving focus (never from the game, never a forced foreground): its taskbar button
 * flashes, or, while it is closed to the tray, a quiet tray notice opens it when clicked (unless
 * that request already had one). */
let requestsWaiting = false;
function surfaceRequests() {
  requestsWaiting = true;
  tray?.setToolTip("Familiar: a request is waiting on your PC");
  if (control && !control.isDestroyed()) return void control.flashFrame(true);
  const fresh = hub.pendingRequests().filter((r) => r.cut && !noticed.has(noticeKey(r.thread, r.requestId)));
  if (!fresh.length) return;
  for (const r of fresh) markNoticed(noticeKey(r.thread, r.requestId));
  tray?.displayBalloon({ title: "A request is waiting on your PC", content: "Too long for the in-game card. Open Familiar to read it in full and approve it, or Deny it in game.", noSound: true, respectQuietTime: true });
}

/** Nothing waits any more (decided, expired): stop asking for attention. */
function settleRequests() {
  if (!requestsWaiting || hub.pendingRequests().some((r) => r.cut)) return;
  requestsWaiting = false;
  tray?.setToolTip("Familiar");
  if (control && !control.isDestroyed()) control.flashFrame(false);
}

function pushAll() {
  if (!hub) return;
  settleRequests();
  lastModel = buildModel(hub, { linked: linked(), fps: captureStats.fps ?? 0 });
  overlay?.webContents.send("model", lastModel);
  if (layout) overlay?.webContents.send("layout", layout);
  updateVisibility();
  sendStatus();
}

function uiSettings() {
  return { fontScale: cfg.fontScale, sound: cfg.sound, raidWarnings: cfg.raidWarnings !== false, quiet: !!cfg.quiet, privateMode: !!cfg.privateMode,
    streamSafe: !!cfg.privateMode && !!cfg.blurTranscript, defaultMode: cfg.defaultMode, approveKey: cfg.approveKey ?? "", trayNotices: cfg.trayNotices !== false };
}

function statusSnapshot() {
  return {
    version: VERSION,
    build: RUNNING_BUILD,
    storage: hub?.storage,
    work: hub ? activity(hub) : null,
    game: game ? { exe: game.exe, title: game.title, cls: game.cls, client, frame: frameRect, minimized, foreground: fg === game.key } : null,
    capture: { ...captureStats, mode: captureMode },
    linked: linked(),
    lastMsgAgo: lastMsgAt ? Date.now() - lastMsgAt : null,
    addon: hub?.addon,
    layout: layout ? { panel: layout.panel, scr: layout.scr, px: layout.px, ui: layout.ui } : null,
    overlay: { shown: overlayShown, paused },
    backends: hub ? Object.fromEntries(Object.entries(hub.backends).map(([id, b]) => [id, { ...b.status(), label: providerInfo(id).label }])) : null,
    install: install ? { dir: install.dir, flavor: install.flavor, source: install.source, product: install.product, version: install.version, iface: install.iface } : null,
    installError: install ? undefined : installError,
    // One line: does the addon's Interface list cover the detected client?
    wow: install ? interfaceCheck(install, tocInterfaces(path.join(REPO_ADDON, "Familiar.toc"))) : null,
    wrongClient: wrongClient ? { exe: wrongClient.exe, dir: wrongClient.dir } : null,
    installNotes,
    threads: hub ? hub.threads.size : 0,
    projects: projectsStatus(),
    configPath: path.join(appDataDir(), "config.json"),
    launchAtLogin: cfg.launchAtLogin,
    ui: uiSettings(),
    // "Requests waiting": pending approvals in full (decided here via "decide"; cut ones only here).
    requests: hub ? hub.pendingRequests() : [],
    claude: claudeStatus(),
    doctor: doctorNow(),
    update: { app: VERSION, addon: hub?.addon.addon, mismatch: false, last: lastUpdateCheck },
    providers: providersNow(),
    providersChosen: cfg.providersChosen,
    chat: { agent: cfg.chatAgent, model: cfg.chatModel, effort: cfg.chatEffort },
    logPath: logFile,
  };
}

/** The Link Doctor's line for the status and Copy diagnostics (doctor.ts). */
function doctorNow() {
  const c = captureStats ?? {};
  return linkDoctor({ game: !!game, minimized, foreground: !!game && (fg === game.key || fg === overlayKey), captureMode,
    stats: { fps: c.fps ?? 0, crc: c.crc ?? 0, lock: c.lock, lastOk: c.lastOk ?? 0 }, startedAt: captureStartedAt, now: Date.now() });
}

/** Zones for the control panel's Projects card: the folders you added, and how many came from history. */
function projectsStatus() {
  return { explicit: [...cfg.projects], roots: [...cfg.projectRoots], history: 0 };
}

/** The last "Check for updates" answer (only ever from the player's click). */
let lastUpdateCheck: CheckUpdate | undefined;

/** Versions for "Suggest a change": no paths, names or logs. */
function suggestVersions(): SuggestVersions {
  return { familiar: VERSION, wow: install?.version, iface: install?.iface, windows: os.release() };
}

/** "Copy diagnostics": versions, install/capture/provider state and the redacted log tail. No
 * paths (beyond what redact() leaves), no config values except booleans, no transcript. */
function diagnosticsReport(): string {
  const check = install ? interfaceCheck(install, tocInterfaces(path.join(REPO_ADDON, "Familiar.toc"))) : null;
  const c = captureStats ?? {};
  return diagnosticsText({
    version: VERSION,
    build: `commit ${RUNNING_BUILD.commit ?? "unavailable"}${RUNNING_BUILD.dirty === null ? "" : RUNNING_BUILD.dirty ? " (local changes)" : " (clean)"}`,
    electron: process.versions.electron ?? "?",
    node: process.versions.node ?? "?",
    windows: `${os.release()} (${os.arch()})`,
    wow: install
      ? `${install.flavor} product ${install.product ?? "?"} version ${install.version ?? "?"} iface ${install.iface ?? "?"} (${install.source}); ${check?.text ?? ""}`
      : `no install (${installError ?? "unknown"})${wrongClient ? `; another client running: ${wrongClient.exe}` : ""}`,
    capture: `mode ${captureMode}${captureMode === "screen" ? " (messages accepted only while WoW is in front and uncovered)" : ""}, fps ${c.fps ?? 0}, lock ${c.lock ? "yes" : "no"}, linked ${linked() ? "yes" : "no"}, game ${game ? (minimized ? "minimized" : fg === game.key ? "foreground" : "background") : "not found"}, overlay ${paused ? "paused" : overlayShown ? "shown" : "hidden"}${c.error ? `, error: ${c.error}` : ""}`,
    providers: providersNow().map((p) => `${p.id} ${p.installed ? "installed" : "not installed"}${p.signedIn === undefined ? "" : p.signedIn ? ", signed in" : ", not signed in"}${p.enabled ? ", on" : ", off"}`),
    configKeys: changedConfigKeys(cfg as unknown as Record<string, unknown>, DEFAULT_CONFIG as unknown as Record<string, unknown>),
    log: logRing.slice(-80),
  });
}

let statusTimer: NodeJS.Timeout | undefined;
function sendStatus() {
  if (!control || statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = undefined;
    control?.webContents.send("status", statusSnapshot());
  }, 250);
}

/** Register (or remove) the "start with Windows" entry. Re-registered on every launch, so it
 * follows the repo if it moves; boot.cjs rebuilds dist/ when needed. Dev runs never touch it. */
function applyLoginItem() {
  if (devEnabled()) return;
  try {
    // Named "Familiar" in Task Manager > Startup (unnamed, Electron uses its generic app id). Same
    // name installed or not, so an installed Familiar takes over a source run's entry.
    const args = PACKAGED ? ["--background"] : [path.resolve(ROOT), "--background"];
    app.setLoginItemSettings({ openAtLogin: cfg.launchAtLogin, path: process.execPath, args, name: "Familiar" });
    removeLegacyLoginItem();
  } catch (e) {
    log("[login-item] " + e);
  }
}

/** Earlier builds registered under Electron's generic "electron.app.Electron". Remove that entry —
 * but only when it launches this Familiar, since other Electron apps can use the same name. */
function removeLegacyLoginItem() {
  if (process.platform !== "win32") return;
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const RUN = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const OLD = "electron.app.Electron";
  let value = "";
  try {
    value = execFileSync("reg", ["query", RUN, "/v", OLD], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return; // no such entry
  }
  if (!value.toLowerCase().includes(path.resolve(ROOT).toLowerCase())) return;
  for (const key of [RUN, "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run"]) {
    try {
      execFileSync("reg", ["delete", key, "/v", OLD, "/f"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* not there */
    }
  }
  log(`[login-item] removed the old "${OLD}" startup entry`);
}

const sameFolder = (a: string, b: string) => path.resolve(a).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(b).replace(/[\\/]+$/, "").toLowerCase();

/** Look for the Forever client (running exe first); remembers why nothing was found. */
function probeInstall(runningExePath?: string): WowInstall | null {
  const p = findWowInstall(cfg, runningExePath);
  installError = p.error;
  return p.install;
}

function doInstall(force: boolean) {
  install = install ?? probeInstall(game?.path || undefined);
  if (!install) {
    installNotes = [installError ?? "World of Warcraft install not found. Set wowRoot/wowFlavor in %APPDATA%\\Familiar\\config.json."];
    log("[install] " + installNotes[0]);
    return;
  }
  const check = interfaceCheck(install, tocInterfaces(path.join(REPO_ADDON, "Familiar.toc")));
  log(`[wow] flavor ${install.flavor} product ${install.product ?? "?"} version ${install.version ?? "?"} iface ${install.iface ?? "?"} (${install.source}): ${check.text}`);
  // Installed: a marked copy (a junction into the install folder would dangle after uninstall and
  // let addon managers write through it). Source run: a junction to the live repo copy.
  const r = installAddon(install, REPO_ADDON, PACKAGED ? "copy" : "link");
  installNotes = check.level === "warn" ? [check.text, ...r.messages] : r.messages;
  for (const m of r.messages) log("[install] " + m);
  if (force && !r.changed) log("[install] addon already installed at " + install.addons);
  snapshot?.writeNow();
}

let uninstalling = false;
/** Tray > Uninstall: startup entry, addon link and FamiliarSync; optionally %APPDATA%\Familiar. */
async function uninstall() {
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Uninstall", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Remove Familiar from this PC?",
    detail: PACKAGED
      ? "Removes the Windows startup entry, the Familiar addon in WoW and FamiliarSync. Your agents' sign-ins and your project files are not touched. Then remove Familiar in Windows Settings > Apps."
      : "Removes the Windows startup entry, the addon link in WoW and FamiliarSync. Your agents' sign-ins and your project files are not touched. Delete the Familiar folder yourself afterwards.",
    checkboxLabel: "Also delete settings, logs and saved quests (%APPDATA%\\Familiar)",
  });
  if (response !== 0) return;
  uninstalling = true;
  cfg.launchAtLogin = false;
  applyLoginItem();
  if (install) for (const m of uninstallAddon(install)) log("[uninstall] " + m);
  if (checkboxChecked) {
    try {
      fs.rmSync(appDataDir(), { recursive: true, force: true });
    } catch (e) {
      log("[uninstall] " + e);
    }
  } else saveConfig(cfg);
  app.quit();
}

// ---- Claude Code download (agents/claude-download.ts, fetch-claude.cjs) -------------------------
// The installed app and the release zip carry no Anthropic code: at every start (the --background
// login start too) the pinned packages are checked, and downloaded when missing or re-pinned, in
// this process, without blocking anything else (Codex and the other agents start as usual). The
// check alone makes no network request. A clone has them from npm ci and never downloads.
type FetchClaudeModule = {
  fetchClaude(o: { root: string; pins?: string; log?: (s: string) => void; onProgress?: (got: number, total: number, label?: string) => void }): Promise<"present" | "installed">;
};
/** dist/claude-pins.json (scripts/build.mjs): the pinned versions, URLs and sha512s. Without it
 * fetchClaude reads package-lock.json (a clone, older zips). */
const CLAUDE_PINS = path.join(DIST, "claude-pins.json");
const fetchClaudeNow: ClaudeFetch = (onProgress) => {
  const { fetchClaude } = require("../../fetch-claude.cjs") as FetchClaudeModule; // bundled into main.js
  return fetchClaude({
    root: claudeHome(),
    pins: fs.existsSync(CLAUDE_PINS) ? CLAUDE_PINS : undefined,
    log: (s) => {
      for (const line of String(s).split(/[\r\n]+/)) if (line.trim()) log("[claude] " + line.trim());
    },
    onProgress,
  });
};

/** Start (or join) the download; returns the state at once. `why`: "start" or "retry". */
function startClaudeDownload(why: "start" | "retry") {
  if (claudeRoute() === "clone") return claudeStatus();
  const missing = claudeStatus().state !== "present";
  if (missing) log(`[claude] Claude Code is not downloaded yet: downloading it (${why})`);
  downloadClaude(fetchClaudeNow, () => {
    providersCache = undefined; // the Familiars card's Claude row follows the download
    sendStatus();
  }).then((s) => {
    const failed = claudeDownloadError();
    if (failed) log(`[claude] download failed: ${failed}`);
    if (s.state !== "present" || !missing) return;
    log("[claude] Claude Code is downloaded");
    hub.backends.claude
      ?.init()
      .then(() => {
        hub.changed("providers");
        if (game) return hub.refreshExternal(); // agents are awake: list Claude's desktop threads now
      })
      .catch((e) => log("[claude] init: " + e));
  });
  return claudeStatus();
}

// ---- boot ---------------------------------------------------------------------------------------
app.whenReady().then(async () => {
  log(`[boot] Familiar companion ${VERSION} (Electron ${process.versions.electron})`);
  const claude = new ClaudeBackend({ log, version: VERSION, executable: cfg.claudeExecutable || undefined, defaultModel: cfg.claudeModel });
  const codex = new CodexBackend({ log, version: VERSION, exe: cfg.codexExe });
  const backends: Record<string, AgentBackend> = { claude, codex };
  // Agent Client Protocol agents (Hermes, Grok Build, anything added under "providers" in
  // config.json) — only the ones actually installed.
  for (const id of acpProviderIds()) {
    const b = makeAcpBackend(id);
    if (b) backends[id] = b;
  }
  hub = new Hub(() => cfg, backends, log);
  hub.version = VERSION;
  // "Continue in <app>": only the agents' own app links, never an arbitrary URL.
  hub.openExternal = (url) => {
    if (/^(claude|codex):\/\//i.test(url)) shell.openExternal(url).catch((e) => log(`[open] ${e}`));
  };
  // "Suggest a change": only our own pre-filled new-issue form; the user submits it there.
  hub.openIssue = (url) => {
    if (isIssueUrl(url)) shell.openExternal(url).catch((e) => log(`[open] ${e}`));
  };
  hub.suggestVersions = suggestVersions;
  hub.onSound = (k) => cfg.sound && overlay?.webContents.send("sound", k);
  hub.onSpeak = (t) => overlay?.webContents.send("speak", t);
  hub.onCutRequest = surfaceRequests;
  hub.onToast = noticeFor;
  hub.onConfigChanged = (c) => {
    saveConfig(c);
    applyLoginItem();
    sendStatus();
  };
  snapshot = new SnapshotWriter(hub, () => (install ? path.join(install.addons, "FamiliarSync", "FamiliarSync.lua") : null), log);
  hub.on((why) => {
    schedulePush();
    if (why !== "delta") snapshot.schedule();
  });

  doInstall(false);
  // Start with Windows is opt-in (control panel checkbox, /fam autostart on); this only syncs the
  // registry entry with the setting and removes the legacy one.
  applyLoginItem();

  createOverlay();
  createCapture();
  createTray();
  if (!process.argv.includes("--background")) createControl();

  ipcMain.on("msgs", (e, msgs) => {
    if (!from(e, capture) || !Array.isArray(msgs)) return;
    const gate = screenGate();
    if (!gate.ok) {
      if (screenRefusals.shouldLog(Date.now())) log(`[capture] screen mode: dropped ${msgs.length} message(s): ${gate.why}`);
      return;
    }
    onAddonMessages(msgs);
  });
  ipcMain.on("stats", (e, s) => {
    if (!from(e, capture)) return;
    const wasLinked = linked();
    captureStats = s;
    if (linked() !== wasLinked) {
      log(`[link] ${linked() ? "linked" : "lost"} (fps ${s.fps}, decoded ${s.decoded}, crc ${s.crc}, missed ${s.missed})`);
      pushAll();
    }
    sendStatus();
  });
  ipcMain.on("log", (e, s) => {
    if (from(e, capture) || from(e, overlay) || from(e, control)) log(String(s));
  });
  ipcMain.on("action", (e, a) => {
    if (!from(e, overlay) || !a || typeof a !== "object") return;
    log(describeOverlayAction(a));
    // Only the action a corroborated, just-forwarded click produced may approve; one click, one action.
    const proof = clickProof && Date.now() - clickProof.at < 250 ? clickProof.proof : NO_PROOF;
    clickProof = undefined;
    try {
      hub.action(a, proof);
    } catch (e) {
      log("[action] " + e);
    }
  });
  ipcMain.handle("cmd", async (e, cmd: string, args: any) => {
    if (!from(e, control)) return null; // only the control panel drives settings; the Glass and capture never call cmd
    switch (cmd) {
      case "status":
        return statusSnapshot();
      case "logs":
        return logRing.slice(-200);
      case "diagnostics":
        clipboard.writeText(diagnosticsReport());
        return true;
      case "install":
        doInstall(true);
        return installNotes;
      case "openConfig":
        return shell.openPath(path.join(appDataDir(), "config.json"));
      case "openLogs":
        return shell.openPath(logFile);
      case "reloadConfig":
        cfg = loadConfig(log);
        hub.projects.scanRoots();
        hub.changed("config");
        return true;
      case "providerEnable": {
        const { id, on } = args as { id: string; on: boolean };
        cfg.providers = { ...cfg.providers, [id]: { ...cfg.providers?.[id], enabled: !!on } };
        saveConfig(cfg);
        if (on && !hub.backends[id]) {
          const b = makeAcpBackend(id);
          if (b) hub.addBackend(id, b);
        } else if (on) hub.wake().then(() => hub.backends[id].init()).then(() => hub.refreshExternal()).catch(() => {});
        else hub.refreshExternal().catch(() => {});
        providersCache = undefined;
        hub.changed("providers");
        return providersNow();
      }
      case "providerLogin":
        return startLogin(String(args));
      case "providerInstall": {
        const p = providersNow().find((x) => x.id === args);
        if (p?.installUrl) await shell.openExternal(p.installUrl);
        return true;
      }
      case "chatSettings": {
        const { agent, model, effort } = args as { agent?: string; model?: string; effort?: string };
        if (agent && agent !== cfg.chatAgent) {
          cfg.chatAgent = agent;
          cfg.chatModel = model ?? hub.backends[agent]?.status().models.find((m) => m.id !== "default")?.id ?? "";
        } else if (model) cfg.chatModel = model;
        if (effort) cfg.chatEffort = effort;
        saveConfig(cfg);
        hub.changed("config");
        sendStatus();
        return { agent: cfg.chatAgent, model: cfg.chatModel, effort: cfg.chatEffort };
      }
      case "providersChosen":
        cfg.providersChosen = true;
        saveConfig(cfg);
        sendStatus();
        return true;
      case "uiSettings": {
        const a = (args ?? {}) as { fontScale?: number; sound?: boolean; raidWarnings?: boolean; quiet?: boolean; privateMode?: boolean; streamSafe?: boolean; defaultMode?: string; approveKey?: string; trayNotices?: boolean };
        if (typeof a.fontScale === "number" && isFinite(a.fontScale)) cfg.fontScale = Math.min(FONT_MAX, Math.max(FONT_MIN, a.fontScale));
        if (typeof a.sound === "boolean") cfg.sound = a.sound;
        if (typeof a.raidWarnings === "boolean") cfg.raidWarnings = a.raidWarnings;
        if (typeof a.trayNotices === "boolean") cfg.trayNotices = a.trayNotices;
        if (typeof a.quiet === "boolean") hub.setQuiet(a.quiet);
        if (typeof a.privateMode === "boolean") hub.setPrivate(a.privateMode);
        if (typeof a.streamSafe === "boolean") hub.setStream(a.streamSafe);
        if (MODES.includes(a.defaultMode as Mode)) cfg.defaultMode = a.defaultMode as Mode; // never a bypass mode: MODES has none
        // Only keys Familiar can check on the keyboard; anything else clears it (keybind approvals refused).
        if (typeof a.approveKey === "string") cfg.approveKey = bindingToVk(a.approveKey) ? a.approveKey.trim().toUpperCase() : "";
        saveConfig(cfg);
        hub.changed("config");
        return uiSettings();
      }
      case "decide": {
        // A click in the focused control panel, which shows the whole request: physical input on the
        // PC, not a path from the game. The only caller of hub.decide(..., "panel"); `cmd` answers
        // only the control panel's own window (from(e, control) above), never the Glass, the
        // capture page, the addon link or the dev hooks.
        const { thread, requestId, decision } = (args ?? {}) as { thread?: unknown; requestId?: unknown; decision?: unknown };
        if (typeof thread !== "string" || typeof requestId !== "string" || (decision !== "allow" && decision !== "allowAlways" && decision !== "deny"))
          return { ok: false, why: "bad request" };
        log(`[control] decide ${decision}`);
        const r = hub.decide(thread, requestId, decision, "panel");
        sendStatus();
        return r;
      }
      case "launchAtLogin":
        cfg.launchAtLogin = !!args;
        saveConfig(cfg);
        applyLoginItem();
        return cfg.launchAtLogin;
      case "pause":
        paused = !!args;
        updateVisibility();
        return paused;
      case "refresh":
        await hub.refreshExternal();
        return true;
      case "suggest": {
        const url = suggestionUrl(String(args ?? ""), suggestVersions());
        if (!url) throw new Error("Write a suggestion first.");
        hub.openIssue(url);
        return true;
      }
      // Round 4 commands (interfaces; filled in by the following changes).
      case "claudeRetry":
        return startClaudeDownload("retry");
      case "captureSnapshot":
        return { ok: false, why: "Not available yet." };
      case "projectAdd":
        return { ok: false, why: "Not available yet." };
      case "projectRemove":
        return { ok: false };
      case "checkUpdate":
        return { current: VERSION, error: "Not available yet." } satisfies CheckUpdate;
      case "openUrl":
        return undefined;
      case "testToast":
        hub.toast("Familiar overlay test — if you can read this over WoW, the Glass works.", "info");
        return true;
      case "simulate":
        // Developer aid (FAMILIAR_DEV=1 only): inject an addon message as if it came over the Runestrip.
        if (!devEnabled()) return null;
        onAddonMessages([args]);
        return true;
    }
    return null;
  });

  if (devEnabled()) startDevServer();
  await hub.start();
  startClaudeDownload("start");
  setInterval(tick, 100);
  // Tells the addon (at login / reload) that the companion is alive, even when nothing changed.
  setInterval(() => snapshot.writeNow({ force: true }), 5 * 60_000);
  setInterval(() => {
    updateVisibility();
    sendStatus();
  }, 1000);
  log("[boot] ready");
});

// ---- agent providers ----------------------------------------------------------------------------
function acpProviderIds(): string[] {
  return [...new Set([...Object.keys(DEFAULT_ACP_PROVIDERS), ...Object.keys(cfg.providers ?? {})])].filter((id) => id !== "claude" && id !== "codex");
}

/** An ACP agent's backend, if it is installed (switched-off ones are created but not started). */
function makeAcpBackend(id: string): AcpBackend | null {
  const p = { ...DEFAULT_ACP_PROVIDERS[id], ...cfg.providers?.[id] };
  if (!p.command || !resolveCommand(p.command)) return null;
  registerProvider({ id, label: p.label ?? providerInfo(id).label, glyph: p.glyph ?? providerInfo(id).glyph });
  // Basename and arg count only: users put keys and tokens in a custom provider's args.
  log(`[boot] provider ${id}: ${path.basename(p.command)} (${(p.args ?? []).length} args)${p.enabled === false ? " (switched off)" : ""}`);
  return new AcpBackend({
    id,
    command: p.command,
    args: p.args,
    env: p.env,
    log,
    version: VERSION,
    catalog: id === "hermes" ? hermesCatalog(log) : undefined,
    approvalTimeoutSec: id === "hermes" ? 60 : undefined,
  });
}

let providersCache: { at: number; list: ReturnType<typeof providerSetup> } | undefined;
/** Installed / signed in / used, per provider — cheap file checks, cached for a few seconds. */
function providersNow() {
  if (!providersCache || Date.now() - providersCache.at > 4000) {
    providersCache = { at: Date.now(), list: providerSetup((id) => cfg.providers?.[id]?.enabled !== false, cfg.providers ?? {}) };
  }
  return providersCache.list;
}

// ---- dev/test hooks (FAMILIAR_DEV=1 only; 127.0.0.1; per-run token, see dev-hooks.ts) ----------
function startDevServer() {
  serveDevHooks(
    47810,
    async (url, body) => {
      if (url === "/status") return { ...statusSnapshot(), view: { ...hub.view, collapsed: [...hub.view.collapsed], expanded: [...hub.view.expanded] } };
      if (url === "/model") return lastModel;
      if (url === "/simulate") return onAddonMessages([JSON.parse(body)]) ?? true;
      if (url === "/action") return hub.action(JSON.parse(body), TRUSTED) ?? true; // token-gated dev hook stands in for a real click
      if (url === "/snap") return await snap(body || path.join(appDataDir(), "snap.png"));
      if (url === "/inject") {
        const ev = JSON.parse(body);
        return hub.injectAgentEvent(ev.agent ?? "claude", ev) ?? true;
      }
      if (url === "/overlay-eval") return await overlay?.webContents.executeJavaScript(body);
      if (url === "/threads") return [...hub.threads.values()].map((t) => ({ id: t.id, agent: t.agent, title: t.title, status: t.status, entries: t.entries.length, last: t.entries.slice(-3) }));
      return { error: "unknown" };
    },
    log,
  ).catch((e) => log(`[dev] test hooks failed to start: ${e}`));
}

/** Composite screenshot (game + overlay) of the game's client area, via a screen capture source. */
async function snap(file: string) {
  if (!client) return { error: "no game window" };
  const disp = screen.getDisplayMatching(screen.screenToDipRect(null, client));
  const size = { width: Math.round(disp.size.width * disp.scaleFactor), height: Math.round(disp.size.height * disp.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  const src = sources.find((s) => s.display_id === String(disp.id)) ?? sources[0];
  const origin = { x: Math.round(disp.bounds.x * disp.scaleFactor), y: Math.round(disp.bounds.y * disp.scaleFactor) };
  const img = src.thumbnail.crop({ x: client.x - origin.x, y: client.y - origin.y, width: client.width, height: client.height });
  fs.writeFileSync(file, img.toPNG());
  return { file, size: img.getSize() };
}

app.on("window-all-closed", () => {
  /* keep running in the tray */
});

app.on("before-quit", () => {
  if (uninstalling) return; // nothing is written back after an uninstall
  hub?.saveNow();
  snapshot?.writeNow({ stopping: true });
  hub?.shutdown();
});

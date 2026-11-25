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
import { claudeDownloadError, claudeHome, claudeRoute, claudeStatus, companionDir, downloadClaude, type ClaudeFetch } from "../agents/claude-download";
import { appDataDir, DEFAULT_CONFIG, loadConfig, saveConfig } from "../hub/config";
import { Hub, privacyOf, soundMessage, type Toast } from "../hub/hub";
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
import { actKey, ApprovalGate, bindingToVk, corroborateClick, KEY_HELD, KEY_WINDOW_MS, NO_PROOF, PressLog, Proof, proofCovers, Rect as ClientRect, TRUSTED } from "./physical";
import { clientInFrame, Drag, dragLayout, dragZone, LogMemo, logLayout, physicalOrigin, rememberLog } from "./geometry";
import { findWowInstall, installAddon, interfaceCheck, SnapshotWriter, tocInterfaces, uninstallAddon, WowInstall } from "./wow";
import { RUNNING_BUILD } from "./build";
import { devEnabled, distributed, serveDevHooks, stripDevEnv } from "./dev-hooks";
import { changedConfigKeys, describeAddonMessage, describeOverlayAction, diagnosticsText, logLine, redact, rotateLog } from "./log-file";
import { linkDoctor } from "./doctor";
import { trayNoticeFor } from "./notices";
import { paintBadge, trayBadgeFor, type TrayBadge } from "./tray-badge";
import { checkUpdate, isReleasesUrl, type CheckUpdate } from "./update";

/** package.json's version, stamped in by scripts/build.mjs; Electron's own reading of it otherwise. */
declare const __FAMILIAR_VERSION__: string | undefined;
const VERSION = typeof __FAMILIAR_VERSION__ === "string" ? __FAMILIAR_VERSION__ : app.getVersion();

// ---- installed build (electron-builder) --------------------------------------------------------
// Packaged-only: a source run (electron.exe <companion dir>, via boot.cjs) skips all of this.
const PACKAGED = app.isPackaged;
companionDir.packaged = PACKAGED; // where Claude lives (claude-download.ts claudeHome)
/** The addon the companion installs: the repo's copy, or the installer's under resources\. */
const REPO_ADDON = PACKAGED ? path.join(process.resourcesPath, "addon", "Familiar") : path.resolve(__dirname, "..", "..", "addon", "Familiar");
// Dev/test hooks and the FAMILIAR_* overrides never exist in a distributed build (the installed app
// or the release download); only a source checkout honours them. Before anything reads them.
if (distributed(PACKAGED)) stripDevEnv();
if (PACKAGED) {
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
    ({ ok, lines } = selfTest({ appRoot, addonDir: REPO_ADDON, claudeHome: claudeHome() }));
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
let paused = false;
let captureStarted = false;
let lastCaptureTry = 0;
let lastGeomChange = 0;
// Window capture (WGC on the game window) is primary; if it never locks we fall back to capturing
// the monitor the game is on (needs the game visible) and alternate every 15 s until one locks.
let captureMode: "window" | "screen" = process.env.FAMILIAR_CAPTURE === "screen" ? "screen" : "window";
let captureStartedAt = 0;
let nextScreenTryAt = 0;
/** When frame statistics last arrived (the capture page sends them about once a second while
 * frames flow), and since when the game has been on screen for this link attempt (Link Doctor). */
let statsAt = 0;
let searchSince = 0;
/** Screen capture: the last window seen covering the strip (Link Doctor). */
let lastCover: { exe: string; at: number } | undefined;

const linked = () => Date.now() - (captureStats.lastOk ?? 0) < 3000;

// Capture rate. Reading the whole game window at 30 fps is most of this process's idle CPU. While
// WoW has not been in front (it or the Glass) for BACK_AFTER_MS, or is minimized, the player cannot
// act on the addon, so the stream drops to BACK_FPS; it goes back to FRONT_FPS on the first tick the
// game is in front. Never lower while in front: strip frames are held 70 ms and the addon cannot be
// asked to resend. At BACK_FPS the idle beacon still decodes about twice a second, so linked() (3 s)
// and the Link Doctor stay true. A (re)start opens the stream at FRONT_FPS (openFps) and a lower
// rate follows as a "rate" message (checkRate sends it once the stream reports its cap); in front,
// a stream that measurably stays well under FRONT_FPS is restarted once (checkRate).
const FRONT_FPS = 30;
const BACK_FPS = 2;
const BACK_AFTER_MS = 3000;
let captureFps = FRONT_FPS;
let frontAt = 0;
let rateSentAt = 0;
let rateTries = 0;
/** How a new rate reaches a running stream: false sends the capture page "rate" (applyConstraints
 * on the live track); true restarts the stream with the new fps in its "start" (the 3.4% measured
 * on the owner's PC came from a restart). Which one lowers the source's own rate is measured live. */
const RATE_BY_RESTART = false;
/** The rate a (re)start opens the stream at: always the full rate, unless rates change by restart. */
const openFps = () => (RATE_BY_RESTART ? captureFps : FRONT_FPS);
let slowSince = 0; // in front, the measured rate has been well under FRONT_FPS since then
let slowRestarted = false; // the one restart for that happened; cleared when the wanted rate changes

/** The rate the capture should run at now. Updates frontAt; call once per tick, after fg/minimized. */
function wantedFps(now: number): number {
  if (!game) return FRONT_FPS;
  if (!minimized && (fg === game.key || fg === overlayKey)) frontAt = now;
  return minimized || now - frontAt > BACK_AFTER_MS ? BACK_FPS : FRONT_FPS;
}

/** Hand captureFps to the running stream (see RATE_BY_RESTART). */
function applyRate(now: number) {
  if (!captureStarted || !capture) return; // the next start carries captureFps
  rateSentAt = now;
  rateTries++;
  if (RATE_BY_RESTART) {
    captureStarted = false;
    lastCaptureTry = 0;
  } else capture.webContents.send("rate", { fps: captureFps });
}

/** Each second's frame statistics. In the background: the cap the track reports; a lower rate that
 * did not take (a stream that opened at the full rate, or a rate that reached the page between two
 * streams) is sent again, at most 3 times per change. In front: the measured rate; well under
 * FRONT_FPS for 3 s (raising a running track's rate may not take) restarts the stream once, which
 * opens it at the full rate. */
function checkRate(s: any, now: number) {
  // A stream that just opened, or a rate that was just raised, needs a few seconds before its
  // measured rate means anything; restarting sooner only costs the lock again.
  if (!captureStarted || now - rateSentAt < 4000 || now - captureStartedAt < 5000) return void (slowSince = 0);
  if (captureFps === BACK_FPS) {
    const cap = Number(s?.fpsCap);
    if (!(cap > BACK_FPS + 0.5)) return;
    if (rateTries < 3) applyRate(now);
    else if (rateTries === 3) {
      rateTries++;
      log(`[capture] the stream reports ${cap} fps; wanted ${captureFps} fps. Leaving it.`);
    }
    return;
  }
  const fps = Number(s?.fps);
  // Stuck means still at the background rate. A healthy stream in front measures anywhere from
  // about 9 to 28 fps on a real game (frames arrive as the window repaints), so a plain "under
  // half" test restarted healthy streams.
  if (!gameInFront() || !(fps <= BACK_FPS + 1.5)) return void (slowSince = 0);
  slowSince ||= now;
  if (now - slowSince < 3000 || slowRestarted) return;
  slowRestarted = true;
  log(`[capture] the stream delivers ${fps} fps with WoW in front (wanted ${FRONT_FPS}); restarting it once`);
  captureStarted = false;
  lastCaptureTry = 0;
}

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
  overlay.webContents.on("did-finish-load", () => {
    // A Glass loaded while the game is behind another window still learns the dev-input flag.
    overlay?.webContents.send("vis", { visible: overlayShown, devInput: devEnabled() });
    gate.report([], Date.now()); // a fresh page has painted nothing yet
    sendApprove(true);
    pushAll();
  });
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
    if (control.isMinimized()) control.restore(); // show() alone leaves a minimized panel on the taskbar
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
  // Minimizing the panel tucks it into the tray like closing it does; the tray reopens it.
  control.on("minimize", () => control?.hide());
  // Hidden, it got no status pushes (sendStatus): one now brings it up to date.
  control.on("show", () => sendStatus());
  control.on("restore", () => sendStatus());
}

/** The familiar's face with the state badge (tray-badge.ts) painted onto each representation: 16 px
 * and, where tray@2x.png loaded with it, 32 px (Electron picks that one on high-DPI displays). */
const trayIcons = new Map<TrayBadge, Electron.NativeImage>();
function trayIcon(badge: TrayBadge = "none") {
  const cached = trayIcons.get(badge);
  if (cached) return cached;
  const base = trayArt();
  let icon = base;
  if (badge !== "none") {
    icon = nativeImage.createEmpty();
    for (const scaleFactor of [1, 2]) {
      const buffer = base.toBitmap({ scaleFactor });
      const size = Math.round(Math.sqrt(buffer.length / 4));
      if (!size || size * size * 4 !== buffer.length) continue;
      icon.addRepresentation({ scaleFactor, width: size, height: size, buffer: paintBadge(buffer, size, badge) });
    }
    if (icon.isEmpty()) icon = base;
  }
  trayIcons.set(badge, icon);
  return icon;
}

function trayArt() {
  // The familiar's face (dist/assets/tray.png + tray@2x.png); the drawn orb only if the art is missing.
  const art = nativeImage.createFromPath(path.join(DIST, "assets", "tray.png"));
  if (!art.isEmpty()) return art;
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
  refreshTray();
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
    searchSince = now;
    frontAt = now;
    captureFps = FRONT_FPS; // found: wanted in front from here (wantedFps)
    log(`[wow] found ${game.exe} "${game.title}" class=${game.cls}`);
    hub.wake().catch((e) => log("[hub] wake: " + e));
    // No install known yet: the running game's own folder is the install (doInstall probes with its exe path).
    if (!install) doInstall(false);
  }
  const wasMinimized = minimized;
  minimized = isMinimized(game.hwnd);
  if (wasMinimized && !minimized) searchSince = now;
  fg = foregroundKey();
  const fps = wantedFps(now);
  if (fps !== captureFps) {
    captureFps = fps;
    rateTries = 0;
    slowRestarted = false;
    log(`[capture] ${fps === BACK_FPS ? (minimized ? "WoW minimized" : "WoW in the background") : "WoW in front"}: ${fps} fps`);
    applyRate(now);
  }
  const c = clientRectOnScreen(game.hwnd);
  const f = extendedFrameBounds(game.hwnd);
  if (c && (!client || c.x !== client.x || c.y !== client.y || c.width !== client.width || c.height !== client.height)) {
    client = c;
    gate.rearm(now);
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
  gate.rearm(captureStartedAt); // the link starts over: nothing shown before it approves anything
  if (captureMode === "screen") return startScreenCapture();
  const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
  const id = `window:${game.key}:0`;
  const src = sources.find((s) => s.id === id) ?? sources.find((s) => s.id.startsWith(`window:${game!.key}:`));
  if (!src) {
    log(`[capture] no desktopCapturer source for ${id}`);
    captureStarted = false;
    return;
  }
  const inFrame = clientInFrame(client, frameRect);
  const cfgMsg = {
    sourceId: src.id,
    w: frameRect.width,
    h: frameRect.height,
    fps: openFps(),
    clientX: inFrame.x,
    clientY: inFrame.y,
    clientW: inFrame.width,
    clientH: inFrame.height,
  };
  log(`[capture] start ${src.id} ${cfgMsg.w}x${cfgMsg.h} client@${cfgMsg.clientX},${cfgMsg.clientY} ${cfgMsg.fps} fps`);
  sendStart(cfgMsg);
}

/** Every start opens at openFps(); checkRate lowers it when main wants less, and watches it in front. */
function sendStart(cfgMsg: { fps: number }) {
  rateSentAt = Date.now();
  rateTries = 0;
  capture?.webContents.send("start", cfgMsg);
}

/** The monitor screen capture records for the game, and its top-left in physical px (frame origin). */
const gameDisplay = (c: Rect) => screen.getDisplayMatching(screen.screenToDipRect(null, c));
const displayOrigin = (d: Electron.Display) => physicalOrigin(d.bounds, d.scaleFactor);

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
  if (covering?.length) lastCover = { exe: covering[0].exe, at: Date.now() };
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
  const inFrame = clientInFrame(client, displayOrigin(disp));
  const cfgMsg = { sourceId: src.id, w, h, fps: openFps(), clientX: inFrame.x, clientY: inFrame.y, clientW: inFrame.width, clientH: inFrame.height };
  log(`[capture] start screen ${src.id} ${w}x${h} client@${cfgMsg.clientX},${cfgMsg.clientY} ${cfgMsg.fps} fps`);
  sendStart(cfgMsg);
}

function placeOverlay() {
  if (!overlay || !client) return;
  const dip = screen.screenToDipRect(overlay, client);
  overlay.setBounds(dip);
  overlay.setBounds(screen.screenToDipRect(overlay, client)); // second pass settles mixed-DPI moves
}

function overlayNeeded() {
  if (!layout || layout.ui === false) return false;
  if (layout.panel) return true;
  const m = hub ? currentModel() : undefined;
  return !!((layout.tracker && m?.tracker.length) || m?.toasts.length);
}

function updateVisibility() {
  if (!overlay) return;
  const gameActive = !!game && !minimized && (fg === game.key || fg === overlayKey);
  const want = !paused && gameActive && linked() && overlayNeeded();
  if (want !== overlayShown) {
    overlayShown = want;
    if (want) {
      placeOverlay();
      if (!modelSent) sendModel(); // what changed while it was hidden, before it shows
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
        if (layoutPlace(m) !== layoutPlace(layout)) gate.rearm(Date.now()); // the Glass moves with it
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
        // Hit-test where the mouse really was. This only places the click on the Glass: what the
        // resulting action may grant is decided by the gate, against the Glass's own buttons.
        const rect = (["list", "detail", "tracker", "status"].includes(m.r) ? layout?.[m.r] : undefined) as ClientRect | undefined;
        const proof = corroborateClick(presses, rect, typeof m.x === "number" && typeof m.y === "number" ? { x: m.x, y: m.y } : undefined, Date.now(), toClient);
        if (proof.ok) {
          m.x = proof.x;
          m.y = proof.y;
        }
        log(`[addon] click ${m.r} ${m.x},${m.y} ${m.b} ${proof.ok ? "placed by the mouse" : "as reported: " + proof.why}`);
        overlay?.webContents.send("input", m);
        break;
      }
      case "wheel":
        overlay?.webContents.send("input", m); // not logged: one line per tick, written on this thread
        break;
      default:
        if (m.t === "error") log(`[addon] LUA ERROR in ${m.where}: ${m.err}`);
        else log(describeAddonMessage(m));
        if (m.t === "hello") gate.rearm(Date.now()); // login or /reload: the link starts over
        if (m.t === "key" && m.k === "approve") approveHint(m);
        else hub.handleAddon(m, NO_PROOF);
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
// One sampler feeds two things: the PressLog that corroborates approvals from the game
// (physical.ts), and drag prediction below. Every 10 ms while that input can matter (the Glass is
// showing, it has painted a granting button, a key hint waits for its release, a press may become a
// drag); every 50 ms otherwise. No approval can be proven then: the gate is live only while the
// Glass shows, and a card needs STABLE_MS of live time, all sampled at 10 ms.
const presses = new PressLog();
const VK_SHIFT = 0x10,
  VK_CONTROL = 0x11,
  VK_MENU = 0x12;
const approveBind = () => (cfg.approveKey ? bindingToVk(cfg.approveKey) : undefined);

/** Which cards the Glass has painted and for how long (physical.ts). Approval authority is here:
 * the addon's messages are hints, and none of its rectangles (layout.keys, layout.detail) is used. */
const gate = new ApprovalGate();
/** Where the addon's window sits; a change moves the Glass, so every card waits again. */
const layoutPlace = (l: any) => JSON.stringify(l ? [l.scr, l.win, l.list, l.detail, l.panel, l.focus, l.ui] : null);

/** "key approve" from the game says only that something asked to approve. It counts when the
 * registered Approve key was really pressed and released while the Glass showed the request; the
 * hub then checks the proof names the request it would approve. A hint that arrives while the key
 * is still down waits for the release. */
let heldHint: { m: any; until: number } | undefined;
function approveHint(m: any) {
  const now = Date.now();
  const proof: Proof = m.src === "slash" ? { ok: false, how: "none", why: "slash commands cannot approve" } : gate.proveKey(presses, approveBind(), now);
  if (proof.why === KEY_HELD) heldHint ??= { m, until: now + KEY_WINDOW_MS };
  else hub.handleAddon(m, proof);
}

/** The Glass shows how to approve: by the key alone, or by click too (config approveByClick). */
let approveSent = "";
function sendApprove(force = false) {
  const a = { byClick: !!cfg.approveByClick, key: approveBind() ? cfg.approveKey : "" };
  if (!force && JSON.stringify(a) === approveSent) return;
  approveSent = JSON.stringify(a);
  overlay?.webContents.send("approve", a);
}

// Drag prediction: watches for a press-and-move on the window's frame so following starts before
// "dragstart" arrives (that takes a strip frame or two).
let press: { x: number; y: number; zone: ReturnType<typeof dragZone> } | null = null;
const SAMPLE_FAST_MS = 10;
const SAMPLE_SLOW_MS = 50;
/** Buttons and keys at the last sample: a change is a press or release ("edge"). */
let lastInput = "";
function sampleInput() {
  const now = Date.now();
  if (!game) return gate.setLive(false, now);
  const c = cursorPos();
  const bind = approveBind();
  const down = new Set<number>();
  if (bind && keyDown(bind.vk)) down.add(bind.vk);
  const left = leftButtonDown();
  const right = rightButtonDown();
  const ctrl = keyDown(VK_CONTROL),
    shift = keyDown(VK_SHIFT),
    alt = keyDown(VK_MENU);
  const input = `${+left}${+right}${+down.size}${+ctrl}${+shift}${+alt}`;
  // A card counts only while the Glass shows and the game (or the Glass) is the foreground window.
  // tick() reads the foreground every 100 ms; at any press or release (a click elsewhere, Alt-Tab,
  // the Approve key) with a card on the Glass it is read here and now, before the input is logged,
  // so input made as focus leaves the game never counts and leaving voids the cards' wait.
  if (input !== lastInput && gate.size) fg = foregroundKey();
  lastInput = input;
  gate.setLive(overlayShown && !minimized && (fg === game.key || fg === overlayKey), now);
  presses.sample({ at: now, x: c?.x ?? -1e6, y: c?.y ?? -1e6, left, right, down, ctrl, shift, alt });
  if (heldHint && !(bind && down.has(bind.vk))) {
    const h = heldHint;
    heldHint = undefined;
    if (Date.now() <= h.until) hub.handleAddon(h.m, gate.proveKey(presses, bind, Date.now()));
  }
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
}
(function sampleLoop() {
  try {
    sampleInput();
  } catch (e) {
    log("[input] " + e);
  }
  const fast = overlayShown || gate.size > 0 || !!heldHint || !!press;
  setTimeout(sampleLoop, fast ? SAMPLE_FAST_MS : SAMPLE_SLOW_MS);
})();

// ---- render pushes ------------------------------------------------------------------------------
// The Glass gets the render model only while it shows (once more the moment it shows again), and a
// streaming reply at most every DELTA_PUSH_MS; anything else (the turn ending, a toast, a card) is
// pushed within PUSH_MS. The model itself is built only when something needs it.
const PUSH_MS = 40;
const DELTA_PUSH_MS = 150;
let lastModel: ReturnType<typeof buildModel> | undefined;
/** The hub changed since lastModel was built / since the Glass last got it. */
let modelStale = true;
let modelSent = false;
let pushTimer: NodeJS.Timeout | undefined;
let pushDue = 0;
function schedulePush(why?: string) {
  const due = Date.now() + (why === "delta" ? DELTA_PUSH_MS : PUSH_MS);
  if (pushTimer && pushDue <= due) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushDue = due;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    pushAll();
  }, due - Date.now());
}

function currentModel() {
  if (modelStale || !lastModel) {
    lastModel = buildModel(hub, { linked: linked(), fps: captureStats.fps ?? 0 });
    modelStale = false;
  }
  return lastModel;
}

function sendModel() {
  if (!overlay || !hub) return;
  overlay.webContents.send("model", currentModel());
  if (layout) overlay.webContents.send("layout", layout);
  modelSent = true;
}

/** "Copy reply" on the Glass: that reply's text onto the Windows clipboard. Like any clicked Glass
 * action that does something outside the game, it needs a real mouse release inside the Glass's
 * own Copy button for exactly this reply (the gate's proof; the Glass paints that button with act
 * { type: "copyReply", thread, label: <entry id> }); the addon's word never writes the clipboard.
 * Quests only: a desktop thread's history entries have no stable ids to bind the proof to. */
function copyReply(a: { thread?: unknown; entry?: unknown }, now: number, trusted?: Proof) {
  const thread = typeof a.thread === "string" ? a.thread : "";
  const entry = typeof a.entry === "string" ? a.entry : "";
  const key = actKey({ type: "copyReply", thread, label: entry });
  const proof = trusted ?? (gate.has(key) ? gate.proveClick(presses, key, client, now) : NO_PROOF);
  if (!proofCovers(proof, key)) {
    log(`[copy] refused: ${proof.why ?? "no proof for this button"}`);
    return hub.toast("That click could not be matched to your mouse on that button. Move onto it and click again.", "info");
  }
  const e = hub.replyText(thread, entry);
  if (!e?.text.trim()) return hub.toast("Nothing to copy.", "info");
  if (e.streaming) return hub.toast("The reply is still being written. Copy it when it is done.", "info");
  clipboard.writeText(e.text);
  log(`[copy] reply copied to the clipboard (${e.text.length} characters)`);
  hub.toast("Copied", "info");
}

/** Requests that already had a Windows notice (thread + request id): one balloon per request. */
const noticed = new Set<string>();
const noticeKey = (thread: string | undefined, requestId: string) => `${thread ?? ""}\0${requestId}`;
function markNoticed(key: string) {
  noticed.add(key);
  if (noticed.size > 500) noticed.delete(noticed.values().next().value!);
}
const gameInFront = () => !!game && !minimized && (fg === game.key || fg === overlayKey);

/** An approval toast, or a finished turn's, while WoW isn't in front (or is minimized): a Windows
 * notice, so a request or an answer doesn't sit unseen while you're at the desk. One per request,
 * one per finished turn (its toast; a toast held through a fight keeps its id). Its click opens the
 * control panel (balloon-click), which lists every pending request. Never moves focus; generic
 * under Hide names; trayNoticeFor (notices.ts) decides, under the same on/off setting. */
function noticeFor(x: Toast) {
  const key = x.kind === "approval" ? (x.requestId ? noticeKey(x.threadId, x.requestId) : undefined) : x.kind === "done" ? `done\0${x.id}` : undefined;
  if (!key || noticed.has(key)) return;
  const t = x.threadId ? hub.threads.get(x.threadId) : undefined;
  if (t?.kind === "tutorial") return;
  const n = trayNoticeFor({ kind: x.kind, project: t ? hub.projectName(t) : undefined, questTitle: t?.title },
    { gameInFront: gameInFront(), privateMode: !!cfg.privateMode, trayNotices: cfg.trayNotices !== false });
  if (!n || !tray) return;
  markNoticed(key);
  tray.displayBalloon({ title: n.title, content: n.content, noSound: true, respectQuietTime: true });
  log(`[notice] ${x.kind === "done" ? "quest finished" : "request waiting"} while WoW isn't in front: Windows notice shown`);
}

/** A request too long for the in-game card waits on the PC: make the control panel easy to reach
 * without moving focus (never from the game, never a forced foreground): its taskbar button
 * flashes, or, while it is closed to the tray, a quiet tray notice opens it when clicked (unless
 * that request already had one). */
let requestsWaiting = false;
function surfaceRequests() {
  requestsWaiting = true;
  refreshTray();
  if (control && !control.isDestroyed() && control.isVisible()) return void control.flashFrame(true);
  const fresh = hub.pendingRequests().filter((r) => r.cut && !noticed.has(noticeKey(r.thread, r.requestId)));
  if (!fresh.length) return;
  for (const r of fresh) markNoticed(noticeKey(r.thread, r.requestId));
  tray?.displayBalloon({ title: "A request is waiting on your PC", content: "Too long for the in-game card. Open Familiar to review it, or Deny it in game.", noSound: true, respectQuietTime: true });
}

/** Nothing waits any more (decided, expired): stop asking for attention. */
function settleRequests() {
  if (!requestsWaiting || hub.pendingRequests().some((r) => r.cut)) return;
  requestsWaiting = false;
  refreshTray();
  if (control && !control.isDestroyed()) control.flashFrame(false);
}

/** The tray's badge and tooltip follow the work (counts only, never a name; tray-badge.ts). */
let trayShown = { badge: "none" as TrayBadge, tooltip: "" };
function refreshTray() {
  if (!tray) return;
  // activity().working also counts quests waiting on you; the tray counts those once, under "waiting on you".
  const work = hub ? { working: [...hub.threads.values()].filter((t) => t.status === "running").length, approvals: activity(hub).approvals } : null;
  const next = trayBadgeFor(work, requestsWaiting);
  if (next.badge !== trayShown.badge) tray.setImage(trayIcon(next.badge));
  if (next.tooltip !== trayShown.tooltip) tray.setToolTip(next.tooltip);
  trayShown = next;
}

function pushAll() {
  if (!hub) return;
  settleRequests();
  refreshTray();
  modelStale = true;
  modelSent = false;
  sendApprove();
  updateVisibility(); // pushes the model if the Glass turns visible
  if (overlayShown && !modelSent) sendModel();
  sendStatus();
}

function uiSettings() {
  return { fontScale: cfg.fontScale, sound: cfg.sound, soundVolume: cfg.soundVolume, raidWarnings: cfg.raidWarnings !== false, quiet: !!cfg.quiet, privateMode: !!cfg.privateMode,
    streamSafe: !!cfg.privateMode && !!cfg.blurTranscript, defaultMode: cfg.defaultMode, approveKey: cfg.approveKey ?? "", trayNotices: cfg.trayNotices !== false,
    approveByClick: cfg.approveByClick === true, inheritAgentConfig: cfg.inheritAgentConfig === true, privacy: privacyOf(cfg) };
}

/** The addon's Interface list (Familiar.toc), read again only when the file changes or the addon is
 * reinstalled, not on every status snapshot. */
let tocCache: { mtime: number; list: number[] } | undefined;
function addonInterfaces(): number[] {
  const toc = path.join(REPO_ADDON, "Familiar.toc");
  let mtime = -1;
  try {
    mtime = fs.statSync(toc).mtimeMs;
  } catch {
    /* missing: tocInterfaces says [] */
  }
  if (tocCache?.mtime !== mtime) tocCache = { mtime, list: tocInterfaces(toc) };
  return tocCache.list;
}

function statusSnapshot() {
  return {
    version: VERSION,
    build: RUNNING_BUILD,
    storage: hub?.storage,
    work: hub ? activity(hub) : null,
    game: game ? { exe: game.exe, title: game.title, cls: game.cls, client, frame: frameRect, minimized, foreground: fg === game.key } : null,
    capture: { ...captureStats, mode: captureMode, wantFps: captureFps },
    linked: linked(),
    lastMsgAgo: lastMsgAt ? Date.now() - lastMsgAt : null,
    addon: hub?.addon,
    layout: layout ? { panel: layout.panel, scr: layout.scr, px: layout.px, ui: layout.ui } : null,
    overlay: { shown: overlayShown, paused },
    backends: hub ? Object.fromEntries(Object.entries(hub.backends).map(([id, b]) => [id, { ...b.status(), label: providerInfo(id).label }])) : null,
    install: install ? { dir: install.dir, flavor: install.flavor, source: install.source, product: install.product, version: install.version, iface: install.iface } : null,
    installError: install ? undefined : installError,
    // One line: does the addon's Interface list cover the detected client?
    wow: install ? interfaceCheck(install, addonInterfaces()) : null,
    wrongClient: wrongClient ? { exe: wrongClient.exe, dir: wrongClient.dir } : null,
    installNotes,
    threads: hub ? hub.threads.size : 0,
    // The quest open in the game, for the panel's Mode control (cmd "questMode"; never set from the game).
    // `id` goes back with the choice, so a quest opened since is never changed in its place.
    quest: ((t) => (t && !t.kind && !hub.view.draft ? { id: t.id, title: t.title, mode: t.mode } : null))(hub?.selectedThread()),
    projects: projectsStatus(),
    configPath: path.join(appDataDir(), "config.json"),
    launchAtLogin: cfg.launchAtLogin,
    ui: uiSettings(),
    // "Requests waiting": pending approvals in full (decided here via "decide"; cut ones only here).
    requests: hub ? hub.pendingRequests() : [],
    claude: claudeStatus(),
    doctor: doctorNow(),
    // Versions: the addon's (hello) against this app's, and the last "Check for updates" answer.
    update: { app: VERSION, addon: hub?.addon.addon, mismatch: !!hub?.versionMismatch(), last: lastUpdateCheck },
    providers: providersNow(),
    logPath: logFile,
  };
}

/** The Link Doctor's line for the status and Copy diagnostics (doctor.ts). Frame statistics older
 * than 2.5 s mean no frames arrive (the capture page only reports while they do). */
function doctorNow() {
  const c = captureStats ?? {};
  const now = Date.now();
  return linkDoctor({ game: !!game, minimized, foreground: !!game && (fg === game.key || fg === overlayKey), captureMode,
    stats: { fps: now - statsAt < 2500 ? c.fps ?? 0 : 0, crc: c.crc ?? 0, lock: c.lock, lastOk: c.lastOk ?? 0, rampAt: c.rampAt ?? 0 },
    startedAt: searchSince, now, refusedExe: lastCover && now - lastCover.at < 5000 ? lastCover.exe : undefined });
}

// ---- "Save what Familiar sees" ----------------------------------------------------------------
// The capture page crops the top-left 320x32 px of the game frame (around the strip when it is
// locked) from the next frame; main checks the size and writes a PNG into %APPDATA%\Familiar.
// Never the whole frame: the player looks at it before attaching it to a bug report.
const SNAPSHOT_W = 320;
const SNAPSHOT_H = 32;
let snapSeq = 0;
const snapWaits = new Map<number, (r: any) => void>();
let lastSnapshot: string | undefined;
const stamp = (d = new Date()) => {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
};

async function captureSnapshot(): Promise<{ ok: boolean; file?: string; why?: string }> {
  if (!capture || capture.isDestroyed() || !game || !captureStarted || minimized)
    return { ok: false, why: "Familiar isn't reading the WoW window right now. Open WoW in Windowed or Windowed (Fullscreen) and keep it on screen." };
  const id = ++snapSeq;
  const r = await new Promise<any>((resolve) => {
    snapWaits.set(id, resolve);
    setTimeout(() => snapWaits.delete(id) && resolve({ error: "no picture of the game arrived within 3 s" }), 3000);
    capture!.webContents.send("snapshot", { id, width: SNAPSHOT_W, height: SNAPSHOT_H });
  });
  if (r?.error) return { ok: false, why: `Nothing saved: ${String(r.error).slice(0, 200)}.` };
  const w = r?.width, h = r?.height;
  const data = r?.data instanceof Uint8Array ? Buffer.from(r.data) : null;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > SNAPSHOT_W || h > SNAPSHOT_H || !data || data.length !== w * h * 4)
    return { ok: false, why: "Nothing saved: the picture had an unexpected size." };
  for (let o = 0; o < data.length; o += 4) [data[o], data[o + 2]] = [data[o + 2], data[o]]; // RGBA -> BGRA (createFromBitmap)
  const file = path.join(appDataDir(), `strip-${stamp()}.png`);
  try {
    fs.writeFileSync(file, nativeImage.createFromBitmap(data, { width: w, height: h }).toPNG());
  } catch (e: any) {
    return { ok: false, why: `Nothing saved: ${e?.message ?? e}` };
  }
  lastSnapshot = file;
  log(`[capture] saved what Familiar sees (${w}x${h} px) as ${path.basename(file)}`);
  return { ok: true, file };
}

/** Zones for the control panel's Projects card: the folders you added, and how many came from history. */
function projectsStatus() {
  return hub ? hub.projectsSummary() : { explicit: [...cfg.projects], roots: [...cfg.projectRoots], history: 0 };
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
  const check = install ? interfaceCheck(install, addonInterfaces()) : null;
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
    link: (({ step, text }) => `${step}: ${text}`)(doctorNow()),
    capture: `mode ${captureMode}${captureMode === "screen" ? " (messages accepted only while WoW is in front and uncovered)" : ""}, fps ${c.fps ?? 0} (wanted ${captureFps}, cap ${c.fpsCap ?? "?"}), lock ${c.lock ? "yes" : "no"}, linked ${linked() ? "yes" : "no"}, game ${game ? (minimized ? "minimized" : fg === game.key ? "foreground" : "background") : "not found"}, overlay ${paused ? "paused" : overlayShown ? "shown" : "hidden"}${c.error ? `, error: ${c.error}` : ""}`,
    providers: providersNow().map((p) => `${p.id} ${p.installed ? "installed" : "not installed"}${p.signedIn === undefined ? "" : p.signedIn ? ", signed in" : ", not signed in"}${p.enabled ? ", on" : ", off"}`),
    configKeys: changedConfigKeys(cfg as unknown as Record<string, unknown>, DEFAULT_CONFIG as unknown as Record<string, unknown>),
    log: logRing.slice(-80),
  });
}

/** Status goes to the control panel only while it is on screen (not closed or minimized to the
 * tray); it gets one the moment it shows again (createControl). */
const panelShown = () => !!control && !control.isDestroyed() && control.isVisible() && !control.isMinimized();
let statusTimer: NodeJS.Timeout | undefined;
function sendStatus() {
  if (!panelShown() || statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = undefined;
    if (panelShown()) control!.webContents.send("status", statusSnapshot());
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
  tocCache = undefined; // (re)installing: read the addon's Interface list afresh
  const check = interfaceCheck(install, addonInterfaces());
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
    if (s.state !== "present" || !missing || !hub.enabled("claude")) return;
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
  // The Glass plays every cue, panel-made approvals included; no overlay (WoW closed), no sound.
  hub.onSound = (k) => {
    const m = soundMessage(cfg, k);
    if (m) overlay?.webContents.send("sound", m);
  };
  hub.onCutRequest = surfaceRequests;
  hub.onToast = noticeFor;
  hub.onConfigChanged = (c) => {
    saveConfig(c);
    applyLoginItem();
    sendStatus();
  };
  snapshot = new SnapshotWriter(hub, () => (install ? path.join(install.addons, "FamiliarSync", "FamiliarSync.lua") : null), log);
  hub.on((why) => {
    schedulePush(why);
    if (why !== "delta") snapshot.schedule();
  });

  doInstall(false);
  // Start with Windows is opt-in (the control panel's checkbox, never the game); this only syncs the
  // registry entry with the setting and removes the legacy one.
  applyLoginItem();

  createOverlay();
  createCapture();
  createTray();
  if (!process.argv.includes("--background")) createControl();

  ipcMain.on("msgs", (e, msgs) => {
    if (!from(e, capture) || !Array.isArray(msgs)) return;
    const verdict = screenGate();
    if (!verdict.ok) {
      if (screenRefusals.shouldLog(Date.now())) log(`[capture] screen mode: dropped ${msgs.length} message(s): ${verdict.why}`);
      return;
    }
    onAddonMessages(msgs);
  });
  ipcMain.on("stats", (e, s) => {
    if (!from(e, capture)) return;
    const wasLinked = linked();
    captureStats = s;
    statsAt = Date.now();
    checkRate(s, statsAt);
    if (linked() !== wasLinked) {
      gate.rearm(Date.now()); // reconnect: nothing shown before it approves anything
      log(`[link] ${linked() ? "linked" : "lost"} (fps ${s.fps}, decoded ${s.decoded}, crc ${s.crc}, missed ${s.missed})`);
      pushAll();
    }
    sendStatus();
  });
  ipcMain.on("snapshot", (e, r) => {
    if (!from(e, capture) || !r || typeof r.id !== "number") return;
    const done = snapWaits.get(r.id);
    if (done && snapWaits.delete(r.id)) done(r);
  });
  ipcMain.on("log", (e, s) => {
    if (from(e, capture) || from(e, overlay) || from(e, control)) log(String(s));
  });
  // Where the Glass painted the buttons that grant something: the only rectangles approvals use.
  ipcMain.on("painted", (e, list) => {
    if (from(e, overlay)) gate.report(list, Date.now());
  });
  ipcMain.on("action", (e, a) => {
    if (!from(e, overlay) || !a || typeof a !== "object") return;
    log(describeOverlayAction(a));
    if (a.type === "copyReply") return copyReply(a, Date.now());
    // An action grants something only with a real release inside the Glass's own button for exactly
    // this action, on a card that had settled (physical.ts); one release, one action.
    const key = actKey(a);
    const proof = gate.has(key) ? gate.proveClick(presses, key, client, Date.now()) : NO_PROOF;
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
      case "reloadConfig": {
        const previous = cfg;
        cfg = loadConfig(log);
        for (const id of Object.keys(hub.backends))
          if (previous.providers?.[id]?.enabled !== false && !hub.enabled(id)) hub.providerDisabled(id);
        hub.reloadProjects(); // folders removed from config.json go too
        hub.changed("config");
        return true;
      }
      case "providerEnable": {
        const { id, on } = args as { id: string; on: boolean };
        if (!on) hub.providerDisabled(id);
        cfg.providers = { ...cfg.providers, [id]: { ...cfg.providers?.[id], enabled: !!on } };
        saveConfig(cfg);
        if (on && !hub.backends[id]) {
          const b = makeAcpBackend(id);
          if (b) hub.addBackend(id, b);
        } else if (on) hub.wake().then(() => hub.enabled(id) ? hub.backends[id].init() : undefined).then(() => hub.refreshExternal()).catch(() => {});
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
      case "uiSettings":
        // The hub's one settings write path checks and clamps each value and saves once.
        hub.settings(args && typeof args === "object" ? args : {});
        return uiSettings();
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
      case "questMode": {
        // The mode of the quest open in the game. Only here: the game cannot change modes.
        const { mode, thread } = (args ?? {}) as { mode?: unknown; thread?: unknown };
        if (!MODES.includes(mode as Mode)) return { ok: false, why: "Unknown mode." };
        const r = await hub.setSelectedMode(mode as Mode, String(thread ?? ""));
        sendStatus();
        return r;
      }
      case "launchAtLogin":
        hub.settings({ launchAtLogin: !!args }); // onConfigChanged saves and applies the startup entry
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
      // Claude download, Link Doctor snapshot, project folders, versions (round 4).
      case "claudeRetry":
        return startClaudeDownload("retry");
      case "captureSnapshot":
        return captureSnapshot();
      case "openSnapshot":
        // Shows the last saved picture in Explorer (or the Familiar folder); no path from the page.
        if (lastSnapshot && fs.existsSync(lastSnapshot)) shell.showItemInFolder(lastSnapshot);
        else await shell.openPath(appDataDir());
        return true;
      case "projectAdd": {
        // The folder dialog belongs to the panel window; nothing is added unless a folder is picked.
        const kind = (args as { kind?: unknown } | undefined)?.kind === "root" ? "root" : "project";
        const pick = await dialog.showOpenDialog(control!, { title: kind === "root" ? "Add a folder of projects" : "Add a project folder", properties: ["openDirectory"] });
        if (pick.canceled || !pick.filePaths[0]) return { ok: false };
        const r = hub.addProjectFolder(pick.filePaths[0], kind);
        log(`[projects] add ${kind === "root" ? "a folder of projects" : "a project folder"}: ${r.ok ? "added" : r.why}`);
        sendStatus();
        return r;
      }
      case "projectRemove": {
        const r = hub.removeProjectFolder(String((args as { path?: unknown } | undefined)?.path ?? ""));
        sendStatus();
        return r;
      }
      case "checkUpdate":
        // The player's click only: one GET to GitHub's latest release (update.ts). Never scheduled.
        log("[update] Check for updates: asking GitHub for the latest release");
        lastUpdateCheck = await checkUpdate(VERSION);
        log(`[update] ${lastUpdateCheck.error ?? `latest ${lastUpdateCheck.latest}${lastUpdateCheck.newer ? " (newer than this app)" : ""}`}`);
        sendStatus();
        return lastUpdateCheck;
      case "openUrl": {
        // "Open the download page": only the release page Check for updates returned.
        const url = String((args as { url?: unknown } | undefined)?.url ?? "");
        if (url && url === lastUpdateCheck?.url && isReleasesUrl(url)) await shell.openExternal(url).catch((e) => log(`[open] ${e}`));
        return undefined;
      }
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
      if (url === "/model") return currentModel();
      if (url === "/simulate") return onAddonMessages([JSON.parse(body)]) ?? true;
      if (url === "/action") {
        // The token-gated dev hook stands in for a real click.
        const a = JSON.parse(body);
        if (a?.type === "copyReply") return copyReply(a, Date.now(), TRUSTED);
        return hub.action(a, TRUSTED) ?? true;
      }
      if (url === "/snap") return await snap(body || path.join(appDataDir(), "snap.png"));
      if (url === "/capture-snapshot") return await captureSnapshot(); // e2e: the panel's "Save what Familiar sees"
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
  const img = src.thumbnail.crop(clientInFrame(client, displayOrigin(disp)));
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

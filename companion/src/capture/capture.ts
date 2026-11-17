// Hidden capture renderer: reads the WoW window via Windows.Graphics.Capture (Electron
// desktopCapturer), finds the Runestrip, decodes frames and reassembles messages. The decoder
// (link/decoder.ts StripDecoder) decides which parts of each frame to read; this page only reads
// them out of the video frame.
//
// Messages from main: "start" (StartCfg), "stop", "snapshot" ({ id, width, height }) and
// "rate" ({ fps }): cap the running track at `fps` frames per second (1..60) without restarting
// the stream. A later "start" uses its own `fps`. The addon holds each strip frame >= 70 ms, so a
// cap under ~15 fps misses frames of multi-frame messages: main lowers it only while that is fine.
// Stats report `fps` (frames received in the last second: the effective rate) and `fpsCap` (the
// cap the track reports).
import { crc16, FLAG_IDLE, Reassembler } from "../link/codec";
import { Box, StripDecoder, View } from "../link/decoder";
import { clientCorners } from "../main/geometry";
import type { CaptureBridge } from "../shared/bridge";
const bridge = window.familiar as CaptureBridge;

interface StartCfg {
  sourceId: string;
  w: number;
  h: number;
  fps: number;
  /** Client-area origin inside the captured frame (title bar offset when windowed). */
  clientX: number;
  clientY: number;
  /** Client size (frame px). Absent: the client reaches the frame's bottom-right (window capture). */
  clientW?: number;
  clientH?: number;
}

let session = 0;
let stream: MediaStream | null = null;
let current: { track: MediaStreamTrack; cfg: StartCfg } | null = null;

const stats = {
  fps: 0,
  fpsCap: 0,
  frames: 0,
  decoded: 0,
  crc: 0,
  missed: 0,
  msgs: 0,
  locked: false,
  lock: null as null | { x: number; y: number; pitch: number },
  lastOk: 0,
  /** When the finder was last seen with its grey ramp collapsed or clipped (ms epoch, 0 = never). */
  rampAt: 0,
  frameW: 0,
  frameH: 0,
  error: "",
};

const td = new TextDecoder();
const reasm = new Reassembler((_id, payload) => {
  const text = td.decode(payload);
  try {
    const msg = JSON.parse(text);
    stats.msgs++;
    bridge.send("msgs", [msg]);
  } catch {
    // Never the text itself: the log must not contain what the player typed.
    bridge.send("log", `[capture] bad json: ${payload.length} bytes, crc16 ${crc16(payload).toString(16).padStart(4, "0")}`);
  }
});

bridge.on("stop", () => stop());
// "Save what Familiar sees": main asks for a small crop of the next frame (see takeSnapshot).
let snapshotWanted: { id: number; width: number; height: number } | null = null;
bridge.on("snapshot", (r: { id: number; width: number; height: number }) => {
  if (!stream) return bridge.send("snapshot", { id: r.id, error: "Familiar isn't reading the WoW window right now" });
  snapshotWanted = r;
});
bridge.on("start", (cfg: StartCfg) => {
  start(cfg).catch((e) => {
    stats.error = String(e?.message ?? e);
    bridge.send("log", "[capture] start failed: " + stats.error);
  });
});
try {
  bridge.on("rate", (r: { fps: number }) => {
    setRate(r?.fps).catch((e) => bridge.send("log", "[capture] rate failed: " + String(e?.message ?? e)));
  });
} catch {
  // The capture preload must list "rate" among the channels main may send.
  bridge.send("log", "[capture] rate control unavailable: the preload does not pass the rate message");
}

async function setRate(fps: number) {
  const f = Math.round(Number(fps));
  if (!current || !(f > 0)) return;
  const { track, cfg } = current;
  const max = Math.min(60, Math.max(1, f));
  // applyConstraints replaces every constraint, so the size stays pinned to the frame.
  await track.applyConstraints({ width: { min: cfg.w, max: cfg.w }, height: { min: cfg.h, max: cfg.h }, frameRate: { max } });
  if (current?.track !== track) return;
  stats.fpsCap = track.getSettings().frameRate ?? max;
  bridge.send("log", `[capture] frame rate capped at ${max} fps (track reports ${stats.fpsCap})`);
}

function stop() {
  session++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  current = null;
  stats.locked = false;
}

async function start(cfg: StartCfg) {
  stop();
  const my = ++session;
  stats.error = "";
  const s = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // @ts-expect-error Chromium desktop-capture constraints
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: cfg.sourceId,
        minWidth: cfg.w,
        maxWidth: cfg.w,
        minHeight: cfg.h,
        maxHeight: cfg.h,
        maxFrameRate: cfg.fps,
      },
    },
  });
  if (my !== session) {
    // A newer start (or stop) arrived while we were waiting for the stream.
    s.getTracks().forEach((t) => t.stop());
    return;
  }
  stream = s;
  const track = s.getVideoTracks()[0];
  current = { track, cfg };
  stats.fpsCap = track.getSettings().frameRate ?? cfg.fps;
  const proc = new window.MediaStreamTrackProcessor({ track });
  const reader = proc.readable.getReader();
  // The strip is anchored to a client corner: search those before the whole frame.
  const client = { x: cfg.clientX, y: cfg.clientY, width: cfg.clientW ?? cfg.w - cfg.clientX, height: cfg.clientH ?? cfg.h - cfg.clientY };
  const dec = new StripDecoder({ hints: clientCorners({ width: cfg.w, height: cfg.h }, client) });
  let lastDiag = 0;
  let lastSeq = -1;
  let fpsCount = 0;
  let fpsAt = performance.now();
  const bufs: Uint8Array[] = [];

  /** Copy part of the frame (even-aligned: the frame is I420) into the reusable buffer `slot`. */
  async function region(frame: any, b: Box, slot: number): Promise<View> {
    const fw = frame.displayWidth,
      fh = frame.displayHeight;
    const x0 = Math.max(0, Math.floor(b.x)) & ~1;
    const y0 = Math.max(0, Math.floor(b.y)) & ~1;
    const x1 = Math.min(fw & ~1, (Math.min(fw, Math.ceil(b.x + b.w)) + 1) & ~1);
    const y1 = Math.min(fh & ~1, (Math.min(fh, Math.ceil(b.y + b.h)) + 1) & ~1);
    const rw = Math.max(2, x1 - x0),
      rh = Math.max(2, y1 - y0);
    const size = rw * rh * 4;
    if (!bufs[slot] || bufs[slot].length < size) bufs[slot] = new Uint8Array(size);
    const data = bufs[slot].subarray(0, size);
    await frame.copyTo(data, { rect: { x: x0, y: y0, width: rw, height: rh }, format: "RGBA", colorSpace: "srgb" });
    return { width: rw, height: rh, data, ox: x0, oy: y0 };
  }

  while (my === session) {
    const { value: frame, done } = await reader.read();
    if (done || my !== session) {
      frame?.close();
      break;
    }
    try {
      if (snapshotWanted) {
        const want = snapshotWanted;
        snapshotWanted = null;
        await takeSnapshot(frame, want);
      }
      stats.frames++;
      fpsCount++;
      const fw = frame.displayWidth,
        fh = frame.displayHeight;
      stats.frameW = fw;
      stats.frameH = fh;
      const now = performance.now();
      if (now - fpsAt >= 1000) {
        stats.fps = Math.round((fpsCount * 1000) / (now - fpsAt));
        fpsCount = 0;
        fpsAt = now;
        stats.locked = !!dec.lock && Date.now() - stats.lastOk < 2500;
        stats.lock = dec.lock;
        bridge.send("stats", { ...stats });
      }
      // Locked: the strip's box. Searching: the client corners often, the whole frame now and then.
      const boxes = dec.plan(now, fw, fh);
      if (!boxes.length) continue;
      const views: View[] = [];
      for (let i = 0; i < boxes.length; i++) views.push(await region(frame, boxes[i], i));
      const wasLocked = !!dec.lock;
      const r = dec.decode(views, now);
      if (r.ok) {
        if (!wasLocked) {
          bridge.send("log", `[capture] locked at ${r.lock.x.toFixed(1)},${r.lock.y.toFixed(1)} pitch ${r.lock.pitch.toFixed(2)}`);
          // Main's screen-capture gate checks where the strip is: tell it before this lock's messages.
          stats.lock = dec.lock;
          bridge.send("stats", { ...stats });
        }
        handle(r.frame);
        continue;
      }
      if (wasLocked && r.reason === "crc") stats.crc++;
      if (r.reason === "ramp") stats.rampAt = Date.now();
      const full = !wasLocked && views.length === 1 && views[0].width >= (fw & ~1) && views[0].height >= (fh & ~1);
      if (full && Date.now() - lastDiag > 10_000) {
        lastDiag = Date.now();
        const img = views[0];
        if (r.reason === "ramp" && r.levels)
          bridge.send("log", `[capture] strip seen but its grey steps run together (HDR or a colour filter?): R ${r.levels[0].map(Math.round).join("/")} G ${r.levels[1].map(Math.round).join("/")} B ${r.levels[2].map(Math.round).join("/")}`);
        // Diagnostics: what does the client's top-left corner look like in the capture?
        const px = (x: number, y: number) => {
          const o = ((y - (img.oy ?? 0)) * img.width + (x - (img.ox ?? 0))) * 4;
          return `${img.data[o]},${img.data[o + 1]},${img.data[o + 2]}`;
        };
        const ys = [cfg.clientY - 1, cfg.clientY, cfg.clientY + 2];
        const xs = Array.from({ length: 36 }, (_, i) => i);
        bridge.send("log", `[capture] no strip; frame ${img.width}x${img.height} client@${cfg.clientX},${cfg.clientY} samples ` + ys.map((y) => xs.map((x) => px(x, y)).join(" ")).join(" | "));
      }
    } catch (e: any) {
      stats.error = String(e?.message ?? e);
    } finally {
      frame.close();
    }
  }

  /** The top-left of the game: `want` px (320x32) from the client corner, or from just above-left of
   * the strip while it is locked (screen capture: wherever it sits). Never more than asked for. */
  async function takeSnapshot(frame: any, want: { id: number; width: number; height: number }) {
    const fw = frame.displayWidth,
      fh = frame.displayHeight;
    const w = Math.min(want.width, fw) & ~1,
      h = Math.min(want.height, fh) & ~1;
    const at = dec.lock ? { x: dec.lock.x - 6, y: dec.lock.y - 6 } : { x: cfg.clientX, y: cfg.clientY };
    const x = Math.max(0, Math.min(fw - w, Math.floor(at.x))) & ~1;
    const y = Math.max(0, Math.min(fh - h, Math.floor(at.y))) & ~1;
    try {
      const img = await region(frame, { x, y, w, h }, 0);
      bridge.send("snapshot", { id: want.id, width: img.width, height: img.height, data: img.data.slice(0, img.width * img.height * 4) });
    } catch (e: any) {
      bridge.send("snapshot", { id: want.id, error: String(e?.message ?? e) });
    }
  }

  function handle(f: { seq: number; flags: number } & any) {
    stats.decoded++;
    stats.lastOk = Date.now();
    if (f.seq !== lastSeq) {
      if (lastSeq >= 0) {
        const gap = (f.seq - lastSeq + 65536) % 65536;
        if (gap > 1 && gap < 1000) stats.missed += gap - 1;
      }
      lastSeq = f.seq;
    }
    if (!(f.flags & FLAG_IDLE)) reasm.push(f);
  }
}

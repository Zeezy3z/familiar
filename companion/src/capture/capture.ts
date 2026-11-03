// Hidden capture renderer: reads the WoW window via Windows.Graphics.Capture (Electron
// desktopCapturer), finds the Runestrip, decodes frames and reassembles messages.
import { crc16, FLAG_IDLE, Reassembler } from "../link/codec";
import { acquire, decodeAt, findStrip, MAX_COLS, MAX_ROWS, Rgba, StripLock } from "../link/decoder";
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
}

let session = 0;
let stream: MediaStream | null = null;

const stats = {
  fps: 0,
  frames: 0,
  decoded: 0,
  crc: 0,
  missed: 0,
  msgs: 0,
  locked: false,
  lock: null as null | { x: number; y: number; pitch: number },
  lastOk: 0,
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
bridge.on("start", (cfg: StartCfg) => {
  start(cfg).catch((e) => {
    stats.error = String(e?.message ?? e);
    bridge.send("log", "[capture] start failed: " + stats.error);
  });
});

function stop() {
  session++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
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
  const proc = new window.MediaStreamTrackProcessor({ track });
  const reader = proc.readable.getReader();
  let lock: StripLock | null = null; // in frame coordinates
  let lastSearch = 0;
  let lastDiag = 0;
  let lastFull = 0;
  let lastSeq = -1;
  let crcStreak = 0;
  let fpsCount = 0;
  let fpsAt = performance.now();
  const buf = { data: new Uint8Array(0) };

  async function region(frame: any, x: number, y: number, w: number, h: number): Promise<Rgba & { ox: number; oy: number }> {
    const fw = frame.displayWidth,
      fh = frame.displayHeight;
    let x0 = Math.max(0, Math.floor(x)) & ~1;
    let y0 = Math.max(0, Math.floor(y)) & ~1;
    let x1 = Math.min(fw, Math.ceil(x + w));
    let y1 = Math.min(fh, Math.ceil(y + h));
    x1 = Math.min(fw & ~1, (x1 + 1) & ~1);
    y1 = Math.min(fh & ~1, (y1 + 1) & ~1);
    const rw = Math.max(2, x1 - x0),
      rh = Math.max(2, y1 - y0);
    const size = rw * rh * 4;
    if (buf.data.length < size) buf.data = new Uint8Array(size);
    const data = buf.data.subarray(0, size);
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
      stats.frames++;
      fpsCount++;
      stats.frameW = frame.displayWidth;
      stats.frameH = frame.displayHeight;
      const now = performance.now();
      if (now - fpsAt >= 1000) {
        stats.fps = Math.round((fpsCount * 1000) / (now - fpsAt));
        fpsCount = 0;
        fpsAt = now;
        stats.locked = !!lock && Date.now() - stats.lastOk < 2500;
        stats.lock = lock;
        bridge.send("stats", { ...stats });
      }
      if (lock) {
        const img = await region(frame, lock.x - 6, lock.y - 6, MAX_COLS * lock.pitch + 12, MAX_ROWS * lock.pitch + 12);
        const local = { x: lock.x - img.ox, y: lock.y - img.oy, pitch: lock.pitch };
        let r = decodeAt(img, local);
        if (!r.ok && r.reason !== "nofinder" && ++crcStreak >= 3) {
          crcStreak = 0;
          r = acquire(img, local);
        }
        if (r.ok) {
          crcStreak = 0;
          lock = { x: r.lock.x + img.ox, y: r.lock.y + img.oy, pitch: r.lock.pitch };
          handle(r.frame);
        } else if (r.reason === "nofinder") {
          lock = null;
        } else if (r.reason === "crc") stats.crc++;
        continue;
      }
      // Searching: the default strip spot (client top-left) often, the whole frame now and then.
      if (now - lastSearch < 250) continue;
      lastSearch = now;
      const full = now - lastFull > 2000;
      if (full) lastFull = now;
      const img = full
        ? await region(frame, 0, 0, frame.displayWidth, frame.displayHeight)
        : await region(frame, cfg.clientX - 4, cfg.clientY - 4, 700, 160);
      const found = findStrip(img);
      if (!found) {
        if (full && Date.now() - lastDiag > 10_000) {
          lastDiag = Date.now();
          // Diagnostics: what does the client's top-left corner look like in the capture?
          const px = (x: number, y: number) => {
            const o = ((y - img.oy) * img.width + (x - img.ox)) * 4;
            return `${img.data[o]},${img.data[o + 1]},${img.data[o + 2]}`;
          };
          const ys = [cfg.clientY - 1, cfg.clientY, cfg.clientY + 2];
          const xs = Array.from({ length: 36 }, (_, i) => i);
          bridge.send("log", `[capture] no strip; frame ${img.width}x${img.height} client@${cfg.clientX},${cfg.clientY} samples ` + ys.map((y) => xs.map((x) => px(x, y)).join(" ")).join(" | "));
        }
        continue;
      }
      const r = acquire(img, found);
      if (r.ok) {
        lock = { x: r.lock.x + img.ox, y: r.lock.y + img.oy, pitch: r.lock.pitch };
        bridge.send("log", `[capture] locked at ${lock.x.toFixed(1)},${lock.y.toFixed(1)} pitch ${lock.pitch.toFixed(2)}`);
        // Main's screen-capture gate checks where the strip is: tell it before this lock's messages.
        stats.lock = lock;
        bridge.send("stats", { ...stats });
        handle(r.frame);
      }
    } catch (e: any) {
      stats.error = String(e?.message ?? e);
    } finally {
      frame.close();
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

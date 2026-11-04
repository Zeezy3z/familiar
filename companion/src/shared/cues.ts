// The six cues: sounds the Glass (and the control panel's "Play a sample") synthesize in WebAudio from
// a pure score. No recordings, no game files, nothing fetched; nothing plays while a quest works.
// Round 6 §2.1. The scores are the design lead's (round6-art/cues/scores.json); peaks are at volume 1.
//
// Imported by the overlay (playback), the control panel (the sample button) and, for the type only,
// the hub and main. Pure apart from `playCue`, which only talks to the AudioContext it is given.

export type Cue = "accepted" | "approval" | "approved" | "done" | "reply" | "error";

/** In the order the sample button cycles them: started, needs you, approved, complete, answer, failed. */
export const CUES: readonly Cue[] = ["accepted", "approval", "approved", "done", "reply", "error"];

/** One voice of a cue. A `[from, to]` pair is an exponential sweep over the voice's own length. */
export interface Voice {
  osc: "sine" | "triangle" | "saw" | "noise";
  f?: number | [number, number];
  /** start (s from the cue's start) */
  t: number;
  /** attack (s) */
  a: number;
  /** decay (s) */
  d: number;
  /** peak gain at volume 1 */
  g: number;
  filter?: { type: "lowpass" | "bandpass"; f: number | [number, number]; q: number };
}

/** Played at when a hub still sends a bare cue string (it never sent a volume): the default `soundVolume` of 70. */
export const DEFAULT_CUE_VOLUME = 0.7;

const SCORES: Record<Cue, Voice[]> = {
  // a parchment unroll: a band-passed noise sweep, then one soft triangle note (G5)
  accepted: [
    { osc: "noise", t: 0, a: 0.02, d: 0.28, g: 0.08, filter: { type: "bandpass", f: [400, 1600], q: 2 } },
    { osc: "triangle", f: 784, t: 0.3, a: 0.01, d: 0.45, g: 0.07 },
  ],
  // a bell: A5 with its 2.76x partial, struck again a fifth up (E6) 180 ms later
  approval: [
    { osc: "sine", f: 880, t: 0, a: 0.004, d: 0.9, g: 0.14 },
    { osc: "sine", f: 2429, t: 0, a: 0.002, d: 0.35, g: 0.05 },
    { osc: "sine", f: 1319, t: 0.18, a: 0.004, d: 0.9, g: 0.12 },
    { osc: "sine", f: 3640, t: 0.18, a: 0.002, d: 0.3, g: 0.04 },
  ],
  // a wooden stamp: a band-passed noise tap and a sine thump dropping 140 -> 60 Hz
  approved: [
    { osc: "noise", t: 0, a: 0.003, d: 0.12, g: 0.18, filter: { type: "bandpass", f: 300, q: 1.5 } },
    { osc: "sine", f: [140, 60], t: 0, a: 0.003, d: 0.15, g: 0.15 },
  ],
  // the rise E5 A5 E6, triangle + detuned sine layered, the last note held, a faint shimmer (E7) on it
  done: [
    { osc: "triangle", f: 659, t: 0, a: 0.012, d: 0.5, g: 0.09 },
    { osc: "sine", f: 660.5, t: 0, a: 0.012, d: 0.5, g: 0.04 },
    { osc: "triangle", f: 880, t: 0.11, a: 0.012, d: 0.5, g: 0.09 },
    { osc: "sine", f: 882, t: 0.11, a: 0.012, d: 0.5, g: 0.04 },
    { osc: "triangle", f: 1319, t: 0.22, a: 0.012, d: 0.9, g: 0.1 },
    { osc: "sine", f: 1322, t: 0.22, a: 0.012, d: 0.9, g: 0.04 },
    { osc: "sine", f: 2637, t: 0.26, a: 0.02, d: 0.6, g: 0.03 },
  ],
  // one soft note (B5) with its octave at a whisper: the "?" turn-in
  reply: [
    { osc: "triangle", f: 988, t: 0, a: 0.01, d: 0.5, g: 0.09 },
    { osc: "sine", f: 1976, t: 0, a: 0.01, d: 0.3, g: 0.02 },
  ],
  // two low-passed saw notes stepping down, B3 -> A3, slow decay
  error: [
    { osc: "saw", f: 247, t: 0, a: 0.01, d: 1, g: 0.1, filter: { type: "lowpass", f: 800, q: 0.7 } },
    { osc: "saw", f: 220, t: 0.22, a: 0.01, d: 1.1, g: 0.1, filter: { type: "lowpass", f: 700, q: 0.7 } },
  ],
};

const LABELS: Record<Cue, string> = {
  accepted: "Quest started",
  approval: "Needs your approval",
  approved: "Approved",
  done: "Quest Complete",
  reply: "Answer ready",
  error: "Quest Failed",
};

/** The cue's voices: a fresh copy of the data, so a caller can't change what every later cue plays. */
export function cueScore(cue: Cue): Voice[] {
  return structuredClone(SCORES[cue] ?? []);
}

/** What the sample button says it played. */
export function cueLabel(cue: Cue): string {
  return LABELS[cue] ?? cue;
}

/** Every node is stopped this long after its voice's decay ends, once its gain has ramped to silence. */
const TAIL = 0.05;
const FADE = 0.04;
/** An exponential ramp can't reach 0, so a voice decays to -60 dB and a short linear ramp finishes it. */
const FLOOR = 0.001;

// One 1 s white-noise buffer per context (its sample rate must match), shared by every noise voice.
const noise = new WeakMap<object, AudioBuffer>();
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  let buf = noise.get(ctx);
  if (!buf) {
    const rate = ctx.sampleRate || 44100;
    buf = ctx.createBuffer(1, rate, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise.set(ctx, buf);
  }
  return buf;
}

/** A fixed value, or an exponential sweep from the first number to the second over [from, to] seconds. */
function schedule(param: AudioParam, value: number | [number, number], from: number, to: number) {
  if (typeof value === "number") param.setValueAtTime(value, from);
  else {
    param.setValueAtTime(value[0], from);
    param.exponentialRampToValueAtTime(value[1], to);
  }
}

/**
 * Plays `cue` on `ctx`, starting at `at` (default: now). `volume` (0..1) is the master gain, applied to
 * each voice's peak (the scores' peaks are at 1); 0 schedules nothing. Click-free: every gain starts at
 * 0, rises to its peak, decays exponentially to -60 dB and then to 0, and every source node is started
 * and stopped.
 */
export function playCue(ctx: AudioContext, cue: Cue, volume: number, at: number = ctx.currentTime): void {
  const master = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
  const score = SCORES[cue];
  if (!score || master <= 0) return;
  // A context made before any user input may start suspended; nudge it (the scheduled times still hold).
  if (ctx.state === "suspended" && typeof ctx.resume === "function") Promise.resolve(ctx.resume()).catch(() => {});
  for (const v of score) {
    const start = at + v.t;
    const peakAt = start + v.a;
    const end = peakAt + v.d;
    let source: AudioScheduledSourceNode;
    if (v.osc === "noise") {
      const buffered = ctx.createBufferSource();
      buffered.buffer = noiseBuffer(ctx);
      buffered.loop = true;
      source = buffered;
    } else {
      const osc = ctx.createOscillator();
      osc.type = v.osc === "saw" ? "sawtooth" : v.osc;
      schedule(osc.frequency, v.f ?? 440, start, end);
      source = osc;
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(v.g * master, peakAt);
    gain.gain.exponentialRampToValueAtTime(FLOOR, end);
    gain.gain.linearRampToValueAtTime(0, end + FADE);
    if (v.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = v.filter.type;
      filter.Q.setValueAtTime(v.filter.q, start);
      schedule(filter.frequency, v.filter.f, start, end);
      source.connect(filter);
      filter.connect(gain);
    } else source.connect(gain);
    gain.connect(ctx.destination);
    source.start(start);
    source.stop(end + TAIL);
  }
}

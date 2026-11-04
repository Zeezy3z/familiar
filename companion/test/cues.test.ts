// The six cues (round 6 §2.1): a pure score per cue, and playCue's scheduling against a fake AudioContext.
// Nothing here makes a sound; the Glass journey (scripts/glass-round3-journey.mjs) checks the wiring in a page.
import { describe, expect, it } from "vitest";
import { CUES, type Cue, DEFAULT_CUE_VOLUME, cueLabel, cueScore, playCue, type Voice } from "../src/shared/cues";

type Call = { fn: "set" | "linear" | "exp"; value: number; time: number };
class FakeParam {
  calls: Call[] = [];
  setValueAtTime(value: number, time: number) { this.calls.push({ fn: "set", value, time }); return this; }
  linearRampToValueAtTime(value: number, time: number) { this.calls.push({ fn: "linear", value, time }); return this; }
  exponentialRampToValueAtTime(value: number, time: number) { this.calls.push({ fn: "exp", value, time }); return this; }
}
class FakeNode {
  kind: "osc" | "buffer" | "gain" | "filter" | "destination";
  to: FakeNode[] = [];
  started: number[] = [];
  stopped: number[] = [];
  type = "";
  buffer: unknown = null;
  loop = false;
  frequency = new FakeParam();
  gain = new FakeParam();
  Q = new FakeParam();
  constructor(kind: FakeNode["kind"]) { this.kind = kind; }
  connect(node: FakeNode) { this.to.push(node); return node; }
  start(t: number) { this.started.push(t); }
  stop(t: number) { this.stopped.push(t); }
}
class FakeContext {
  currentTime = 2;
  sampleRate = 8000;
  state = "running";
  destination = new FakeNode("destination");
  nodes: FakeNode[] = [];
  buffers = 0;
  private make(kind: FakeNode["kind"]) { const n = new FakeNode(kind); this.nodes.push(n); return n; }
  createOscillator() { return this.make("osc"); }
  createBufferSource() { return this.make("buffer"); }
  createGain() { return this.make("gain"); }
  createBiquadFilter() { return this.make("filter"); }
  createBuffer(channels: number, length: number) { this.buffers++; return { getChannelData: () => new Float32Array(length), length, channels }; }
  get sources() { return this.nodes.filter((n) => n.kind === "osc" || n.kind === "buffer"); }
}
const fake = () => new FakeContext();
const play = (ctx: FakeContext, cue: Cue, volume: number, at?: number) => playCue(ctx as unknown as AudioContext, cue, volume, at);
// The gain node a source reaches (directly, or through its filter).
const gainOf = (src: FakeNode): FakeNode => { let n = src; while (n.kind !== "gain") n = n.to[0]; return n; };
const end = (v: Voice) => v.t + v.a + v.d;

describe("cue scores", () => {
  it("are the six cues, in the order the sample button cycles them, each with its own label", () => {
    expect([...CUES]).toEqual(["accepted", "approval", "approved", "done", "reply", "error"]);
    expect(CUES.map(cueLabel)).toEqual(["Quest started", "Needs your approval", "Approved", "Quest Complete", "Answer ready", "Quest Failed"]);
  });
  it("are six distinct scores, none empty, with sane voices", () => {
    const scores = CUES.map((c) => JSON.stringify(cueScore(c)));
    expect(new Set(scores).size).toBe(6);
    for (const cue of CUES) {
      const voices = cueScore(cue);
      expect(voices.length, cue).toBeGreaterThan(0);
      for (const v of voices) {
        expect(["sine", "triangle", "saw", "noise"], cue).toContain(v.osc);
        expect(v.t, cue).toBeGreaterThanOrEqual(0);
        expect(v.a, cue).toBeGreaterThan(0);
        expect(v.d, cue).toBeGreaterThan(0);
        if (v.osc !== "noise") expect(v.f, cue).toBeDefined();
        for (const f of [v.f, v.filter?.f].flat().filter((x) => x !== undefined)) expect(f, cue).toBeGreaterThan(0); // an exponential sweep can't touch 0
      }
    }
  });
  it("end within 1.5 s (tail included), and no voice peaks above 0.2", () => {
    for (const cue of CUES) {
      const voices = cueScore(cue);
      expect(Math.max(...voices.map(end)) + 0.05, cue).toBeLessThanOrEqual(1.5);
      for (const v of voices) expect(v.g, cue).toBeLessThanOrEqual(0.2);
    }
  });
  it("the approved stamp is the shortest cue, and the bell has four voices", () => {
    const length = (c: Cue) => Math.max(...cueScore(c).map(end));
    expect(Math.min(...CUES.map(length))).toBe(length("approved"));
    expect(cueScore("approval")).toHaveLength(4); // A5 and its partial, E6 and its partial
  });
  it("hands out a copy: changing it does not change the next cue", () => {
    cueScore("done")[0].g = 9;
    expect(cueScore("done")[0].g).toBe(0.09);
  });
  it("labels an unknown cue by its own name and has no score for it", () => {
    expect(cueLabel("nope" as Cue)).toBe("nope");
    expect(cueScore("nope" as Cue)).toEqual([]);
  });
  it("the bare-string default volume is the default soundVolume of 70", () => {
    expect(DEFAULT_CUE_VOLUME).toBe(0.7);
  });
});

describe("playCue", () => {
  it("creates exactly one source node per voice, and stops every one of them", () => {
    for (const cue of CUES) {
      const ctx = fake();
      play(ctx, cue, 1, 5);
      const voices = cueScore(cue);
      expect(ctx.sources, cue).toHaveLength(voices.length);
      expect(ctx.sources.filter((n) => n.kind === "buffer"), cue).toHaveLength(voices.filter((v) => v.osc === "noise").length);
      ctx.sources.forEach((src, i) => {
        expect(src.started, cue).toEqual([5 + voices[i].t]);
        expect(src.stopped, cue).toHaveLength(1);
        expect(src.stopped[0], cue).toBeCloseTo(5 + end(voices[i]) + 0.05, 9);
      });
    }
  });
  it("sets each voice's peak to g x volume, rising from 0 and decaying exponentially to -60 dB, never to 0", () => {
    for (const cue of CUES) {
      for (const volume of [1, 0.7, 0.25]) {
        const ctx = fake();
        play(ctx, cue, volume, 1);
        const voices = cueScore(cue);
        ctx.sources.forEach((src, i) => {
          const calls = gainOf(src).gain.calls, v = voices[i];
          expect(calls[0], cue).toEqual({ fn: "set", value: 0, time: 1 + v.t });
          expect(calls[1].fn, cue).toBe("linear");
          expect(calls[1].value, cue).toBeCloseTo(v.g * volume, 9);
          expect(calls[1].time, cue).toBeCloseTo(1 + v.t + v.a, 9);
          expect(calls[2].fn, cue).toBe("exp");
          expect(calls[2].value, cue).toBe(0.001);
          expect(calls[2].time, cue).toBeCloseTo(1 + end(v), 9);
          expect(calls[3].fn, cue).toBe("linear");
          expect(calls[3].value, cue).toBe(0);
          expect(calls[3].time, cue).toBeLessThan(src.stopped[0]); // silent before the node stops: no click
          for (const c of calls.filter((c) => c.fn === "exp")) expect(c.value, cue).toBeGreaterThan(0);
        });
      }
    }
  });
  it("schedules nothing at volume 0 (or a volume that isn't a number), and clamps one above 1", () => {
    for (const volume of [0, -1, NaN]) {
      const ctx = fake();
      play(ctx, "approval", volume);
      expect(ctx.nodes, String(volume)).toHaveLength(0);
    }
    const loud = fake();
    play(loud, "approval", 7);
    expect(gainOf(loud.sources[0]).gain.calls[1].value).toBeCloseTo(0.14, 9);
  });
  it("starts now by default, and reaches the destination through every voice's gain", () => {
    const ctx = fake();
    play(ctx, "reply", 0.5);
    expect(ctx.sources[0].started).toEqual([2]);
    for (const src of ctx.sources) expect(gainOf(src).to).toEqual([ctx.destination]);
  });
  it("sets oscillator types and frequencies, sweeps exponentially over the voice's length, and filters", () => {
    const ctx = fake();
    play(ctx, "approved", 1, 0);
    const [tap, thump] = ctx.sources;
    expect(tap.kind).toBe("buffer");
    expect(tap.loop).toBe(true);
    expect(tap.to[0].kind).toBe("filter");
    expect(tap.to[0].type).toBe("bandpass");
    expect(tap.to[0].frequency.calls).toEqual([{ fn: "set", value: 300, time: 0 }]);
    expect(thump.type).toBe("sine");
    expect(thump.frequency.calls[0]).toEqual({ fn: "set", value: 140, time: 0 });
    expect(thump.frequency.calls[1].fn).toBe("exp");
    expect(thump.frequency.calls[1].value).toBe(60);
    expect(thump.frequency.calls[1].time).toBeCloseTo(0.153, 9);
    const err = fake();
    play(err, "error", 1, 0);
    expect(err.sources.map((s) => s.type)).toEqual(["sawtooth", "sawtooth"]);
    expect(err.sources.map((s) => s.to[0].type)).toEqual(["lowpass", "lowpass"]);
  });
  it("makes the noise buffer once per context and reuses it", () => {
    const ctx = fake();
    play(ctx, "accepted", 1);
    play(ctx, "approved", 1);
    expect(ctx.buffers).toBe(1);
    expect(ctx.sources.filter((n) => n.kind === "buffer")).toHaveLength(2);
    expect(ctx.sources.filter((n) => n.kind === "buffer").every((n) => n.buffer === ctx.sources.find((m) => m.kind === "buffer")!.buffer)).toBe(true);
    const other = fake();
    play(other, "accepted", 1);
    expect(other.buffers).toBe(1);
  });
  it("plays nothing for a cue it doesn't know", () => {
    const ctx = fake();
    play(ctx, "nope" as Cue, 1);
    expect(ctx.nodes).toHaveLength(0);
  });
  it("resumes a suspended context and survives a resume that rejects", () => {
    const ctx = Object.assign(fake(), { state: "suspended", resumed: 0, resume() { this.resumed++; return Promise.reject(new Error("blocked")); } });
    play(ctx, "reply", 1);
    expect(ctx.resumed).toBe(1);
    expect(ctx.sources).toHaveLength(2);
  });
});

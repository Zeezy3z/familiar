// The Link Doctor (main/doctor.ts): one sentence per stage of the game link, from the facts main
// has. Table-driven over status fixtures, every row of the round-4 table plus the waits between.
import { describe, expect, it } from "vitest";
import { DOCTOR_OK, linkDoctor, type DoctorFacts } from "../src/main/doctor";
import { diagnosticsText } from "../src/main/log-file";

const now = 1_000_000;
/** WoW found 20 s ago, window capture, frames flowing, strip locked and decoding. */
const linked: DoctorFacts = {
  game: true,
  minimized: false,
  foreground: true,
  captureMode: "window",
  stats: { fps: 30, crc: 0, lock: { x: 1, y: 1, pitch: 2 }, lastOk: now - 100 },
  startedAt: now - 20_000,
  now,
};
const unlinked = (stats: Partial<DoctorFacts["stats"]>, more: Partial<DoctorFacts> = {}): DoctorFacts => ({ ...linked, stats: { ...linked.stats, lastOk: 0, ...stats }, ...more });

const rows: [string, DoctorFacts, { step: string; level: string; text: RegExp | string }][] = [
  ["no game window", { ...linked, game: false }, { step: "game", level: "muted", text: "WoW isn't open, or isn't in Windowed / Windowed (Fullscreen)." }],
  ["minimized", { ...linked, minimized: true }, { step: "game", level: "warn", text: "WoW is minimized. Restore it; the link only works while the game is on screen." }],
  ["linked", linked, { step: "ok", level: "ok", text: DOCTOR_OK }],
  ["linked, in the background (window capture works there)", { ...linked, foreground: false }, { step: "ok", level: "ok", text: "Game link working." }],
  ["no frames for > 5 s", unlinked({ fps: 0, lock: null }, { startedAt: now - 6000 }),
    { step: "frames", level: "warn", text: "WoW is open but Familiar gets no picture of it. Another always-on-top app may block capture; try the other display mode, or HDR off for that monitor." }],
  ["no frames yet (just found)", unlinked({ fps: 0, lock: null }, { startedAt: now - 2000 }), { step: "frames", level: "muted", text: /Starting/ }],
  ["frames but no strip for > 8 s", unlinked({ lock: null }, { startedAt: now - 9000 }),
    { step: "strip", level: "warn", text: "Familiar sees the game but no coloured strip in its top-left corner. In game: is Familiar ticked in AddOns? Type /fam strip — it should say TOPLEFT. If something covers that corner, /fam strip tr." }],
  ["frames, still looking for the strip", unlinked({ lock: null }, { startedAt: now - 4000 }), { step: "strip", level: "muted", text: /Looking for the coloured strip/ }],
  ["strip lost 4 s ago: the wait counts from the last decoded frame", unlinked({ lock: null, lastOk: now - 4000 }), { step: "strip", level: "muted", text: /Looking/ }],
  ["strip locked but nothing decodes for 3 s", unlinked({ crc: 12, lastOk: now - 3500 }),
    { step: "crc", level: "warn", text: "The strip is there but can't be read. A colour filter, HDR or a scaling mismatch is the usual cause: /fam strip vivid, HDR off, or move WoW to one monitor." }],
  ["screen capture, a window covered the strip", { ...linked, captureMode: "screen", refusedExe: "Discord.exe" },
    { step: "covered", level: "warn", text: "The link is on screen capture and Discord.exe covers the strip. Move that window, or /fam strip tr." }],
  ["screen capture, covering program unknown", { ...linked, captureMode: "screen", refusedExe: "" }, { step: "covered", level: "warn", text: /and another window covers the strip/ }],
  ["screen capture with WoW behind another window", { ...linked, captureMode: "screen", foreground: false }, { step: "covered", level: "warn", text: /only while it is in front/ }],
  ["window capture ignores a stale cover report", { ...linked, refusedExe: "Discord.exe" }, { step: "ok", level: "ok", text: DOCTOR_OK }],
];

describe("linkDoctor", () => {
  for (const [name, facts, want] of rows)
    it(name, () => {
      const d = linkDoctor(facts);
      expect({ step: d.step, level: d.level }).toEqual({ step: want.step, level: want.level });
      if (typeof want.text === "string") expect(d.text).toBe(want.text);
      else expect(d.text).toMatch(want.text);
    });

  it("a minimized game is never called a capture problem", () => {
    expect(linkDoctor(unlinked({ fps: 0, lock: null }, { minimized: true, startedAt: 0 })).step).toBe("game");
  });

  it("Copy diagnostics carries the line", () => {
    const d = linkDoctor(unlinked({ lock: null }, { startedAt: now - 9000 }));
    const text = diagnosticsText({ version: "0", build: "b", electron: "e", node: "n", windows: "w", wow: "-", capture: "-", link: `${d.step}: ${d.text}`, providers: [], configKeys: [], log: [] });
    expect(text.split("\n")).toContain(`Link doctor: strip: ${d.text}`);
  });
});

import { describe, expect, it } from "vitest";
import { journey } from "../src/control/journey";
import { threadState } from "../src/overlay/thread-state";
import { approvalPreview } from "../src/overlay/approval-preview";
import { buildPresentation, restartGuidance } from "../src/control/build";
import type { DetailModel } from "../src/hub/viewmodel";

const prepared = { id: "codex", label: "Codex", glyph: "◇", enabled: true, installed: true, signedIn: true, detail: "Sign-in found", canLogin: true };
const linked = { linked: true, game: { foreground: true }, install: {}, providers: [prepared], backends: { codex: { ready: true } }, layout: { panel: true } };
const thread: Extract<DetailModel, { kind: "thread" }> = { kind: "thread", id: "test", agent: "codex", title: "Test", project: "Fixture", cwd: "C:\\fixture", external: false, mode: "Ask first", status: "idle", todos: [], entries: [] };

describe("running build and restart handoff", () => {
  it("makes local changes explicit and keeps copyable identity limited to validated build fields", () => {
    const sha = "a".repeat(40);
    const dirty = buildPresentation("0.1.0-beta", { commit: sha, dirty: true });
    expect(dirty.summary).toContain("local changes");
    expect(dirty.diagnostic).toContain(`v0.1.0-beta | Running commit: ${sha}`);
    const unavailable = buildPresentation("C:\\private\\account", { commit: "C:\\private\\repo", dirty: false });
    expect(unavailable.diagnostic).toBe("Familiar | Running commit: unavailable | Source: unavailable");
    expect(buildPresentation("0.1.0-beta", { commit: sha, dirty: null }).summary).toContain("status unavailable");
  });
  it("warns about working quests, approval requests and handoffs; unknown activity never becomes idle", () => {
    for (const work of [{ working: 1, approvals: 0, confirmation: false }, { working: 0, approvals: 2, confirmation: false }, { working: 0, approvals: 0, confirmation: true }, undefined])
      expect(restartGuidance(work).level).toBe("warn");
    const between = restartGuidance({ working: 0, approvals: 0, confirmation: false });
    expect(between.text).toContain("Finish any message");
    expect(between.text).not.toMatch(/safe|guarantee|automatically/i);
  });
});

describe("journey guidance for recoverable states", () => {
  it("offers resume when the real overlay state is paused", () => {
    expect(journey({ ...linked, overlay: { paused: true } })).toMatchObject({ action: "pause", level: "warn" });
  });
  it("does not call a saved sign-in a live ready backend", () => {
    expect(journey({ ...linked, backends: {} }).title).toContain("waiting for a familiar");
    expect(journey({ ...linked, game: null }).level).toBe("muted");
  });
  it("shows the game link as healthy when an enabled backend is ready", () => {
    expect(journey(linked).level).toBe("ok");
  });
  it("lets an installed custom ACP provider verify unknown sign-in when WoW starts", () => {
    const j = journey({ install: {}, providers: [{ ...prepared, id: "custom", signedIn: undefined, canLogin: false }] });
    expect(j.title).toBe("Your familiars are waiting for WoW");
    expect(j.steps[0].text).toContain("not yet verified");
  });
  it("guides Hermes-only setups without suggesting disabled providers or Chat", () => {
    const s = { ...linked, providers: [{ ...prepared, id: "hermes", label: "Hermes" }], backends: { hermes: { ready: true } }, chat: { agent: "claude" } };
    for (const panel of [true, false]) {
      const j = journey({ ...s, layout: { panel } });
      expect(j.text).toContain("/fam hermes <message>");
      expect(j.text).not.toMatch(/\+ Claude|\+ Codex|\+ Chat/);
    }
  });
});

describe("persistent turn cue", () => {
  it("distinguishes unavailable desktop history from loading and an empty successful read", () => {
    expect(threadState({ ...thread, external: true, historyError: "Failed" }).label).toBe("History unavailable");
    expect(threadState({ ...thread, external: true, loading: true }).label).toBe("Loading conversation");
    expect(threadState({ ...thread, external: true, historyEmpty: true }).label).toBe("Desktop conversation");
  });
  it("does not show message readiness while saved history is still loading", () => {
    expect(threadState({ ...thread, loading: true }).label).toBe("Loading conversation");
  });
  it("keeps interruption visible even when the hub status returns to idle", () => {
    expect(threadState({ ...thread, entries: [{ id: "n", kind: "notice", text: "Interrupted: Familiar was closed." }] }).label).toBe("Interrupted");
  });
  it("does not mistake a resumed desktop history or old stopped turn for a current interruption", () => {
    const entries = [{ id: "n", kind: "notice" as const, text: "Stopped." }, { id: "u", kind: "user" as const, text: "Continue" }, { id: "a", kind: "assistant" as const, text: "Done" }];
    expect(threadState({ ...thread, entries }).label).toBe("Reply ready");
    expect(threadState({ ...thread, entries, external: true }).label).toBe("Desktop conversation");
  });
  it("uses hub state for pending approvals and failures", () => {
    expect(threadState({ ...thread, status: "approval" }).label).toBe("Needs your approval");
    expect(threadState({ ...thread, status: "error" }).label).toBe("Needs attention");
  });
  it("does not mark a partial reply complete when Stop resolves synchronously", () => {
    const entries = [
      { id: "u", kind: "user" as const, text: "Start" },
      { id: "a", kind: "assistant" as const, text: "Partial answer" },
      { id: "n1", kind: "notice" as const, text: "Stopped." },
      { id: "n2", kind: "notice" as const, text: "Stopping." },
    ];
    expect(threadState({ ...thread, entries }).label).toBe("Interrupted");
  });
});

describe("approval previews", () => {
  it("compact previews explicitly track omitted text; expanded previews restore only available text", () => {
    for (const text of ["x".repeat(950), Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n")]) {
      const compact = approvalPreview(text);
      expect(compact.shortened).toBe(true);
      expect(compact.text.length).toBeLessThanOrEqual(600);
      expect(compact.text.split("\n").length).toBeLessThanOrEqual(8);
      expect(approvalPreview(text, true)).toEqual({ text, shortened: true });
    }
    expect(approvalPreview("npm test")).toEqual({ text: "npm test", shortened: false });
    expect(approvalPreview("")).toEqual({ text: "", shortened: false });
  });

  it("never shortens a pending approval, so its tail is visible next to Approve", () => {
    const tail = "rm -rf D:\\vault\\private";
    for (const text of [Array.from({ length: 40 }, (_, i) => `echo step ${i}`).join("\n") + "\n" + tail, "x".repeat(950) + tail]) {
      expect(approvalPreview(text, false, true)).toEqual({ text, shortened: false });
      expect(approvalPreview(text, false, false).text).not.toContain(tail); // resolved/expired cards stay compact
    }
  });
});

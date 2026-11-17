// Windows notices (main/notices.ts): a waiting request or a finished quest, only while WoW isn't in
// front, only when the setting is on, and naming nothing under Hide names / Stream-safe.
import { describe, expect, it } from "vitest";
import { trayNoticeFor } from "../src/main/notices";
import { DEFAULT_CONFIG } from "../src/hub/config";

const approval = { kind: "approval" as const, project: "familiar", questTitle: "Fix the tooltip" };
const away = { gameInFront: false, privateMode: false, trayNotices: true };

describe("trayNoticeFor", () => {
  it("an approval while WoW isn't in front: names the project and quest and says where to answer", () => {
    expect(trayNoticeFor(approval, away)).toEqual({
      title: "Needs you · familiar",
      content: "Fix the tooltip — open Familiar to read and approve it, or answer in game.",
    });
  });

  it("nothing while WoW is in front: the Glass card and chime already show it", () => {
    expect(trayNoticeFor(approval, { ...away, gameInFront: true })).toBeNull();
  });

  it("a finished quest gets one too, generic under Hide names, never while WoW is in front", () => {
    expect(trayNoticeFor({ ...approval, kind: "done" }, away)).toEqual({ title: "Quest finished · familiar", content: "Fix the tooltip is done." });
    expect(trayNoticeFor({ ...approval, kind: "done" }, { ...away, privateMode: true })).toEqual({ title: "Quest finished", content: "A familiar has finished. Its reply is waiting in game." });
    expect(trayNoticeFor({ ...approval, kind: "done" }, { ...away, gameInFront: true })).toBeNull();
  });

  it("failed and info toasts keep the tray quiet", () => {
    for (const kind of ["error", "info"] as const) expect(trayNoticeFor({ ...approval, kind }, away), kind).toBeNull();
  });

  it("generic under Hide names / Stream-safe", () => {
    expect(trayNoticeFor(approval, { ...away, privateMode: true })).toEqual({ title: "Needs you", content: "A quest is waiting for your say-so." });
  });

  it("the setting turns it off, and it is on by default", () => {
    expect(trayNoticeFor(approval, { ...away, trayNotices: false })).toBeNull();
    expect(DEFAULT_CONFIG.trayNotices).toBe(true);
  });

  it("fits Windows' balloon limits", () => {
    const n = trayNoticeFor({ ...approval, project: "p".repeat(100), questTitle: "q".repeat(400) }, away)!;
    expect(n.title.length).toBeLessThanOrEqual(63);
    expect(n.content.length).toBeLessThanOrEqual(255);
    expect(n.title.endsWith("…")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { PRIVACY, alwaysLabel, approveKeyStatus, approveOnlyHere, claudeLine, familiarStatus, journey, keyToBinding, portraitFor, privacyLevel, waitingOnlyHere } from "../src/control/journey";
import { bindingToVk } from "../src/main/physical";
import { threadState } from "../src/overlay/thread-state";
import { NEEDS_YOU } from "../src/shared/words";
import { approvalPreview } from "../src/overlay/approval-preview";
import { buildPresentation, compareVersions, restartGuidance, updateLine, versionLabel, versionMismatch } from "../src/control/build";
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
  it("treats WoW minimized or in the background as normal, not as a step in the way", () => {
    for (const game of [{ minimized: true }, { foreground: false }]) {
      const j = journey({ ...linked, game });
      expect(j).toMatchObject({ title: "All set — type /fam in WoW", level: "ok", current: -1 });
      expect(j.title).not.toContain("Return to your WoW window");
    }
  });
  it("hides the step strip once setup is complete (current -1) and names one action for the step in the way", () => {
    expect(journey(linked).current).toBe(-1);
    expect(journey({ ...linked, providers: [], backends: {} })).toMatchObject({ current: 0, action: "providers" });
    expect(journey({ providers: [prepared], backends: { codex: { ready: true } } })).toMatchObject({ action: "config" });
    expect(journey({ ...linked, linked: false, layout: null })).toMatchObject({ current: 2, action: undefined });
  });
  it("explains the restart, Familiar Sync and the coloured dots while the game link is missing", () => {
    const j = journey({ ...linked, linked: false, layout: null });
    expect(j.title).toBe("I can't see the game yet.");
    expect(j.title + j.text).not.toContain("Runestrip");
    expect(j.text).toContain("The coloured dots top-left are how Familiar talks to your PC.");
    expect(j.text).toContain("/fam strip tr moves them to the top-right");
    expect(j.steps[2]).toMatchObject({ done: false, text: "Restart WoW, tick Familiar and Familiar Sync at character select (Load out of date AddOns), then press Enter and type /fam" });
    expect(j.steps[1].text).toBe("Game window found");
  });
  it("names the ready agent in step 1 before the game link exists", () => {
    const j = journey({ ...linked, linked: false, layout: null });
    expect(j.steps[0]).toMatchObject({ done: true, text: "Codex ready" });
    const both = journey({ ...linked, linked: false, providers: [{ ...prepared, id: "claude", label: "Claude" }, prepared], backends: { claude: { ready: true }, codex: { ready: true } } });
    expect(both.steps[0].text).toBe("Claude, Codex ready");
    expect(journey({ ...linked, linked: false, backends: {} }).steps[0].text).toBe("Sign-in found (Codex); agents start with WoW");
    expect(journey({ ...linked, linked: false, backends: {}, providers: [{ ...prepared, label: "" }] }).steps[0].text).toBe("Sign-in found; agents start with WoW");
  });
  it("shows setup as three steps, Agents, WoW and Link, and points at the first undone one", () => {
    const done = journey(linked);
    expect(done.steps.map(s => s.label)).toEqual(["Agents", "WoW", "Link"]);
    expect(done.steps.map(s => s.done)).toEqual([true, true, true]);
    expect(done.current).toBe(-1);
    expect(journey({ ...linked, linked: false, layout: null }).current).toBe(2);
    expect(journey({ ...linked, linked: false, game: null, layout: null }).current).toBe(1);
    expect(journey({ ...linked, providers: [], backends: {} }).current).toBe(0);
    expect(journey({ ...linked, providers: [{ ...prepared, signedIn: false }], backends: {} }).steps.map(s => s.done)).toEqual([false, true, true]);
  });
  it("says the game link is working and explains a missing WoW install in plain words", () => {
    expect(journey(linked).steps[2].text).toBe("Game link working");
    const j = journey({ providers: [prepared], backends: { codex: { ready: true } } });
    expect(j.title).toBe("Familiar couldn't find World of Warcraft");
    expect(j.text).toContain("Start WoW: Forever once");
    expect(j.text).toContain("Reinstall addon under Troubleshooting");
    expect(j.title).not.toContain("wowRoot");
  });
  it("lets an installed custom ACP provider verify unknown sign-in when WoW starts", () => {
    const j = journey({ install: {}, providers: [{ ...prepared, id: "custom", signedIn: undefined, canLogin: false }] });
    expect(j.title).toBe("I'm waiting for WoW.");
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

describe("the familiar's voice and portrait", () => {
  it("speaks the titles that are about its own state; the texts under them stay literal", () => {
    expect(journey({ ...linked, game: null }).title).toBe("I'm waiting for WoW.");
    expect(journey(linked).title).toBe("All set — type /fam in WoW");
    expect(journey({ ...linked, layout: { panel: false } }).title).toBe("All set — type /fam in WoW"); // Quest Log open or not
    expect(journey(linked).text).toBe(""); // one line: Claude and Codex have + buttons in the Quest Log
    expect(journey({ ...linked, providers: [], backends: {} }).title).toBe("Choose your familiar");
  });
  it("picks the portrait from the journey, the Claude download and the work in the status", () => {
    const at = (s: Parameters<typeof journey>[0]) => portraitFor(s, journey(s).current);
    expect(at(linked)).toBe("idle");
    expect(at({ ...linked, linked: false, layout: null })).toBe("puzzled");
    expect(at({ ...linked, work: { working: 1 } })).toBe("working");
    expect(at({ ...linked, work: { working: 0 } })).toBe("idle");
    expect(at({ ...linked, providers: [], backends: {}, claude: { state: "downloading", pct: 43 } })).toBe("working");
    expect(at({ ...linked, providers: [], backends: {}, claude: { state: "failed" } })).toBe("idle");
    expect(at({ ...linked, linked: false, layout: null, work: { working: 2 } })).toBe("puzzled"); // an unlinked game is not "working"
  });
  it("asks while a request waits on a finished journey, ahead of work; an undone Link step still puzzles it", () => {
    expect(portraitFor({ work: { working: 1, approvals: 1 } }, -1)).toBe("asking");
    expect(portraitFor({ work: { approvals: 1 } }, 2)).toBe("puzzled");
    expect(portraitFor({ work: { approvals: 2 } }, 1)).toBe("idle"); // the WoW step undone: no request can be on screen
    expect(portraitFor({ work: { approvals: 0, working: 1 } }, -1)).toBe("working");
    expect(portraitFor({ work: { approvals: 1 }, claude: { state: "downloading" } }, -1)).toBe("asking");
    const at = (s: Parameters<typeof journey>[0]) => portraitFor(s, journey(s).current);
    expect(at({ ...linked, work: { working: 0, approvals: 2 } })).toBe("asking");
  });
});

describe("the step strip's one-line hints", () => {
  it("says each step in a few words; the whole sentence stays the step's text", () => {
    const both = journey({ ...linked, providers: [{ ...prepared, id: "claude", label: "Claude" }, prepared], backends: { claude: { ready: true }, codex: { ready: true } } });
    expect(both.hints).toEqual(["Claude and Codex ready", "Game window found", "Game link working"]);
    expect(both.steps[0].text).toBe("Claude, Codex ready");
    expect(journey(linked).hints[0]).toBe("Codex ready");
    const three = journey({ ...linked, providers: ["a", "b", "c"].map(id => ({ ...prepared, id, label: id.toUpperCase() })), backends: { a: { ready: true }, b: { ready: true }, c: { ready: true } } });
    expect(three.hints[0]).toBe("A, B and C ready");
    expect(journey({ ...linked, linked: false, backends: {} }).hints[0]).toBe("Sign-in found");
    expect(journey({ ...linked, linked: false, game: null, layout: null }).hints.slice(1)).toEqual(["Not found yet", "Not linked yet"]);
    expect(journey({ ...linked, providers: [], backends: {} }).hints[0]).toBe("No familiar chosen yet");
    expect(journey({ ...linked, providers: [{ ...prepared, signedIn: false }], backends: {} }).hints[0]).toBe("Not signed in yet");
    expect(journey({ ...linked, providers: [], backends: {}, claude: { state: "downloading", pct: 43, mb: 112 } }).hints[0]).toBe("Downloading Claude Code · 43 %");
  });
  it("keeps each hint short enough for one line of the strip (a step column at 760 px holds about 32 characters)", () => {
    const states = [linked, { ...linked, linked: false, layout: null }, { ...linked, game: null }, { ...linked, backends: {} }, { install: {}, providers: [{ ...prepared, signedIn: undefined }] },
      { ...linked, providers: [], backends: {}, claude: { state: "failed" } }, { ...linked, providers: [], backends: {}, claude: { state: "downloading", pct: 100, mb: 112 } }];
    for (const s of states) for (const h of journey(s).hints) expect(h.length, h).toBeLessThanOrEqual(32);
  });
});

describe("Link Doctor line in the Link step", () => {
  const stuck = { ...linked, linked: false, layout: null };
  const strip = { step: "strip", level: "warn", text: "Familiar sees the game but no coloured strip in its top-left corner." };
  it("replaces the fixed Link text while the link is not up, and keeps its level", () => {
    expect(journey({ ...stuck, doctor: strip }).steps[2]).toEqual({ label: "Link", done: false, text: strip.text, level: "warn" });
    expect(journey({ ...stuck, doctor: { step: "game", level: "muted", text: "WoW isn't open." } }).steps[2]).toMatchObject({ level: "muted" });
  });
  it("is the journey text under the title while the link is not up, in its own level; the strip only says Not linked yet", () => {
    const j = journey({ ...stuck, doctor: strip });
    expect(j).toMatchObject({ title: "I can't see the game yet.", text: strip.text, textLevel: "warn", level: "warn" });
    expect(j.hints[2]).toBe("Not linked yet");
    expect(journey({ ...stuck, doctor: { step: "game", level: "muted", text: "WoW isn't open." } })).toMatchObject({ text: "WoW isn't open.", textLevel: "muted" });
    for (const doctor of [undefined, null, { step: "ok", level: "ok", text: "Game link working." }]) {
      const fixed = journey({ ...stuck, doctor });
      expect(fixed.text).toContain("The coloured dots top-left are how Familiar talks to your PC.");
      expect(fixed).not.toHaveProperty("textLevel");
    }
  });
  it("falls back to the fixed wording without a doctor, with an empty one, or with the doctor's ok line", () => {
    const fixed = journey(stuck).steps[2].text;
    expect(fixed).toContain("tick Familiar and Familiar Sync");
    for (const doctor of [undefined, null, { step: "strip", text: "  " }, { step: "ok", level: "ok", text: "Game link working." }])
      expect(journey({ ...stuck, doctor }).steps[2].text).toBe(fixed);
  });
  it("says Game link working once linked, whatever the doctor last said", () => {
    expect(journey({ ...linked, doctor: strip }).steps[2]).toEqual({ label: "Link", done: true, text: "Game link working" });
  });
});

describe("Claude Code download in the Agents step and the Familiars card", () => {
  const none = { ...linked, providers: [{ ...prepared, id: "claude", label: "Claude", installed: false, enabled: false, signedIn: undefined }], backends: {} };
  it("words the three states and says nothing once it is on disk", () => {
    expect(claudeLine({ state: "downloading", pct: 43, mb: 112 })).toMatchObject({ state: "downloading", text: "Downloading Claude Code · 43 % of 112 MB", pct: 43, retry: "" });
    expect(claudeLine({ state: "downloading" })?.text).toBe("Downloading Claude Code…");
    expect(claudeLine({ state: "downloading", pct: 250, mb: -1 })).toMatchObject({ text: "Downloading Claude Code · 100 %", pct: 100 });
    expect(claudeLine({ state: "failed", error: "no response from the npm registry for 60 s" })).toMatchObject({ level: "warn", retry: "Retry",
      text: "Claude Code couldn't be downloaded (no response from the npm registry for 60 s). Other agents still work." });
    expect(claudeLine({ state: "failed" })?.text).toBe("Claude Code couldn't be downloaded. Other agents still work.");
    expect(claudeLine({ state: "missing" })).toMatchObject({ retry: "Retry", text: expect.stringContaining("Click Retry") });
    for (const c of [undefined, null, { state: "present" }, { state: "bogus" }]) expect(claudeLine(c)).toBeNull();
  });
  it("tells a first-run player with only Claude that it is downloading, not that they must pick an agent", () => {
    const j = journey({ ...none, game: null, claude: { state: "downloading", pct: 10, mb: 112 } });
    expect(j.title).toBe("Downloading Claude Code");
    expect(j.steps[0]).toMatchObject({ done: false, text: "Downloading Claude Code · 10 % of 112 MB" });
    const failed = journey({ ...none, claude: { state: "failed", error: "offline" } });
    expect(failed).toMatchObject({ title: "Claude Code couldn't be downloaded", action: "providers", level: "warn" });
    expect(failed.text).toContain("Use Retry under Familiars");
    expect(journey({ ...none, claude: { state: "present" } }).title).toBe("Choose your familiar");
  });
  it("leaves a working agent alone while Claude downloads", () => {
    expect(journey({ ...linked, claude: { state: "downloading", pct: 5 } }).level).toBe("ok");
  });
});

describe("addon and app versions", () => {
  it("shows the running version as v<semver>, keeping a plain suffix, and nothing that is not a version", () => {
    expect(versionLabel("0.5.0")).toBe("v0.5.0");
    expect(versionLabel("0.1.0-beta")).toBe("v0.1.0-beta");
    expect(versionLabel("0.1.0 · synthetic preview")).toBe("v0.1.0 · synthetic preview");
    for (const odd of [undefined, "", "dev", "<b>1.0.0</b>", "1.0", 5]) expect(versionLabel(odd)).toBe("");
  });
  it("orders versions like semver, a release above its own prerelease", () => {
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0-beta.1")).toBe(-1);
    expect(compareVersions("dev", "1.0.0")).toBeUndefined();
    expect(compareVersions("1.0.0", "0.1.0 · synthetic preview")).toBeUndefined();
  });
  it("shows a mismatch line only when main says they differ and both are plain versions, naming the one that is behind", () => {
    const up = (app: unknown, addon: unknown, mismatch = true) => versionMismatch({ app, addon, mismatch });
    expect(up("0.2.0", "0.2.0", false)).toBeNull(); // main says they match
    expect(up("0.2.0", "0.1.1", false)).toBeNull(); // the panel never decides that they differ
    expect(up("0.2.0", "dev")).toBeNull();
    expect(up("0.2.0", undefined)).toBeNull();
    expect(up("0.2.0", "<b>0.1.0</b>")).toBeNull(); // the game's text is only ever shown when it is a plain version
    expect(versionMismatch(undefined)).toBeNull();
    expect(up("0.2.0", "0.1.1")?.text).toBe("Addon 0.1.1 is behind app 0.2.0. Update it with WowUp or the release zip.");
    expect(up("0.2.0", "0.3")?.text).toBe("App 0.2.0 is behind addon 0.3. Update the app from the Releases page.");
    expect(up("0.2.0", "0.2.0+build5")?.text).toBe("Addon 0.2.0+build5 and app 0.2.0 differ. Update the one that's behind.");
  });
  it("words the update check from main's `newer`, linking only a Familiar release page", () => {
    const url = "https://github.com/Zeezy3z/familiar/releases/tag/v0.3.0";
    expect(updateLine({ current: "0.2.0", latest: "0.3.0", newer: true, url })).toEqual({ level: "warn", text: "0.3.0 is out", open: url });
    expect(updateLine({ current: "0.2.0", latest: "v0.3.0-beta.1", newer: true, url, prerelease: true }).text).toBe("0.3.0-beta.1 is out (beta)");
    expect(updateLine({ current: "0.2.0", latest: "0.2.0", newer: false, url })).toEqual({ level: "ok", text: "You're on 0.2.0, the latest." });
    expect(updateLine({ current: "0.3.0", latest: "0.2.0", newer: false })).toEqual({ level: "muted", text: "You're on 0.3.0. The latest release is 0.2.0." });
    expect(updateLine({ current: "0.2.0", latest: "0.3.0", url }).open).toBeUndefined(); // not newer unless main says so
    expect(updateLine({ current: "0.2.0", latest: "0.3.0", newer: true, url: "https://evil.example/releases" }).open).toBeUndefined();
    expect(updateLine({ current: "0.2.0", latest: "0.3.0", newer: true, url: "https://github.com/Zeezy3z/familiar-evil/releases" }).open).toBeUndefined();
    expect(updateLine({ current: "0.2.0", latest: "0.3.0", newer: true, url: "https://github.com/Zeezy3z/familiar/releases/latest" }).open).toBe("https://github.com/Zeezy3z/familiar/releases/latest");
  });
  it("says what failed, in main's words, and shows no link", () => {
    expect(updateLine({ current: "0.2.0", error: "couldn't reach GitHub" })).toEqual({ level: "warn", text: "Couldn't reach GitHub (no network?)" });
    expect(updateLine({ current: "0.2.0", error: "GitHub answered 403" }).text).toBe("Couldn't check for updates: GitHub answered 403.");
    expect(updateLine({ current: "0.2.0", error: "no release is published yet" }).text).toBe("Couldn't check for updates: no release is published yet.");
    expect(updateLine(undefined).text).toBe("Couldn't reach GitHub (no network?)");
    expect(updateLine({ current: "0.2.0" }).level).toBe("warn");
  });
});

describe("Approve key status line", () => {
  const playing = "That key is used for playing; pick an F-key or a Ctrl/Shift combination.";
  it("shows what is registered and that Familiar checks the real keyboard for it", () => {
    expect(approveKeyStatus("F9")).toEqual({ level: "ok", text: "Registered: F9 — Familiar checks the real keyboard for it", warning: "" });
    expect(approveKeyStatus("ctrl-f9").text).toBe("Registered: CTRL-F9 — Familiar checks the real keyboard for it");
  });
  it("without a key, says where requests can be approved: here only, or also by click when that is switched on", () => {
    expect(approveKeyStatus("")).toEqual({ level: "warn", text: "No key set: requests can only be approved in this window until you set one.", warning: "" });
    expect(approveKeyStatus("", true)).toEqual({ level: "muted", text: "None set: approve by clicking the in-game card, or here", warning: "" });
    expect(approveKeyStatus("banana").level).toBe("warn"); // a saved name Familiar can't check counts as none
  });
  it("puts a waiting request the game cannot approve on the status line, with Set key", () => {
    expect(approveOnlyHere({ approveKey: "", approveByClick: false })).toBe(true);
    expect(approveOnlyHere({ approveKey: "banana" })).toBe(true);
    expect(approveOnlyHere({ approveKey: "F9", approveByClick: false })).toBe(false);
    expect(approveOnlyHere({ approveKey: "", approveByClick: true })).toBe(false);
    expect(approveOnlyHere(undefined)).toBe(false); // an older main without ui says nothing
    expect(waitingOnlyHere({ approveKey: "" }, 1)).toEqual({ title: "A request is waiting above", text: "No key set: requests can only be approved in this window until you set one.", level: "warn", action: "key" });
    expect(waitingOnlyHere({ approveKey: "" }, 3)?.title).toBe("3 requests are waiting above");
    expect(waitingOnlyHere({ approveKey: "" }, 0)).toBeNull();
    expect(waitingOnlyHere({ approveKey: "F9" }, 2)).toBeNull();
    expect(waitingOnlyHere({ approveKey: "", approveByClick: true }, 2)).toBeNull();
  });
  it("warns, but still registers, a key that is also used for playing", () => {
    for (const key of ["W", "5", "SPACE", "UP", "LEFT"]) expect(approveKeyStatus(key)).toMatchObject({ level: "ok", warning: playing });
    for (const key of ["CTRL-W", "SHIFT-5", "ALT-SPACE", "F9", "NUMPAD5", "PAGEDOWN"]) expect(approveKeyStatus(key).warning).toBe("");
  });
});

describe("Approve key captured by pressing it", () => {
  const press = (code: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}, key?: string) => keyToBinding({ code, key, ...mods });
  it("names the key the way WoW's binding text does, modifiers in WoW's order", () => {
    expect(press("F9")).toBe("F9");
    expect(press("F9", { ctrlKey: true })).toBe("CTRL-F9");
    expect(press("Numpad5", { shiftKey: true, altKey: true })).toBe("ALT-SHIFT-NUMPAD5");
    expect(press("PageDown")).toBe("PAGEDOWN");
    expect(press("NumpadAdd")).toBe("NUMPADPLUS");
    expect(press("Digit5", { shiftKey: true }, "%")).toBe("SHIFT-5");
    expect(press("BracketLeft")).toBe("[");
  });
  it("takes letters from the keyboard layout, like Windows' virtual keys", () => {
    expect(press("KeyQ", {}, "a")).toBe("A"); // AZERTY: the key in the Q position types A
    expect(press("KeyW", { ctrlKey: true }, "w")).toBe("CTRL-W");
    expect(press("KeyW", {}, undefined)).toBe("W");
  });
  it("waits while only a modifier is down, and leaves Escape and Tab alone", () => {
    for (const code of ["ControlLeft", "ShiftRight", "AltLeft", "MetaLeft", "Escape", "Tab", "CapsLock", ""]) expect(press(code)).toBeNull();
  });
  it("only ever produces a binding the companion can check", () => {
    for (const code of ["F1", "F24", "Insert", "Home", "ArrowUp", "Space", "Enter", "Backquote", "Slash", "Numpad0", "NumpadDecimal"]) {
      const b = press(code, { ctrlKey: true });
      expect(b, code).not.toBeNull();
      expect(bindingToVk(b!), code).toBeDefined();
    }
  });
});

describe("one status per Familiars row", () => {
  const grok = { id: "grok", label: "Grok", glyph: "*", installed: true, enabled: true, signedIn: false, canLogin: true, detail: "Not signed in · Grok / SuperGrok account (browser sign-in) or XAI_API_KEY" };
  it("a missing sign-in wins over a ready backend: ready only means the program answered", () => {
    const st = familiarStatus(grok, { ready: true, account: "Grok" });
    expect(st).toMatchObject({ level: "warn", text: "! Not signed in · Grok / SuperGrok account (browser sign-in) or XAI_API_KEY", signIn: true });
    expect(st.text).not.toMatch(/ready/i);
  });
  it("is ready, with no Sign in, when signed in and running; the account is shown unless it only repeats the name", () => {
    expect(familiarStatus({ ...prepared }, { ready: true, account: "chatgpt pro" })).toEqual({ level: "ok", text: "✓ Ready · chatgpt pro", signIn: false, retry: "", install: false, downloading: false });
    expect(familiarStatus({ ...grok, signedIn: true, detail: "Signed in · x" }, { ready: true, account: "Grok" }).text).toBe("✓ Ready");
    expect(familiarStatus({ ...prepared }, { ready: true, account: "unknown" }).text).toBe("✓ Ready");
  });
  it("trusts Codex's own account answer over the sign-in file", () => {
    expect(familiarStatus({ ...prepared }, { ready: true, account: "signed out" })).toMatchObject({ level: "warn", text: "! Not signed in", signIn: true });
  });
  it("says what is wrong when the backend failed, and offers Sign in there", () => {
    expect(familiarStatus({ ...grok, signedIn: true }, { ready: false, error: "Grok exited" })).toMatchObject({ level: "err", text: "✗ Can't start: Grok exited", signIn: true });
  });
  it("before WoW starts: signed in, or not yet checkable", () => {
    expect(familiarStatus({ ...prepared }, undefined)).toMatchObject({ level: "muted", text: "◌ Signed in · starts when WoW is running", signIn: false });
    expect(familiarStatus({ ...grok, id: "custom", signedIn: undefined, canLogin: false }, {})).toMatchObject({ level: "muted", text: expect.stringContaining("sign-in is checked then"), signIn: false });
  });
  it("switched off, not installed, and the Claude Code download each say so, with only their own action", () => {
    expect(familiarStatus({ ...prepared, enabled: false }, { ready: true })).toMatchObject({ text: "◌ Off", signIn: false });
    expect(familiarStatus({ ...grok, installed: false, enabled: false, detail: "Not installed", installUrl: "https://x.ai/cli" } as any, null)).toMatchObject({ text: "◌ Not installed", install: true, signIn: false });
    const claude = { ...prepared, id: "claude", label: "Claude", installed: false, enabled: false };
    expect(familiarStatus(claude, null, { state: "downloading", pct: 43, mb: 112 })).toMatchObject({ downloading: true, pct: 43, retry: "", install: false });
    expect(familiarStatus(claude, null, { state: "failed" })).toMatchObject({ level: "warn", retry: "Retry", text: expect.stringMatching(/^! /) });
  });
});

describe("privacy: one control, three levels over the two saved settings", () => {
  it("reads the level main reports, and from privateMode and streamSafe without it", () => {
    for (const level of ["off", "names", "blur"] as const) expect(privacyLevel({ privacy: level, privateMode: false, streamSafe: false })).toBe(level);
    expect(privacyLevel({ privacy: "bogus", privateMode: true })).toBe("names");
    expect(privacyLevel({ privateMode: false, streamSafe: false })).toBe("off");
    expect(privacyLevel({ privateMode: true, streamSafe: false })).toBe("names");
    expect(privacyLevel({ privateMode: true, streamSafe: true })).toBe("blur");
    expect(privacyLevel(undefined)).toBe("off");
    expect(Object.values(PRIVACY).map((p) => p.label)).toEqual(["Off", "Hide names", "Hide names and blur replies"]);
  });
});

describe("Always on a request is worded as the Glass words it", () => {
  it("names the quest for Claude and Codex, and says the agent decides for the others", () => {
    expect(alwaysLabel("claude").label).toBe("Always (this quest)");
    expect(alwaysLabel("codex").label).toBe("Always (this quest)");
    expect(alwaysLabel("Claude").label).toBe("Always (this quest)"); // status.requests[] names the agent by its label
    expect(alwaysLabel("hermes").label).toBe("Always (agent decides how long)");
    expect(alwaysLabel(undefined).label).toBe("Always (agent decides how long)");
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
    expect(threadState({ ...thread, status: "approval" }).label).toBe(NEEDS_YOU); // one name per state (shared/words.ts)
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

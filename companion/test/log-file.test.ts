// familiar.log is for diagnosing Familiar, not a transcript: what the player typed and who they are
// never reach it, and it can't grow without bound.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { changedConfigKeys, describeAddonMessage, describeOverlayAction, diagnosticsText, LOG_LINE_MAX, logLine, redact, rotateLog } from "../src/main/log-file";

describe("familiar.log", () => {
  it("records addon messages by type and size, never their text or the character", () => {
    expect(describeAddonMessage({ t: "prompt", text: "delete my secret project" })).toBe("[addon] prompt (24 chars)");
    expect(describeAddonMessage({ t: "quests", text: "Synthetic quest: [ ] 0/1" })).toBe("[addon] quests (24 chars)");
    expect(describeAddonMessage({ t: "key", k: "approve" })).toBe("[addon] key approve");
    const hello = describeAddonMessage({ t: "hello", char: "Synthchar", realm: "Synthrealm", build: "1.0", iface: 16001, addon: "0.3" });
    expect(hello).toBe("[addon] hello build 1.0 iface 16001 addon 0.3");
    expect(logLine("x", new Date("2026-10-16T18:00:00.000Z"))).toBe("2026-10-16T18:00:00.000Z x");
  });

  it("records overlay actions by type and flags only (plus the decision), never ids, labels or request text", () => {
    expect(describeOverlayAction({ type: "caughtUp", thread: "PRIVATE-THREAD", entry: "PRIVATE-ENTRY" })).toBe('[overlay] action {"type":"caughtUp"}');
    expect(describeOverlayAction({ type: "quiet", on: true })).toBe('[overlay] action {"type":"quiet","on":true}');
    const decide = describeOverlayAction({ type: "decide", thread: "PRIVATE-THREAD", requestId: "PRIVATE-REQ", decision: "allow", text: "PRIVATE-TEXT" });
    expect(decide).toBe('[overlay] action {"type":"decide","decision":"allow"}');
    expect(describeOverlayAction({ type: "pick", label: "PRIVATE-LABEL", id: "PRIVATE-ID" })).toBe('[overlay] action {"type":"pick"}');
    expect(describeOverlayAction(null)).toBe('[overlay] action {"type":"?"}');
  });

  it("keeps the previous log as familiar.log.1 once it passes the cap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-log-"));
    const file = path.join(dir, "familiar.log");
    fs.writeFileSync(file, "0123456789");
    rotateLog(file, 100);
    expect(fs.readFileSync(file, "utf8")).toBe("0123456789"); // under the cap: untouched
    rotateLog(file, 5);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(file + ".1", "utf8")).toBe("0123456789");
    fs.writeFileSync(file, "newer log!");
    rotateLog(file, 5);
    expect(fs.readFileSync(file + ".1", "utf8")).toBe("newer log!"); // only one old log is kept
    rotateLog(path.join(dir, "missing.log"), 5); // no log yet: nothing to do
  });
});

describe("redact", () => {
  const home = "C:\\Users\\zed";
  const hex64 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  const corpus: [string, string[]][] = [
    [`[claude:stderr] config at ${home}\\.claude\\settings.json`, ["zed", home]],
    [`[claude:stderr] config at C:/Users/ZED/.claude/settings.json`, ["ZED"]],
    [`[wow] running from C:\\Users\\alice\\Games\\WoW\\Wow.exe`, ["alice"]],
    [`[wow] running from /Users/bob/Games/WoW`, ["bob"]],
    [`[hub] error: invalid key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`, ["sk-ant-api03", "AbCdEfGh"]],
    [`[codex:stderr] key sk-proj-abcdefghijklmnopqrstuvwxyz012345 rejected`, ["sk-proj-abcdefghijklmnop"]],
    [`[grok:stderr] xai-AbCdEfGh12345678 unauthorized`, ["xai-AbCdEfGh12345678"]],
    [`[hermes:stderr] github ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 forbidden`, ["ghp_ABCDEFGHIJ"]],
    [`[hermes:stderr] github github_pat_11ABCDEFG0123456789_abcdefghijklmnop refused`, ["github_pat_11ABCDEFG"]],
    [`[acp] Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc failed`, ["eyJhbGci", "Bearer eyJ"]],
    [`[boot] provider custom: node agent.js --token=tok_ABC123xyz --port 9`, ["tok_ABC123xyz"]],
    [`[boot] env OPENAI_API_KEY=sk-live-0123456789abcdefghij CLAUDE_CONFIG_DIR=${home}\\.claude`, ["0123456789abcdefghij", "zed"]],
    [`[mcp] {"api_key": "verysecretvalue", "password": "hunter2", "secret":"s3cr3t"}`, ["verysecretvalue", "hunter2", "s3cr3t"]],
    [`[hub] digest ${hex64} mismatch`, [hex64, hex64.slice(0, 40)]],
    [`[hub] blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5MDEyMzQ1Njc4OQ== rejected`, ["QUJDREVG"]],
  ];

  it("masks keys, tokens, bearer headers, key=value secrets and long hex/base64; hides the user", () => {
    for (const [line, leaks] of corpus) {
      const out = redact(line, home);
      for (const leak of leaks) expect(out, line).not.toContain(leak);
      // The line stays recognisable: its tag survives.
      expect(out.startsWith(line.slice(0, line.indexOf("]") + 1))).toBe(true);
    }
    expect(redact(`[claude:stderr] config at ${home}\\.claude\\settings.json`, home)).toBe("[claude:stderr] config at ~\\.claude\\settings.json");
    expect(redact(`[wow] running from C:\\Users\\alice\\Games`, home)).toBe("[wow] running from C:\\Users\\<user>\\Games");
    expect(redact("[boot] env OPENAI_API_KEY=sk-live-0123456789abcdefghij x", home)).toBe("[boot] env OPENAI_API_KEY=[redacted] x");
    expect(redact("Authorization: Bearer abc.def", home)).toBe("Authorization: Bearer [redacted]");
    expect(redact(`[hub] digest ${hex64} mismatch`, home)).toBe("[hub] digest [redacted] mismatch");
  });

  it("shortens UUIDs to their first 8 chars and leaves ordinary text alone", () => {
    expect(redact(`[claude] query error (${uuid}): overloaded`, home)).toBe("[claude] query error (123e4567…): overloaded");
    for (const plain of [
      "[link] linked (fps 30, decoded 12, crc 0, missed 1)",
      "[wow] flavor _classic_beta_ product wowxptr version 1.15.3 iface 16001 (registry): Interface 16001 is listed",
      "[dev] test hooks on 127.0.0.1:47810 (token in %TEMP%\\familiar-dev-47810.token)",
      "[boot] provider hermes: hermes (2 args)",
      "[install] addon already installed at C:\\Program Files (x86)\\World of Warcraft\\_classic_beta_\\Interface\\AddOns",
      "[hub] https://github.com/Zeezy3z/familiar/blob/main/companion/src/main/main.ts#L51 opened",
      "----------------------------------------------------------------",
      "[addon] prompt (24 chars)",
    ]) expect(redact(plain, home)).toBe(plain);
  });

  it("caps lines", () => {
    const long = "[x] " + "a ".repeat(500);
    const out = redact(long, home);
    expect(out.length).toBe(LOG_LINE_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(redact("short", home)).toBe("short");
    expect(redact("", home)).toBe("");
  });
});

describe("diagnostics", () => {
  it("lists changed config keys by name, values only for booleans, and redacts the log tail", () => {
    const defaults = { sound: true, quiet: false, wowRoot: "C:\\Program Files (x86)\\World of Warcraft", exclude: ["a"], projects: [] };
    const cfg = { sound: false, quiet: false, wowRoot: "D:\\Games\\WoW", exclude: ["a"], projects: ["C:\\Users\\zed\\dev\\secret-project"], claudeExecutable: "C:\\Users\\zed\\bin\\claude.exe" };
    const keys = changedConfigKeys(cfg, defaults);
    expect(keys).toEqual(["claudeExecutable", "projects", "sound=false", "wowRoot"]);
    const text = diagnosticsText({
      version: "0.1.0", build: "commit abc (clean)", electron: "44.5.1", node: "24.0.0", windows: "10.0.26200 (x64)",
      wow: "_classic_beta_ iface 16001", capture: "mode window, fps 30", providers: ["claude installed, signed in, on"],
      configKeys: keys, log: ["2026-01-01T00:00:00.000Z [x] token=abc123 at C:\\Users\\alice\\x"],
    });
    expect(text).toContain("Companion: 0.1.0");
    expect(text).toContain("Config (non-default keys): claudeExecutable, projects, sound=false, wowRoot");
    expect(text).not.toContain("secret-project");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("alice");
    expect(text).toContain("--- log (last 1 lines) ---");
  });
});

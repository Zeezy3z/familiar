// familiar.log is for diagnosing Familiar, not a transcript: what the player typed and who they are
// never reach it, and it can't grow without bound.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { describeAddonMessage, logLine, rotateLog } from "../src/main/log-file";

describe("familiar.log", () => {
  it("records addon messages by type and size, never their text or the character", () => {
    expect(describeAddonMessage({ t: "prompt", text: "delete my secret project" })).toBe("[addon] prompt (24 chars)");
    expect(describeAddonMessage({ t: "quests", text: "Synthetic quest: [ ] 0/1" })).toBe("[addon] quests (24 chars)");
    expect(describeAddonMessage({ t: "key", k: "approve" })).toBe("[addon] key approve");
    const hello = describeAddonMessage({ t: "hello", char: "Synthchar", realm: "Synthrealm", build: "1.0", iface: 16001, addon: "0.3" });
    expect(hello).toBe("[addon] hello build 1.0 iface 16001 addon 0.3");
    expect(logLine("x", new Date("2026-10-16T18:00:00.000Z"))).toBe("2026-10-16T18:00:00.000Z x");
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

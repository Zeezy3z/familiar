// Which codex.exe Familiar runs: override, `codex` on PATH (a real .exe, or the binary behind npm's
// codex.cmd shim), then the desktop app's bundled one. Fixture trees only; PATH and the install
// folders resolveCommand also searches are pointed at a temp dir.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCodexExe } from "../src/agents/codex";

const KEYS = ["PATH", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME"] as const;
let saved: Partial<Record<(typeof KEYS)[number], string>>;
let tmp: string;
const touch = (...p: string[]) => {
  const f = path.join(tmp, ...p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "");
  return f;
};

describe.runIf(process.platform === "win32")("findCodexExe", () => {
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-codex-"));
    for (const k of ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME"] as const) process.env[k] = path.join(tmp, k.toLowerCase());
    process.env.PATH = path.join(tmp, "npm");
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const npmExe = () => {
    touch("npm", "codex.cmd");
    return touch("npm", "node_modules", "@openai", "codex", "node_modules", "@openai", `codex-win32-${process.arch === "arm64" ? "arm64" : "x64"}`,
      "vendor", process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc", "bin", "codex.exe");
  };

  it("resolves npm's codex.cmd shim to the real binary in its package", () => {
    const exe = npmExe();
    expect(findCodexExe()).toBe(exe);
  });

  it("a codex.exe on PATH (winget/scoop) wins over the npm shim", () => {
    npmExe();
    const winget = touch("npm", "codex.exe");
    expect(findCodexExe()).toBe(winget);
  });

  it("the codexExe override wins over everything; a missing override is ignored", () => {
    const exe = npmExe();
    touch("localappdata", "OpenAI", "Codex", "bin", "abc123", "codex.exe");
    const override = touch("custom", "codex.exe");
    expect(findCodexExe(override)).toBe(override);
    expect(findCodexExe(path.join(tmp, "nope", "codex.exe"))).toBe(exe);
  });

  it("falls back to the desktop app's bundled codex.exe; nothing installed → undefined", () => {
    expect(findCodexExe()).toBeUndefined();
    touch("npm", "codex.cmd"); // a shim whose package is gone
    expect(findCodexExe()).toBeUndefined();
    const app = touch("localappdata", "OpenAI", "Codex", "bin", "abc123", "codex.exe");
    expect(findCodexExe()).toBe(app);
  });
});

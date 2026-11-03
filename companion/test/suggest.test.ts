// "Suggest a change": the pre-filled GitHub issue URL (pure kernel; main and the hub share it).
import { describe, expect, it } from "vitest";
import { ISSUE_URL_PREFIX, isIssueUrl, suggestionUrl } from "../src/hub/suggest";

const V = { familiar: "0.1.0", wow: "1.60.2.70500", iface: 16002, windows: "10.0.26200" };

describe("suggestionUrl", () => {
  it("targets the suggestion form and fills its fields by id", () => {
    const url = suggestionUrl("Bigger font & a dark mode?", V)!;
    expect(url.startsWith(ISSUE_URL_PREFIX + "?")).toBe(true);
    expect(isIssueUrl(url)).toBe(true);
    const q = new URL(url).searchParams;
    expect([...q.keys()].sort()).toEqual(["diagnostics", "suggestion", "template", "title"]);
    expect(q.get("template")).toBe("suggestion.yml");
    expect(q.get("suggestion")).toBe("Bigger font & a dark mode?");
    expect(q.get("title")).toBe("[Suggest] Bigger font & a dark mode?");
    expect(q.get("diagnostics")).toBe("Familiar 0.1.0\nWoW client 1.60.2.70500 (interface 16002)\nWindows 10.0.26200");
    // Encoded: no raw spaces, "&", "?" or "+" inside values.
    expect(url).not.toMatch(/ /);
    expect(url).toContain("%26");
    expect(url).not.toContain("+");
  });

  it("caps the title at 80 characters of the text and collapses newlines", () => {
    const text = "a".repeat(70) + "\nline two " + "b".repeat(50);
    const q = new URL(suggestionUrl(text, V)!).searchParams;
    expect(q.get("title")).toBe("[Suggest] " + ("a".repeat(70) + " line two").slice(0, 80));
    expect(q.get("title")!.length).toBeLessThanOrEqual("[Suggest] ".length + 80);
    expect(q.get("suggestion")).toBe(text);
  });

  it("carries only the text and versions: no paths, character names or logs", () => {
    const url = suggestionUrl("idea", { ...V, ...({ path: String.raw`C:\Users\me\wow`, char: "Thrall", realm: "Forever", log: "secret" } as object) })!;
    const q = new URL(url).searchParams;
    for (const leak of ["Users", "Thrall", "Forever", "secret", "path", "char"]) expect(decodeURIComponent(url)).not.toContain(leak);
    expect(q.get("diagnostics")).not.toMatch(/[\\/]/);
  });

  it("missing versions show as ?, empty text gives nothing", () => {
    expect(new URL(suggestionUrl("x", {})!).searchParams.get("diagnostics")).toBe("Familiar ?\nWoW client ? (interface ?)\nWindows ?");
    expect(suggestionUrl("   \n ", V)).toBeUndefined();
  });

  it("the shell gate accepts only our new-issue form (exact prefix)", () => {
    expect(isIssueUrl(ISSUE_URL_PREFIX + "?template=suggestion.yml")).toBe(true);
    for (const bad of [
      "https://github.com/Zeezy3z/familiar/issues/newer?x=1",
      "https://github.com/Zeezy3z/familiar/issues/new/../../evil",
      "https://github.com/Zeezy3z/familiar-evil/issues/new?x=1",
      "http://github.com/Zeezy3z/familiar/issues/new?x=1",
      "https://github.com.evil.io/Zeezy3z/familiar/issues/new?x=1",
      "file:///C:/Windows/system32/calc.exe",
    ]) expect(isIssueUrl(bad)).toBe(false);
  });
});

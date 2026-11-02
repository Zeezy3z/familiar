// The shipped defaults carry no one's machine: no project roots, only generic exclusions.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/hub/config";

describe("DEFAULT_CONFIG", () => {
  it("offers no project roots until the user adds some", () => {
    expect(DEFAULT_CONFIG.projectRoots).toEqual([]);
    expect(DEFAULT_CONFIG.projects).toEqual([]);
  });

  it("excludes only generic folders, never an absolute or personal path", () => {
    // An allowlist rather than a denylist: naming private folders here would publish them.
    const generic = ["\\node_modules", "\\.git\\", "\\appdata\\local\\temp", "\\$recycle.bin"];
    expect(DEFAULT_CONFIG.exclude.length).toBeGreaterThan(0);
    for (const e of DEFAULT_CONFIG.exclude) {
      expect(generic, e).toContain(e);
      expect(e, e).not.toMatch(/^[a-z]:|^\\\\|^\/|dev|archive|migration/i);
    }
    // The one drive path is Blizzard's standard install location, not a user folder.
    expect(DEFAULT_CONFIG.wowRoot).toBe("C:\\Program Files (x86)\\World of Warcraft");
    expect(JSON.stringify({ ...DEFAULT_CONFIG, wowRoot: undefined })).not.toContain("C:\\\\");
  });
});

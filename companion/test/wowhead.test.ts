// Parsing and host checks for the Wowhead map tool. The fixtures are byte-exact excerpts of real
// Wowhead Classic pages, so a change here means the code moved, not the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatWowheadMap, lookupWowheadMap, parseWowheadMap, wowheadPageUrl } from "../src/agents/wowhead";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), { encoding: "utf-8" });

describe("Wowhead map tool", () => {
  it("reads zone and coordinates from NPC and quest page scripts", () => {
    const npc = parseWowheadMap(fixture("wowhead-npc-4585.html"));
    expect(npc).toEqual({
      name: "Ezekiel Graves",
      locations: [{ zone: "Undercity", total: 4, coords: [[75.4, 51.4], [75.4, 51.6], [75.6, 51.4], [75.6, 51.6]] }],
    });
    expect(formatWowheadMap(npc)).toContain("Undercity: 75.4,51.4; 75.4,51.6; 75.6,51.4; 75.6,51.6");

    expect(parseWowheadMap(fixture("wowhead-quest-783.html")).locations).toEqual([
      { zone: "Elwynn Forest", label: "start: Deputy Willem", total: 1, coords: [[48.2, 42.8]] },
      { zone: "Elwynn Forest", label: "end: Marshal McBride", total: 1, coords: [[48.8, 41.6]] },
    ]);

    expect(parseWowheadMap("<html>no scripts</html>").locations).toEqual([]);
    expect(parseWowheadMap("<script>var g_mapperData = [];</script>").locations).toEqual([]);
    expect(parseWowheadMap('<script>var g_mapperData = {"1":[{"coords":[[1,').locations).toEqual([]);
  });

  it("only ever builds a Wowhead Classic NPC, object or quest URL, without the query", () => {
    expect(wowheadPageUrl("npc=4585")).toBe("https://www.wowhead.com/classic/npc=4585");
    expect(wowheadPageUrl("https://www.wowhead.com/classic/quest=783/a-threat-within?secret=1#x")).toBe("https://www.wowhead.com/classic/quest=783");
    for (const bad of [
      "4585",
      "item=2589",
      "http://www.wowhead.com/classic/npc=4585",
      "https://wowhead.com/classic/npc=4585",
      "https://www.wowhead.com/npc=4585",
      "https://www.wowhead.com/classic/../npc=4585",
      "https://www.wowhead.com.evil.example/classic/npc=4585",
      "https://www.wowhead.com@evil.example/classic/npc=4585",
      "https://user:pass@www.wowhead.com/classic/npc=4585",
      "https://www.wowhead.com:8443/classic/npc=4585",
      "https://evil.example/?u=https://www.wowhead.com/classic/npc=4585",
    ]) {
      expect(wowheadPageUrl(bad), bad).toBeUndefined();
    }
  });

  it("checks every redirect before following it, and caps the page size", async () => {
    const asked: string[] = [];
    const answering = (...replies: Response[]) =>
      (async (url: any) => {
        asked.push(String(url));
        return replies.shift()!;
      }) as typeof fetch;
    const redirect = (location: string) => new Response(null, { status: 301, headers: { location } });

    const page = fixture("wowhead-npc-4585.html");
    const map = await lookupWowheadMap("npc=4585", answering(redirect("/classic/npc=4585/ezekiel-graves"), new Response(page)));
    expect(map.locations[0].zone).toBe("Undercity");
    expect(asked).toEqual(["https://www.wowhead.com/classic/npc=4585", "https://www.wowhead.com/classic/npc=4585/ezekiel-graves"]);

    asked.length = 0;
    for (const away of ["https://evil.example/classic/npc=4585", "/npc=4585"]) {
      await expect(lookupWowheadMap("npc=4585", answering(redirect(away)))).rejects.toThrow(/redirected away/);
    }
    expect(asked).toEqual(["https://www.wowhead.com/classic/npc=4585", "https://www.wowhead.com/classic/npc=4585"]);

    await expect(lookupWowheadMap("npc=4585", answering(new Response("x".repeat(3 * 1024 * 1024 + 1))))).rejects.toThrow(/too large/);
    await expect(lookupWowheadMap("https://evil.example/", answering())).rejects.toThrow(/Only Wowhead Classic/);
  });
});

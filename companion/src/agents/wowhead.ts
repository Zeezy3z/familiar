// Map coordinates for Claude chats: Wowhead keeps them in inline page scripts, which WebFetch's
// page-to-text step drops. This reads only those scripts, from Wowhead Classic pages only.
// Fragile by nature: it depends on undocumented page markup, so a redesign makes it find nothing.
import { z } from "zod/v4";

type Sdk = typeof import("@anthropic-ai/claude-agent-sdk");

/** How the SDK names the tool for allowedTools: mcp__<server>__<tool>. */
export const WOWHEAD_MAP_TOOL = "mcp__familiar__wowhead_map";

const HOST = "www.wowhead.com";
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_COORDS_PER_LOCATION = 20;
const MAX_REPLY_CHARS = 6000;
// Says who is asking and nothing else. No cookies: Node's fetch, not an Electron session.
const USER_AGENT = "Familiar (+https://github.com/Zeezy3z/familiar)";

export type Coord = [number, number];
export interface WowheadLocation {
  zone: string;
  /** What is at these points, on quest pages ("start: Deputy Willem"). */
  label?: string;
  /** All points the page lists, before `coords` is thinned out. */
  total: number;
  coords: Coord[];
}
export interface WowheadMap {
  name?: string;
  locations: WowheadLocation[];
}

const isClassicUrl = (u: URL) => u.protocol === "https:" && u.hostname === HOST && !u.port && !u.username && !u.password && u.pathname.startsWith("/classic/");

/** The one URL a reference may fetch, or undefined if it isn't a Wowhead Classic NPC/object/quest.
 * Rebuilt from the kind and id, so nothing else in the reference (query, fragment) is ever sent. */
export function wowheadPageUrl(ref: string): string | undefined {
  const s = ref.trim();
  let m = /^(npc|object|quest)=(\d{1,9})$/.exec(s);
  if (!m) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return undefined;
    }
    if (!isClassicUrl(u)) return undefined;
    m = /^\/classic\/(npc|object|quest)=(\d{1,9})(?:\/[^/]*)?\/?$/.exec(u.pathname);
  }
  return m ? `https://${HOST}/classic/${m[1]}=${m[2]}` : undefined;
}

/** The JSON value starting at `start`, ended by its own closing bracket, or undefined. */
function jsonAt(text: string, start: number): unknown {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth > 0) continue;
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    } else if (depth === 0) return undefined;
  }
  return undefined;
}

function scriptValue(html: string, marker: RegExp): any {
  const m = marker.exec(html);
  return m ? jsonAt(html, m.index + m[0].length) : undefined;
}

/** Page text is Wowhead's, not ours: keep it short and on one line before the model sees it. */
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80) : "");

function location(zone: unknown, coords: unknown, label?: string): WowheadLocation | undefined {
  const name = clean(zone);
  const valid = (Array.isArray(coords) ? coords : []).filter(
    (c): c is Coord => Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === "number" && n >= 0 && n <= 100),
  );
  if (!name || !valid.length) return undefined;
  // Evenly spaced, because the list is sorted by x: the first 20 of 185 would all be in the west.
  const n = Math.min(valid.length, MAX_COORDS_PER_LOCATION);
  const picked = Array.from({ length: n }, (_, i) => valid[Math.floor((i * valid.length) / n)]);
  return { zone: name, ...(label ? { label } : {}), total: valid.length, coords: picked };
}

const values = (v: unknown): any[] => (v && typeof v === "object" ? Object.values(v) : []);

/** Zones and coordinates from a Wowhead Classic page's scripts. NPC and object pages keep them in
 * `var g_mapperData`, quest pages in the `objectives` given to `new Mapper(...)`. */
export function parseWowheadMap(html: string): WowheadMap {
  const mapper = scriptValue(html, /new Mapper\(\s*/);
  const found: (WowheadLocation | undefined)[] = [];
  for (const floors of values(scriptValue(html, /\bg_mapperData\s*=\s*/))) {
    for (const f of values(floors)) found.push(location(f?.uiMapName, f?.coords));
  }
  for (const zone of values(mapper?.objectives)) {
    for (const point of values(zone?.levels).flatMap(values)) {
      const label = [clean(point?.point), clean(point?.name)].filter(Boolean).join(": ");
      const item = clean(point?.item);
      found.push(location(zone?.zone, point?.coords, item ? `${label} (${item})` : label));
    }
  }
  const name = clean(mapper?.name);
  return { ...(name ? { name } : {}), locations: found.filter((l): l is WowheadLocation => !!l) };
}

/** The tool's reply to the model. */
export function formatWowheadMap(map: WowheadMap): string {
  if (!map.locations.length) {
    return "No map coordinates on that Wowhead Classic page. Instance bosses and things that aren't placed in the world have none; for an open-world NPC, Wowhead's page layout may have changed.";
  }
  const lines = map.locations.map((l) => {
    const where = l.label ? `${l.zone}, ${l.label}` : l.zone;
    const shown = l.coords.map(([x, y]) => `${x},${y}`).join("; ");
    return `${where}: ${shown}${l.total > l.coords.length ? ` (${l.coords.length} of ${l.total} points)` : ""}`;
  });
  const head = `Wowhead Classic data${map.name ? ` for ${map.name}` : ""} (zone: x,y map coordinates):`;
  const reply = [head, ...lines].join("\n");
  return reply.length > MAX_REPLY_CHARS ? `${reply.slice(0, MAX_REPLY_CHARS)}\n(cut short: the page lists more)` : reply;
}

async function readCapped(r: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = r.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new Error("That Wowhead page is too large to read.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Fetch and parse one page. Follows redirects by hand so that every hop is checked before it is
 * requested: Wowhead redirects npc=4585 to npc=4585/ezekiel-graves, and nothing leaves its Classic
 * paths. Throws with a message meant for the model. */
export async function lookupWowheadMap(ref: string, fetchFn: typeof fetch = fetch): Promise<WowheadMap> {
  let url = wowheadPageUrl(ref);
  if (!url) throw new Error("Only Wowhead Classic NPC, object and quest pages work here: https://www.wowhead.com/classic/npc=ID, or just npc=ID, object=ID or quest=ID.");
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await fetchFn(url, { redirect: "manual", signal, headers: { "user-agent": USER_AGENT, accept: "text/html" } });
    if (r.status < 300 || r.status >= 400) {
      if (r.status === 404) throw new Error("Wowhead Classic has no such page.");
      if (!r.ok) throw new Error(`Wowhead answered ${r.status}, so no coordinates this time.`);
      return parseWowheadMap(await readCapped(r));
    }
    await r.body?.cancel();
    const next = new URL(r.headers.get("location") ?? "", url);
    if (!isClassicUrl(next)) throw new Error("Wowhead redirected away from its Classic pages, which this tool won't follow.");
    url = next.href;
  }
  throw new Error("Too many redirects from Wowhead.");
}

/** The in-process MCP server for Claude chats: one read-only tool. `alwaysLoad` because a chat's
 * tool list has no ToolSearch to find a deferred tool with. */
export function wowheadMcpServer(sdk: Pick<Sdk, "createSdkMcpServer" | "tool">) {
  const wowheadMap = sdk.tool(
    "wowhead_map",
    "Zone and x,y map coordinates of a World of Warcraft Classic NPC, object or quest (quest start, end and objectives), read from its Wowhead Classic page. WebFetch can't see these.",
    { url: z.string().max(300).describe("A https://www.wowhead.com/classic/ page URL, or npc=ID, object=ID or quest=ID") },
    async ({ url }) => {
      try {
        return { content: [{ type: "text" as const, text: formatWowheadMap(await lookupWowheadMap(url)) }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: String(e?.message ?? e) }], isError: true };
      }
    },
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );
  return sdk.createSdkMcpServer({ name: "familiar", alwaysLoad: true, tools: [wowheadMap] });
}

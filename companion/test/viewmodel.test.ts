// The Quest Log as the Glass paints it: zones keep one order (Chats, then by name) whatever is running, each
// zone lists its five newest rows plus "+N more" (never hiding what needs you), every row says its age, and
// rows with the same title tell apart. Also the words a refused card and the practice quest use.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentBackend, AgentEvent, BackendStatus, StartOptions, ThreadInfo } from "../src/agents/types";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "familiar-viewmodel-")));
process.env.APPDATA = tmp;
const projRoot = path.join(tmp, "dev");
for (const p of ["Zeta", "alpha", "middle"]) fs.mkdirSync(path.join(projRoot, p), { recursive: true });

const { Hub } = await import("../src/hub/hub");
const { DEFAULT_CONFIG } = await import("../src/hub/config");
const { buildModel, ROWS_PER_ZONE } = await import("../src/hub/viewmodel");
const { tutorialReply, tutorialThread } = await import("../src/hub/tutorial");

class FakeBackend implements AgentBackend {
  handlers: ((e: AgentEvent) => void)[] = [];
  open_ = new Set<string>();
  constructor(readonly kind: string) {}
  async init(): Promise<BackendStatus> { return this.status(); }
  status(): BackendStatus { return { ready: true, account: "test", models: [{ id: "m1", label: "M1", isDefault: true }] }; }
  async listThreads(): Promise<ThreadInfo[]> { return []; }
  async readHistory() { return []; }
  isOpen(id: string) { return this.open_.has(id); }
  async open(o: StartOptions) { this.open_.add(o.threadId); return `native-${o.threadId}`; }
  async send() {}
  async interrupt() {}
  respondApproval() {}
  async setMode() {}
  async setModel() {}
  async close(id: string) { this.open_.delete(id); }
  async shutdown() {}
  on(h: (e: AgentEvent) => void) { this.handlers.push(h); return () => {}; }
  emit(e: AgentEvent) { for (const h of this.handlers) h(e); }
}

const cfg = { ...DEFAULT_CONFIG, projectRoots: [projRoot], exclude: DEFAULT_CONFIG.exclude.filter((e) => !e.includes("temp")) };
let claude: FakeBackend, hub: InstanceType<typeof Hub>;
const rows = () => buildModel(hub, { linked: true, fps: 30 }).list.rows;
const zones = () => rows().filter((r) => r.kind === "zone").map((r) => r.text);
const zoneRows = (name: string) => {
  const all = rows();
  const i = all.findIndex((r) => r.kind === "zone" && r.text === name);
  const j = all.findIndex((r, k) => k > i && r.kind === "zone");
  return all.slice(i + 1, j < 0 ? undefined : j);
};
/** Start a quest and let it finish; `ageMin` back-dates when it started and last moved. */
async function quest(zone: string, title: string, ageMin = 0) {
  (hub as unknown as { budgets: { start: number[] } }).budgets.start = []; // these quests are spread over days
  await hub.quick("claude", `@${zone} ${title}`);
  const id = hub.view.selected!;
  claude.emit({ type: "done", threadId: id, status: "completed" });
  const t = hub.threads.get(id)!;
  t.createdAt = t.updatedAt = Date.now() - ageMin * 60_000;
  t.unread = false;
  return id;
}

beforeEach(async () => {
  process.env.APPDATA = fs.mkdtempSync(path.join(tmp, "state-"));
  cfg.approveByClick = false;
  claude = new FakeBackend("claude");
  hub = new Hub(() => cfg, { claude }, () => {});
  hub.minCardAgeMs = 0;
  hub.projects.scanRoots();
});

describe("quest log", () => {
  it("keeps Chats first and the zones by name while quests run, and marks what needs you on the zone", async () => {
    await quest("middle", "m1", 30);
    const z = await quest("Zeta", "z1", 20);
    await quest("alpha", "a1", 10);
    expect(zones()).toEqual(["Chats", "alpha", "middle", "Zeta"]);
    // The last zone gets busy: nothing moves, the zone and the row carry the mark.
    claude.emit({ type: "turnStarted", threadId: z });
    claude.emit({ type: "approval", threadId: z, requestId: "r1", kind: "command", title: "Run?", detail: "npm test", canAlways: false });
    expect(zones()).toEqual(["Chats", "alpha", "middle", "Zeta"]);
    expect(rows().find((r) => r.kind === "zone" && r.text === "Zeta")).toMatchObject({ status: "approval" });
    expect(zoneRows("Zeta")[0]).toMatchObject({ key: z, status: "approval" });
  });

  it("lists the five newest quests of a zone with their age, then +N more; a reply never moves a row", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await quest("alpha", `quest ${i}`, 600 - i * 60)); // quest 6 is the newest
    const listed = zoneRows("alpha");
    expect(listed.filter((r) => r.kind === "thread").map((r) => r.text)).toEqual(["quest 6", "quest 5", "quest 4", "quest 3", "quest 2"]);
    expect(listed.filter((r) => r.kind === "thread").length).toBe(ROWS_PER_ZONE);
    expect(listed.every((r) => r.kind !== "thread" || /ago|just now/.test(r.sub ?? ""))).toBe(true);
    expect(listed.at(-1)).toMatchObject({ kind: "hint", text: "+2 more", act: { type: "zoneMore" } });
    // An older quest answering does not move up; the newest-started order stays.
    claude.emit({ type: "message", threadId: ids[3], itemId: "x", text: "late reply" });
    expect(zoneRows("alpha").filter((r) => r.kind === "thread").map((r) => r.text).slice(0, 5)).toEqual(["quest 6", "quest 5", "quest 4", "quest 3", "quest 2"]);
    // A hidden quest that needs you is shown in its place anyway.
    claude.emit({ type: "approval", threadId: ids[0], requestId: "r0", kind: "command", title: "Run?", detail: "npm test", canAlways: false });
    expect(zoneRows("alpha").filter((r) => r.kind === "thread").map((r) => r.text)).toContain("quest 0");
    expect(zoneRows("alpha").at(-1)).toMatchObject({ text: "+1 more" });
    hub.action({ type: "zoneMore", key: hub.threads.get(ids[0])!.projectKey });
    expect(zoneRows("alpha").filter((r) => r.kind === "thread")).toHaveLength(7);
  });

  it("tells same-titled rows apart by age, and by the time when the age reads the same", async () => {
    await quest("alpha", "Untitled", 3 * 24 * 60);
    await quest("alpha", "Untitled", 60);
    expect(zoneRows("alpha").map((r) => r.sub)).toEqual(["1h ago", "3d ago"]);
    await quest("middle", "Same", 3 * 24 * 60);
    await quest("middle", "Same", 3 * 24 * 60 + 5);
    const subs = zoneRows("middle").map((r) => r.sub!);
    expect(subs.every((s) => /^\d+ \w{3} \d\d:\d\d$/.test(s))).toBe(true);
    expect(new Set(subs).size).toBe(2);
  });
});

describe("approval words", () => {
  it("a refused card names the Approve key first, and clicking only with click approval on", async () => {
    const id = await quest("alpha", "card");
    claude.emit({ type: "approval", threadId: id, requestId: "r1", kind: "command", title: "Run?", detail: "npm test", canAlways: false });
    hub.select(id);
    hub.action({ type: "decide", thread: id, requestId: "r1", decision: "allow" });
    const line = () => {
      const d = buildModel(hub, { linked: true, fps: 30 }).detail;
      return d.kind === "thread" ? d.entries.find((e) => e.kind === "approval")?.refused : undefined;
    };
    // No Approve key set: never "press your Approve key"; Requests waiting on the PC can approve it now.
    expect(line()).toBe("No Approve key is set. Approve it in Requests waiting in Familiar on your PC.");
    cfg.approveKey = "F9";
    expect(line()).toBe("Not confirmed as yours. With this request on screen, press your Approve key again.");
    cfg.approveByClick = true;
    expect(line()).toBe("Not confirmed as yours. With this request on screen, press your Approve key, or click Approve again.");
    expect(line()).not.toMatch(/^Click/);
    cfg.approveKey = "";
    expect(line()).toBe("Not confirmed as yours. With this request on screen, click Approve again.");
  });

  it("the practice quest teaches the Approve key before clicking", () => {
    let n = 0;
    const t = tutorialThread("t", tmp, "Rogue", (p) => `${p}${n++}`);
    const said = tutorialReply(t, (p) => `${p}${n++}`).find((e) => e.type === "message") as { text: string };
    expect(said.text.indexOf("Approve** key")).toBeGreaterThan(-1);
    expect(said.text.indexOf("Approve** key")).toBeLessThan(said.text.indexOf("clicking"));
  });
});

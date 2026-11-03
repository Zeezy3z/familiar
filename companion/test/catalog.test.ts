// Readers for what the Claude desktop app records about its sessions (fixture files, no real data).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRoots, readBusySessions, readDesktopSessions } from "../src/agents/claude-desktop";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-catalog-"));

describe("Claude desktop catalog", () => {
  it("keeps a desktop thread's own mode for the game, except modes that skip asking", () => {
    const org = path.join(tmp, "modes", "acct", "org");
    fs.mkdirSync(org, { recursive: true });
    const modes: Record<string, string | undefined> = { plan: "plan", acceptEdits: "edits", default: "ask", auto: "ask", bypassPermissions: "ask", dontAsk: "ask", somethingNew: "ask" };
    for (const pm of Object.keys(modes)) fs.writeFileSync(path.join(org, `local_${pm}.json`), JSON.stringify({ sessionId: `local_${pm}`, cliSessionId: pm, permissionMode: pm }));
    fs.writeFileSync(path.join(org, "local_none.json"), JSON.stringify({ sessionId: "local_none", cliSessionId: "none" }));
    const m = readDesktopSessions(path.join(tmp, "modes"));
    for (const [pm, mode] of Object.entries(modes)) expect(m.get(pm)?.mode, pm).toBe(mode);
    expect(m.get("none")?.mode).toBeUndefined(); // no mode recorded: Familiar's default applies
  });

  it("maps transcript ids to archive/star/scheduled state and the worktree's project", () => {
    const org = path.join(tmp, "sessions", "acct", "org");
    fs.mkdirSync(org, { recursive: true });
    const write = (name: string, o: object) => fs.writeFileSync(path.join(org, name), JSON.stringify(o));
    write("local_a.json", { sessionId: "local_a", cliSessionId: "cli-a", cwd: "D:\\src\\X\\.claude\\worktrees\\w", originCwd: "D:\\src\\X", isArchived: true, title: "A", completedTurns: 3 });
    write("local_b.json", { sessionId: "local_b", cliSessionId: "cli-b", cwd: "D:\\src\\Y", originCwd: "D:\\src\\Y", isStarred: true, scheduledTaskId: "t1" });
    write("local_c.json", { sessionId: "local_c" }); // no transcript yet
    write("local_bad.json", {} as any);
    fs.writeFileSync(path.join(org, "local_broken.json"), "{not json");
    fs.writeFileSync(path.join(org, "archived-sessions.idx"), "{}");

    const m = readDesktopSessions(path.join(tmp, "sessions"));
    expect([...m.keys()].sort()).toEqual(["cli-a", "cli-b"]);
    expect(m.get("cli-a")).toMatchObject({ archived: true, starred: false, scheduled: false, originCwd: "D:\\src\\X", title: "A", completedTurns: 3 });
    expect(m.get("cli-b")).toMatchObject({ archived: false, starred: true, scheduled: true, originCwd: undefined });

    // Re-read picks up changes (mtime-keyed cache).
    write("local_a.json", { sessionId: "local_a", cliSessionId: "cli-a", isArchived: false });
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(org, "local_a.json"), t, t);
    expect(readDesktopSessions(path.join(tmp, "sessions")).get("cli-a")!.archived).toBe(false);
  });

  it("finds the Store (MSIX) app's records in its package cache, and merges roots newest-first", () => {
    const home = path.join(tmp, "home");
    const env = { APPDATA: path.join(home, "Roaming"), LOCALAPPDATA: path.join(home, "Local") };
    const classic = path.join(env.APPDATA, "Claude", "claude-code-sessions");
    const store = path.join(env.LOCALAPPDATA, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "claude-code-sessions");
    fs.mkdirSync(path.join(env.LOCALAPPDATA, "Packages", "SomethingElse_123"), { recursive: true });
    const write = (root: string, name: string, o: object) => {
      const org = path.join(root, "acct", "org");
      fs.mkdirSync(org, { recursive: true });
      fs.writeFileSync(path.join(org, name), JSON.stringify(o));
    };
    write(store, "local_s.json", { sessionId: "local_s", cliSessionId: "cli-s", title: "Store only" });
    write(classic, "local_old.json", { sessionId: "local_old", cliSessionId: "cli-both", title: "old", lastActivityAt: 1 });
    write(store, "local_new.json", { sessionId: "local_new", cliSessionId: "cli-both", title: "new", lastActivityAt: 2 });

    const roots = defaultRoots(env, home);
    expect(roots).toEqual([classic, store]);
    const m = readDesktopSessions(roots);
    expect(m.get("cli-s")?.title).toBe("Store only");
    expect(m.get("cli-both")?.title).toBe("new");
  });

  it("busy sessions need a live process; .key files are never read", () => {
    const dir = path.join(tmp, "pids");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "me", status: "busy" }));
    fs.writeFileSync(path.join(dir, "4000000.json"), JSON.stringify({ pid: 4000000, sessionId: "dead", status: "busy" }));
    fs.writeFileSync(path.join(dir, "1.json"), JSON.stringify({ pid: process.pid, sessionId: "idle", status: "idle" }));
    fs.writeFileSync(path.join(dir, `${process.pid}.abc.key`), "secret");
    expect([...readBusySessions(dir)]).toEqual(["me"]);
  });

  it("open sessions: any live interactive process, busy or idle; SDK runs don't count", async () => {
    const { readLiveSessions } = await import("../src/agents/claude-desktop");
    const dir = path.join(tmp, "pids-open");
    fs.mkdirSync(dir, { recursive: true });
    const w = (n: string, o: object) => fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(o));
    w("1", { pid: process.pid, sessionId: "tab", status: "idle", entrypoint: "claude-desktop" });
    w("2", { pid: process.pid, sessionId: "working", status: "busy", entrypoint: "cli" });
    w("3", { pid: process.pid, sessionId: "mine", status: "busy", entrypoint: "sdk-ts" });
    w("4", { pid: 4000000, sessionId: "closed", status: "idle" });
    const m = readLiveSessions(dir);
    expect(Object.fromEntries(m)).toEqual({ tab: { busy: false }, working: { busy: true } });
  });

  it("forks only when the thread is working or open elsewhere (else by recency, if unknown)", async () => {
    const { mustFork } = await import("../src/hub/hub");
    const now = 1_000_000_000;
    expect(mustFork({ open: false, updatedAt: now - 1000 }, now)).toBe(false); // closed, just used: same thread
    expect(mustFork({ open: true, updatedAt: now - 86_400_000 }, now)).toBe(true); // open in a tab
    expect(mustFork({ open: false, running: true, updatedAt: now }, now)).toBe(true);
    expect(mustFork({ updatedAt: now - 60_000 }, now)).toBe(true); // can't tell: recent → fork
    expect(mustFork({ updatedAt: now - 3_600_000 }, now)).toBe(false);
  });
});

describe("Hermes session store (state.db, read-only)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { hermesCatalog } = await import("../src/agents/hermes");
  const db = path.join(tmp, "state.db");
  const w = new DatabaseSync(db);
  w.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, cwd TEXT, model_config TEXT, started_at REAL,
            last_activity_at REAL, archived INTEGER, pinned INTEGER, hidden INTEGER, end_reason TEXT, parent_session_id TEXT,
            message_count INTEGER, display_name TEXT, chat_id TEXT);
          CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, active INTEGER);`);
  const s = w.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const t0 = 1791300000;
  s.run("tg1", "telegram", null, null, null, t0, t0 + 50, 0, 0, 0, "compression", null, 2, "Secret Name", "12345");
  s.run("tg1b", "telegram", null, null, null, t0 + 60, t0 + 900, 0, 0, 0, null, "tg1", 2, null, null);
  s.run("cli1", "cli", "Refactor parser", "D:\src\X", null, t0 + 10, t0 + 100, 0, 1, 0, null, null, 3, null, null);
  s.run("acp1", "acp", "From Familiar", "D:\\src\\familiar", null, t0 + 20, t0 + 200, 0, 0, 0, null, null, 2, null, null);
  s.run("cron1", "cron", "Nightly", null, null, t0, t0 + 300, 0, 0, 0, null, null, 4, null, null);
  s.run("sub1", "cli", "Delegated", "D:\src\X", '{"_delegate_from":"cli1"}', t0, t0 + 400, 0, 0, 0, null, null, 2, null, null);
  s.run("hid1", "desktop", "Bot mode", null, null, t0, t0 + 500, 0, 0, 1, null, null, 2, null, null);
  s.run("empty", "desktop", "Nothing", null, null, t0, t0 + 600, 0, 0, 0, null, null, 0, null, null);
  const m = w.prepare("INSERT INTO messages (session_id, role, content, tool_name, active) VALUES (?,?,?,?,?)");
  m.run("tg1", "user", "where is the poison quest?", null, 1);
  m.run("tg1", "assistant", "Stormwind, SI:7.", null, 1);
  m.run("tg1b", "user", '[{"type":"text","text":"and for horde?"}]', null, 1);
  m.run("tg1b", "tool", "searched wowhead\nmore", "web_search", 1);
  m.run("tg1b", "assistant", "Ravenholdt.", null, 1);
  m.run("tg1b", "assistant", "superseded draft", null, 0);
  w.close();

  const cat = hermesCatalog(() => {}, db, () => true); // bot sessions opted in (hermesBotSessions)

  it("lists people's conversations (bots included), hides internal/cron/sub-agent/hidden/empty ones", async () => {
    const list = await cat.listThreads({});
    expect(list.map((t) => t.nativeId)).toEqual(["tg1", "acp1", "cli1"]);
    const tg = list[0];
    expect(tg).toMatchObject({ agent: "hermes", origin: "telegram", cwd: "", title: "where is the poison quest?" });
    expect(tg.updatedAt).toBe((t0 + 900) * 1000); // its compression continuation is the latest activity
    expect(JSON.stringify(list)).not.toMatch(/Secret Name|12345/);
    expect(list.find((t) => t.nativeId === "cli1")).toMatchObject({ starred: true, cwd: "D:\src\X" });
    expect(cat.canResume!("acp1")).toBe(true);
    expect(cat.canResume!("tg1")).toBe(false);
  });

  it("reads a whole conversation across compression, active messages only", async () => {
    const h = await cat.readHistory!("tg1");
    expect(h).toEqual([
      { kind: "user", text: "where is the poison quest?" },
      { kind: "assistant", text: "Stormwind, SI:7." },
      { kind: "user", text: "and for horde?" },
      { kind: "tool", name: "web_search", summary: "searched wowhead", ok: true },
      { kind: "assistant", text: "Ravenholdt." },
    ]);
  });
});

describe("overlay follows a dragged or resized frame (cursor-driven)", () => {
  const layout = {
    scr: [1920, 1080],
    win: [100, 50, 700, 440],
    list: [114, 104, 230, 340], // left pane: stays left, stretches down
    detail: [350, 104, 436, 340], // main pane: stretches both ways
    status: [118, 450, 300, 22], // bottom bar text: sticks to the bottom, stretches across
    keys: { newClaude: [116, 78, 80, 22], native: [712, 78, 54, 22], send: [706, 450, 64, 22] },
    tracker: [1500, 300, 240, 150],
    occ: [[120, 60, 200, 100]],
  };
  it("moving follows the cursor, clamped to the screen; occluders and the tracker stay", async () => {
    const { dragLayout } = await import("../src/main/geometry");
    const d = { kind: "move" as const, target: "win" as const, c0: { x: 400, y: 60 } };
    const m = dragLayout(layout, d, 460, 30);
    expect(m.win).toEqual([160, 20, 700, 440]);
    expect(m.list).toEqual([174, 74, 230, 340]);
    expect(m.keys.send).toEqual([766, 420, 64, 22]);
    expect(m.tracker).toEqual(layout.tracker);
    expect(m.occ).toEqual(layout.occ);
    expect(dragLayout(layout, d, 400 - 500, 60 - 500).win).toEqual([0, 0, 700, 440]); // clamped
  });
  it("resizing stretches big panes, keeps small things on their edge, respects the limits", async () => {
    const { dragLayout } = await import("../src/main/geometry");
    const d = { kind: "size" as const, target: "win" as const, c0: { x: 800, y: 490 }, min: [560, 340] as [number, number], max: [1600, 1100] as [number, number] };
    const m = dragLayout(layout, d, 900, 550); // +100 wide, +60 tall
    expect(m.win).toEqual([100, 50, 800, 500]);
    expect(m.list).toEqual([114, 104, 230, 400]);
    expect(m.detail).toEqual([350, 104, 536, 400]);
    expect(m.status).toEqual([118, 510, 400, 22]);
    expect(m.keys.newClaude).toEqual([116, 78, 80, 22]); // top-left toolbar: unchanged
    expect(m.keys.native).toEqual([812, 78, 54, 22]); // top-right toolbar: follows the right edge
    expect(m.keys.send).toEqual([806, 510, 64, 22]); // bottom-right action bar: follows both
    expect(dragLayout(layout, d, 0, 0).win).toEqual([100, 50, 560, 340]); // minimum size
  });
  it("the tracker moves and resizes on its own", async () => {
    const { dragLayout } = await import("../src/main/geometry");
    expect(dragLayout(layout, { kind: "move", target: "tracker", c0: { x: 0, y: 0 } }, -20, 10).tracker).toEqual([1480, 310, 240, 150]);
    expect(dragLayout(layout, { kind: "size", target: "tracker", c0: { x: 0, y: 0 } }, 60, 50).tracker).toEqual([1500, 300, 300, 200]);
  });
});

describe("where a press starts a window drag (before dragstart arrives)", () => {
  const layout = {
    scr: [1920, 1080],
    fpx: 1,
    win: [100, 50, 700, 440],
    list: [114, 104, 230, 340],
    detail: [350, 104, 436, 230],
    status: [184, 454, 300, 22],
    keys: { approve: [500, 454, 72, 22] },
  };
  it("frame moves, grip resizes, panes/composer/toolbar/bottom bar/close button don't", async () => {
    const { dragZone } = await import("../src/main/geometry");
    expect(dragZone(layout, 400, 60)).toMatchObject({ kind: "move", target: "win" }); // title area
    expect(dragZone(layout, 104, 300)).toMatchObject({ kind: "move" }); // left border
    expect(dragZone(layout, 795, 485)).toMatchObject({ kind: "size", min: [560, 340] }); // grip
    expect(dragZone({ ...layout, focus: true }, 795, 485)).toMatchObject({ kind: "size", min: [324, 300] }); // matches native focus bounds
    expect(dragZone(layout, 200, 200)).toBeNull(); // quest log pane
    expect(dragZone(layout, 500, 200)).toBeNull(); // detail pane
    expect(dragZone(layout, 500, 380)).toBeNull(); // composer
    expect(dragZone(layout, 200, 90)).toBeNull(); // toolbar row
    expect(dragZone(layout, 300, 470)).toBeNull(); // bottom bar
    expect(dragZone(layout, 790, 55)).toBeNull(); // close button
    expect(dragZone(layout, 50, 60)).toBeNull(); // outside the window
  });
});

describe("predicting the Log button", () => {
  const open = {
    scr: [1920, 1080],
    win: [100, 50, 700, 440],
    list: [114, 104, 230, 340],
    detail: [350, 104, 436, 340],
    status: [118, 450, 300, 22],
  };
  it("collapsing drops the log and keeps the quest where it is; expanding restores it exactly", async () => {
    const { logLayout, rememberLog } = await import("../src/main/geometry");
    const memo = rememberLog(open)!;
    expect(memo).toEqual({ dx: 14, dy: 54, w: 230, bottom: 46, gap: 6 });
    const shut = logLayout(open, true, [336, 50, 464, 440], memo);
    expect(shut.win).toEqual([336, 50, 464, 440]);
    expect(shut.list).toBeUndefined();
    expect(shut.detail).toEqual([350, 104, 436, 340]); // same place on screen
    expect(shut.status).toEqual([354, 450, 64, 22]);
    expect(rememberLog(shut)).toBeUndefined(); // the memo of the open log is kept
    const back = logLayout(shut, false, [100, 50, 700, 440], memo);
    expect(back).toEqual(open);
  });
  it("expanding without a memo widens the detail pane; a bad rect changes nothing", async () => {
    const { logLayout } = await import("../src/main/geometry");
    const shut = { ...open, win: [336, 50, 464, 440], list: undefined, detail: [350, 104, 436, 340] };
    expect(logLayout(shut, false, [100, 50, 700, 440]).detail).toEqual([114, 104, 672, 340]);
    expect(logLayout(open, true, [1, 2])).toBe(open);
  });
});

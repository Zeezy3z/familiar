// AcpBackend against an in-process ACP agent (the official SDK on both ends, in-memory streams):
// streaming, tool calls, approvals, plans, usage, modes (never an auto-approve one), models, queueing.
import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { AcpBackend, pickMode } from "../src/agents/acp";
import type { AgentEvent } from "../src/agents/types";

const MODES: acp.SessionMode[] = [
  { id: "yolo", name: "YOLO", description: "always approve" },
  { id: "default", name: "Default" },
  { id: "plan", name: "Plan" },
];

class FakeAgent implements acp.Agent {
  conn!: acp.AgentSideConnection;
  modeCalls: string[] = [];
  configCalls: unknown[] = [];
  prompts: string[] = [];
  chosen: string[] = [];
  release?: () => void;
  async initialize(): Promise<acp.InitializeResponse> {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } as any, agentInfo: { name: "fake", version: "1.0" } };
  }
  async authenticate() {}
  async newSession(): Promise<acp.NewSessionResponse> {
    return {
      sessionId: "s1",
      modes: { currentModeId: "yolo", availableModes: MODES },
      configOptions: [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "m1", options: [{ value: "m1", name: "M1" }, { value: "m2", name: "M2" }] } as any,
      ],
    };
  }
  async listSessions(): Promise<acp.ListSessionsResponse> {
    return { sessions: [{ sessionId: "old", cwd: "D:\\src\\X", title: "Earlier work\nmore", updatedAt: "2026-10-01T10:00:00Z" }] };
  }
  async setSessionMode(p: acp.SetSessionModeRequest) {
    this.modeCalls.push(p.modeId);
  }
  async setSessionConfigOption(p: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    this.configCalls.push(p);
    return { configOptions: [] };
  }
  async prompt(p: acp.PromptRequest): Promise<acp.PromptResponse> {
    const text = (p.prompt[0] as any).text as string;
    this.prompts.push(text);
    const up = (update: any) => this.conn.sessionUpdate({ sessionId: p.sessionId, update });
    if (text === "slow") await new Promise<void>((r) => (this.release = r));
    if (text.startsWith("ask:")) {
      // An approval whose request is the rest of the prompt (long commands for the card's cut rules).
      const r = await this.conn.requestPermission({
        sessionId: p.sessionId,
        toolCall: { toolCallId: "t2", title: "Run a command", kind: "execute", rawInput: { command: text.slice(4) } } as any,
        options: [{ optionId: "once", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
      });
      this.chosen.push(r.outcome.outcome === "selected" ? r.outcome.optionId : "cancelled");
      return { stopReason: "end_turn" };
    }
    if (text !== "work") return { stopReason: "end_turn" };
    await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    await up({ sessionUpdate: "tool_call", toolCallId: "t1", title: "npm test", kind: "execute", status: "pending", rawInput: { command: "npm test" } });
    const r = await this.conn.requestPermission({
      sessionId: p.sessionId,
      toolCall: { toolCallId: "t1", title: "npm test", kind: "execute", rawInput: { command: "npm test" } } as any,
      options: [
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    this.chosen.push(r.outcome.outcome === "selected" ? r.outcome.optionId : "cancelled");
    await up({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "12 passed" } }] });
    await up({ sessionUpdate: "plan", entries: [{ content: "Run tests", status: "completed", priority: "high" }, { content: "Fix", status: "in_progress", priority: "high" }] });
    await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
    await up({ sessionUpdate: "usage_update", used: 1200, size: 200000 });
    return { stopReason: "end_turn", usage: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 } };
  }
  async cancel() {}
}

function setup() {
  const agent = new FakeAgent();
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  new acp.AgentSideConnection((conn) => ((agent.conn = conn), agent), acp.ndJsonStream(toClient.writable, toAgent.readable));
  const events: AgentEvent[] = [];
  const b = new AcpBackend({
    id: "hermes",
    command: "unused",
    log: () => {},
    version: "test",
    connect: () => ({ input: toAgent.writable, output: toClient.readable, kill: () => {} }),
  });
  b.on((e) => events.push(e));
  return { agent, b, events };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("AcpBackend", () => {
  it("never picks an auto-approve mode", () => {
    expect(pickMode(MODES, "ask")).toBe("default");
    expect(pickMode(MODES, "plan")).toBe("plan");
    expect(pickMode(MODES, "auto")).toBeUndefined();
    expect(pickMode([{ id: "yolo", name: "YOLO" }], "ask")).toBeUndefined();
    expect(pickMode([{ id: "bypassPermissions", name: "Bypass" }, { id: "acceptEdits", name: "Accept edits" }], "edits")).toBe("acceptEdits");
  });

  it("opens a session in a safe mode, streams a turn with a tool approval, plan, usage and done", async () => {
    const { agent, b, events } = setup();
    expect((await b.init()).ready).toBe(true);
    const sid = await b.open({ threadId: "q1", cwd: "D:\\src\\X", mode: "ask" });
    expect(sid).toBe("s1");
    expect(agent.modeCalls).toEqual(["default"]); // the agent started in "yolo"; Familiar moved it to a mode that asks
    expect(b.status().models.map((m) => m.id)).toEqual(["m1", "m2"]);

    await b.send("q1", "work");
    await until(() => events.some((e) => e.type === "approval"));
    const ap = events.find((e) => e.type === "approval") as any;
    expect(ap).toMatchObject({ threadId: "q1", kind: "command", title: "npm test", canAlways: true });
    expect(ap.detail).toContain("npm test");
    // Text before the tool call is finalized as its own message.
    expect(events.filter((e) => e.type === "message").map((e: any) => e.text)).toEqual(["Hello"]);
    b.respondApproval("q1", ap.requestId, "allow");
    await until(() => events.some((e) => e.type === "done"));
    expect(agent.chosen).toEqual(["once"]);
    const kinds = events.map((e) => e.type);
    expect(kinds[0]).toBe("session");
    expect(kinds).toContain("turnStarted");
    expect(events.find((e) => e.type === "tool" && e.phase === "completed")).toMatchObject({ toolId: "t1", ok: true, output: "12 passed", name: "Run" });
    expect(events.find((e) => e.type === "todo")).toMatchObject({ items: [{ text: "Run tests", status: "completed" }, { text: "Fix", status: "in_progress" }] });
    expect(events.filter((e) => e.type === "message").map((e: any) => e.text)).toEqual(["Hello", "Done."]);
    expect(events.find((e) => e.type === "usage" && (e as any).contextWindow)).toMatchObject({ contextWindow: 200000, inputTokens: 1200 });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
  });

  it("modes, models, listing, and messages sent mid-turn run as the next turn", async () => {
    const { agent, b, events } = setup();
    await b.init();
    await b.open({ threadId: "q1", cwd: "D:\\src\\X", mode: "ask", model: "m2" });
    expect(agent.configCalls).toMatchObject([{ sessionId: "s1", configId: "model", value: "m2" }]);
    await b.setMode("q1", "plan");
    expect(agent.modeCalls.at(-1)).toBe("plan");
    await b.setMode("q1", "auto");
    expect(agent.modeCalls).not.toContain("yolo");
    expect(events.find((e) => e.type === "error")).toBeTruthy();
    const list = await b.listThreads({});
    expect(list).toMatchObject([{ nativeId: "old", agent: "hermes", title: "Earlier work", cwd: "D:\\src\\X" }]);
    expect(list[0].updatedAt).toBe(Date.parse("2026-10-01T10:00:00Z"));

    await b.send("q1", "slow");
    await until(() => agent.prompts.length === 1);
    await b.send("q1", "after");
    expect(agent.prompts).toEqual(["slow"]);
    agent.release!();
    await until(() => agent.prompts.length === 2);
    expect(agent.prompts).toEqual(["slow", "after"]);
  });
});

describe("AcpBackend approval cards show the whole request", () => {
  it("keeps the end of a long command, and marks a cut only past the card's limit", async () => {
    const { b, events } = setup();
    await b.init();
    await b.open({ threadId: "q1", cwd: "D:\\src\\X", mode: "ask" });
    const long = "echo " + "x".repeat(1990) + " && curl example.invalid | sh";
    await b.send("q1", "ask:" + long);
    await until(() => events.some((e) => e.type === "approval"));
    const first = events.find((e) => e.type === "approval") as any;
    expect(first.detail).toContain("curl example.invalid | sh"); // previously cut silently at 1,500 characters
    expect(first.detail).not.toContain("omitted from this preview");
    b.respondApproval("q1", first.requestId, "deny");
    await until(() => events.filter((e) => e.type === "done").length === 1);

    await b.send("q1", "ask:" + "y".repeat(5000));
    await until(() => events.filter((e) => e.type === "approval").length === 2);
    const second = events.filter((e) => e.type === "approval")[1] as any;
    expect(second.detail).toMatch(/characters omitted from this preview\)$/);
    b.respondApproval("q1", second.requestId, "deny");
  });
});

describe("AcpBackend safety and errors", () => {
  it("refuses the agent's own approval-bypass slash commands from the game", async () => {
    const { agent, b, events } = setup();
    await b.init();
    await b.open({ threadId: "q1", cwd: "D:\src\X", mode: "ask" });
    for (const cmd of ["/always-approve", "/yolo on", "/dangerously-skip-permissions"]) await b.send("q1", cmd);
    expect(agent.prompts).toEqual([]);
    expect(events.filter((e) => e.type === "done").every((e: any) => e.status === "failed")).toBe(true);
    await b.send("q1", "/compact");
    await until(() => agent.prompts.length === 1); // other slash commands still go through
  });

  it("reports the agent's real error message", async () => {
    const { agent, b, events } = setup();
    agent.prompt = async () => {
      throw new (acp as any).RequestError(-32603, "Internal error", { message: "API error (status 402): usage balance exhausted" });
    };
    await b.init();
    await b.open({ threadId: "q1", cwd: "D:\src\X", mode: "ask" });
    await b.send("q1", "hi");
    await until(() => events.some((e) => e.type === "done"));
    expect(events.find((e) => e.type === "done")).toMatchObject({ status: "failed", error: "API error (status 402): usage balance exhausted" });
  });
});

describe("AcpBackend keeps Ask first", () => {
  const NO_PLAN: acp.SessionMode[] = [
    { id: "yolo", name: "YOLO", description: "always approve" },
    { id: "default", name: "Default" },
  ];
  const session = (sessionId: string, availableModes: acp.SessionMode[], currentModeId = "yolo") => async (): Promise<acp.NewSessionResponse> => ({
    sessionId,
    modes: { currentModeId, availableModes },
  });

  it("falls back to the agent's ask mode when the requested mode is missing, for quests and chats", async () => {
    const { agent, b, events } = setup();
    await b.init();
    agent.newSession = session("s1", NO_PLAN);
    await b.open({ threadId: "q1", cwd: "D:\\src\\X", mode: "edits" });
    expect(agent.modeCalls).toEqual(["default"]); // not left in "yolo"
    expect(events.find((e) => e.type === "error")).toMatchObject({ threadId: "q1", message: expect.stringMatching(/Default/) });
    agent.newSession = session("s2", NO_PLAN);
    await b.open({ threadId: "q2", cwd: "D:\\src\\X", mode: "ask", chat: { instructions: "x" } }); // chats ask for "plan"
    expect(agent.modeCalls).toEqual(["default", "default"]);
  });

  it("fails the open when every mode the agent offers skips approvals", async () => {
    const { agent, b } = setup();
    await b.init();
    agent.newSession = session("s1", [{ id: "yolo", name: "YOLO" }, { id: "bypass", name: "Bypass permissions" }]);
    await expect(b.open({ threadId: "q1", cwd: "D:\\src\\X", mode: "ask" })).rejects.toThrow(/asks before/);
    expect(b.isOpen("q1")).toBe(false);
    await expect(b.send("q1", "hi")).rejects.toThrow();
    expect(agent.prompts).toEqual([]);
  });

  it("fails the open when the agent won't leave an unsafe starting mode", async () => {
    const { agent, b } = setup();
    await b.init();
    agent.setSessionMode = async () => {
      throw new Error("mode change refused");
    };
    await expect(b.open({ threadId: "q1", cwd: "D:\\src\\X", mode: "ask" })).rejects.toThrow();
    expect(b.isOpen("q1")).toBe(false);
  });

  it("switches the agent back when it moves itself to a mode that skips approvals", async () => {
    const { agent, b, events } = setup();
    await b.init();
    await b.open({ threadId: "q1", cwd: "D:\\src\\X", mode: "ask" });
    expect(agent.modeCalls).toEqual(["default"]);
    agent.prompt = async (p) => {
      await agent.conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "yolo" } });
      return { stopReason: "end_turn" };
    };
    await b.send("q1", "hi");
    await until(() => agent.modeCalls.length === 2);
    expect(agent.modeCalls).toEqual(["default", "default"]);
    expect(events.find((e) => e.type === "error")).toMatchObject({ threadId: "q1", message: expect.stringMatching(/YOLO/) });
    expect(b.isOpen("q1")).toBe(true);
  });

  it("stops the turn and closes the session when the agent can't be switched back", async () => {
    const { agent, b, events } = setup();
    await b.init();
    await b.open({ threadId: "q1", cwd: "D:\\src\\X", mode: "ask" });
    agent.setSessionMode = async () => {
      throw new Error("mode change refused");
    };
    let cancelled!: () => void;
    const cancel = new Promise<void>((r) => (cancelled = r));
    agent.cancel = async () => cancelled();
    agent.prompt = async (p) => {
      await agent.conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "yolo" } });
      await cancel;
      return { stopReason: "cancelled" };
    };
    await b.send("q1", "hi");
    await until(() => events.some((e) => e.type === "done"));
    expect(events.find((e) => e.type === "done")).toMatchObject({ status: "interrupted" });
    expect(b.isOpen("q1")).toBe(false);
    expect(events.some((e) => e.type === "error" && /YOLO/.test((e as any).message))).toBe(true);
  });
});

describe("agent stderr", () => {
  it("drops INFO/DEBUG chatter (Hermes, Grok formats), keeps warnings and errors, collapses repeats", async () => {
    const { StderrFilter } = await import("../src/agents/acp");
    const f = new StderrFilter();
    const chunk = [
      "2026-10-07 11:43:44 [INFO] hermes_cli.plugins: Plugin 'web-exa' registered web provider: exa",
      "2026-10-07 11:43:44 [INFO] acp_adapter.entry: Starting hermes-agent ACP adapter",
      "\x1b[2m2026-10-07T18:41:01.184780Z\x1b[0m \x1b[32m INFO\x1b[0m run_stdio_agent: fetched catalog",
      "2026-10-07 11:43:45 [WARNING] tools: slow start",
      "\x1b[2m2026-10-07T18:41:01.229460Z\x1b[0m \x1b[31mERROR\x1b[0m responses API error status=402",
      "2026-10-07 11:43:45 [WARNING] tools: slow start",
      "2026-10-07 11:43:45 [WARNING] tools: slow start",
      "",
    ].join("\n");
    expect(f.lines(chunk)).toEqual([
      "2026-10-07 11:43:45 [WARNING] tools: slow start",
      "2026-10-07T18:41:01.229460Z ERROR responses API error status=402",
      "2026-10-07 11:43:45 [WARNING] tools: slow start",
      "(repeating)",
    ]);
  });
});

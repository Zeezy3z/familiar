// Safety defaults that no journey reaches without Electron or a real agent: what a quest loads from
// the player's own agent configuration, and that development switches are dead in a distributed build.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { configOptions, ownEnv } from "../src/agents/claude";
import { DEFAULT_CONFIG } from "../src/hub/config";
import { DEV_ENV, devEnabled, distributed, stripDevEnv } from "../src/main/dev-hooks";

describe("agent configuration", () => {
  it("is not inherited by default: no settings files (allow rules, hooks) and no MCP servers but Familiar's own", () => {
    expect(DEFAULT_CONFIG.inheritAgentConfig).toBe(false);
    expect(configOptions(false)).toEqual({ settingSources: [], strictMcpConfig: true });
  });
  it("is loaded as the CLI would once the player switches it on", () => {
    expect(configOptions(true)).toEqual({ settingSources: ["user", "project", "local"] });
  });
});

describe("development switches in a distributed build", () => {
  /** A companion folder with dist/ in it, as the running bundle sees itself. */
  const companion = (prebuilt: boolean) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-safety-"));
    fs.mkdirSync(path.join(root, "dist"));
    if (prebuilt) fs.writeFileSync(path.join(root, ".prebuilt"), "version=0.0.0\n");
    return path.join(root, "dist");
  };

  it("a source checkout is not distributed; the release download (.prebuilt) and the installed app are", () => {
    expect(distributed(false, companion(false))).toBe(false);
    expect(distributed(false, companion(true))).toBe(true);
    expect(distributed(true, companion(false))).toBe(true);
  });

  it("FAMILIAR_DEV=1 turns the dev hooks on in a checkout and does nothing in the release download", () => {
    expect(devEnabled({ FAMILIAR_DEV: "1" }, companion(false))).toBe(true);
    expect(devEnabled({ FAMILIAR_DEV: "1" }, companion(true))).toBe(false);
  });

  it("a distributed build removes every development switch before anything reads it", () => {
    expect([...DEV_ENV]).toEqual(["FAMILIAR_DEV", "FAMILIAR_TARGET_TITLE", "FAMILIAR_CAPTURE"]);
    const env: NodeJS.ProcessEnv = { FAMILIAR_DEV: "1", FAMILIAR_TARGET_TITLE: "FakeWoW", FAMILIAR_CAPTURE: "screen", PATH: "kept" };
    stripDevEnv(env);
    expect(env).toEqual({ PATH: "kept" });
  });
});

it("Claude's environment drops a parent Claude session's variables, and only then", () => {
  const mine = { PATH: "p", ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "d", CLAUDE_CODE_USE_BEDROCK: "1" };
  expect(ownEnv(mine)).toEqual(mine);
  const nested = { ...mine, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1", CLAUDE_AGENT_SDK_MCP_NO_PREFIX: "1", CLAUDE_PID: "9" };
  expect(ownEnv(nested)).toEqual({ PATH: "p", ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "d" });
});

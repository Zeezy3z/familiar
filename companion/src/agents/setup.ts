// "Which agents do you want Familiar to use?" — detection for the control panel's onboarding.
// Familiar never installs agents by itself and never touches credentials: it checks whether each
// harness is installed and whether its own sign-in exists (file presence / env var only — never
// reading the contents), opens the vendor's install page, and starts the vendor's own login in a
// visible terminal. Everything stays on this PC; nothing is sent anywhere by Familiar.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findCodexExe } from "./codex";
import { hermesHome } from "./hermes";
import { AcpProviderConfig, DEFAULT_ACP_PROVIDERS, providerInfo } from "./providers";
import { resolveCommand } from "./which";

export interface ProviderSetup {
  id: string;
  label: string;
  glyph: string;
  installed: boolean;
  /** true / false, or undefined when Familiar can't tell (custom ACP agents). */
  signedIn?: boolean;
  /** "Use in Familiar". */
  enabled: boolean;
  /** One line: what's missing or how it signs in. */
  detail: string;
  installUrl?: string;
  /** Shown to copy; never run by Familiar. */
  installCommand?: string;
  canLogin: boolean;
}

interface Known {
  installUrl: string;
  installCommand?: string;
  installed(): string | null;
  signedIn(): boolean;
  how: string;
  /** Command line for the vendor's own sign-in (run in a visible terminal). */
  login(exe: string): string[] | null;
}

const home = os.homedir();
const exists = (...p: string[]) => fs.existsSync(path.join(...p));

const KNOWN: Record<string, Known> = {
  claude: {
    installUrl: "https://docs.claude.com/en/docs/claude-code/setup",
    // The Agent SDK ships its own Claude Code; the CLI is only needed to sign in.
    installed: () => resolveCommand("claude") ?? "sdk",
    signedIn: () => exists(home, ".claude", ".credentials.json") || !!process.env.ANTHROPIC_API_KEY,
    how: "Claude subscription (browser sign-in) or ANTHROPIC_API_KEY",
    login: (exe) => (exe === "sdk" ? null : [exe, "/login"]),
  },
  codex: {
    installUrl: "https://openai.com/codex/",
    installed: () => findCodexExe(),
    signedIn: () => exists(home, ".codex", "auth.json") || !!process.env.OPENAI_API_KEY,
    how: "ChatGPT account (browser sign-in) or OPENAI_API_KEY",
    login: (exe) => [exe, "login"],
  },
  hermes: {
    installUrl: "https://hermes-agent.nousresearch.com/",
    installed: () => resolveCommand("hermes"),
    signedIn: () => exists(hermesHome(), "auth.json") || exists(hermesHome(), ".env"),
    how: "Nous Portal, OpenRouter, Anthropic, OpenAI, xAI or a local model (set up in Hermes)",
    login: (exe) => [exe, "setup"],
  },
  grok: {
    installUrl: "https://x.ai/cli",
    installCommand: "winget install -e --id xAI.GrokBuild",
    installed: () => resolveCommand("grok"),
    signedIn: () => exists(process.env.GROK_HOME ?? path.join(home, ".grok"), "auth.json") || !!process.env.XAI_API_KEY,
    how: "Grok / SuperGrok account (browser sign-in) or XAI_API_KEY",
    login: (exe) => [exe, "login"],
  },
};

export function providerSetup(enabled: (id: string) => boolean, custom: Record<string, Partial<AcpProviderConfig>> = {}): ProviderSetup[] {
  const ids = [...new Set(["claude", "codex", ...Object.keys(DEFAULT_ACP_PROVIDERS), ...Object.keys(custom)])];
  return ids.map((id) => {
    const info = providerInfo(id);
    const k = KNOWN[id];
    if (!k) {
      const cmd = custom[id]?.command ?? "";
      const installed = !!resolveCommand(cmd);
      return {
        id,
        label: custom[id]?.label ?? info.label,
        glyph: custom[id]?.glyph ?? info.glyph,
        installed,
        enabled: installed && enabled(id),
        detail: installed ? `ACP agent: ${cmd} ${(custom[id]?.args ?? []).join(" ")}` : `${cmd || "(no command)"} not found on PATH`,
        canLogin: false,
      };
    }
    const exe = k.installed();
    const signedIn = !!exe && k.signedIn();
    return {
      id,
      label: info.label,
      glyph: info.glyph,
      installed: !!exe,
      signedIn,
      enabled: !!exe && enabled(id),
      detail: !exe ? "Not installed" : signedIn ? `Signed in · ${k.how}` : `Not signed in · ${k.how}`,
      installUrl: k.installUrl,
      installCommand: k.installCommand,
      canLogin: !!exe && !!k.login(exe),
    };
  });
}

/** Open the vendor's own sign-in in a terminal window the user can see and type into. */
export function startLogin(id: string): string {
  const k = KNOWN[id];
  const exe = k?.installed();
  const cmd = exe && k.login(exe);
  if (!cmd) throw new Error(`No sign-in command for ${providerInfo(id).label}`);
  const line = cmd.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
  const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "start", `"Sign in to ${providerInfo(id).label}"`, "cmd.exe", "/k", line], {
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  });
  child.unref();
  return line;
}

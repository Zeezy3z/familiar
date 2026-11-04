// Agent providers ("harnesses") Familiar can drive: the two built-in adapters (Claude Agent SDK,
// Codex app-server) and any number of Agent Client Protocol agents (Hermes, Grok Build, ...).
// The registry only carries presentation (label, glyph); behaviour lives in the backends.

export interface ProviderInfo {
  id: string;
  label: string;
  /** One character shown before quest titles (the Glass font has these; the WoW font doesn't). */
  glyph: string;
}

/** An Agent Client Protocol agent started as a child process speaking JSON-RPC over stdio. */
export interface AcpProviderConfig {
  /** false switches it off; otherwise it is used when `command` can be found. */
  enabled?: boolean;
  label?: string;
  glyph?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

const BUILTIN: Record<string, ProviderInfo> = {
  claude: { id: "claude", label: "Claude", glyph: "✦" },
  codex: { id: "codex", label: "Codex", glyph: "◈" },
  hermes: { id: "hermes", label: "Hermes", glyph: "☿" },
  grok: { id: "grok", label: "Grok", glyph: "✶" },
  // The tutorial quest's speaker (hub/tutorial.ts): not a backend, never started or listed as one.
  familiar: { id: "familiar", label: "Familiar", glyph: "◆" },
};

/** ACP agents Familiar knows how to start. User entries in config.json `providers` override or add. */
export const DEFAULT_ACP_PROVIDERS: Record<string, AcpProviderConfig> = {
  hermes: { command: "hermes", args: ["acp"] },
  grok: { command: "grok", args: ["agent", "stdio"] },
};

const registry = new Map<string, ProviderInfo>(Object.entries(BUILTIN));

export function registerProvider(p: ProviderInfo) {
  registry.set(p.id, p);
}

export function providerInfo(id: string): ProviderInfo {
  return registry.get(id) ?? { id, label: id.charAt(0).toUpperCase() + id.slice(1), glyph: "◇" };
}

export function providerLabel(id: string): string {
  return providerInfo(id).label;
}

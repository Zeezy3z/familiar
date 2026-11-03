// Presentation only: derive guidance from the existing status snapshot, never change settings.
import type { ProviderSetup } from "../agents/setup";

export interface JourneyStatus {
  linked?: boolean;
  install?: unknown;
  game?: { minimized?: boolean; foreground?: boolean } | null;
  layout?: { panel?: boolean; ui?: boolean } | null;
  overlay?: { paused?: boolean; shown?: boolean };
  capture?: { error?: string };
  providers?: ProviderSetup[];
  backends?: Record<string, { ready?: boolean; error?: string }>;
  chat?: { agent?: string };
}

export function journey(s: JourneyStatus) {
  const enabled = (s.providers ?? []).filter(p => p.enabled && p.installed);
  const ready = enabled.some(p => s.backends?.[p.id]?.ready);
  const prepared = enabled.some(p => p.signedIn === true || s.backends?.[p.id]?.ready);
  const unknownSignIn = enabled.some(p => p.signedIn == null && !s.backends?.[p.id]?.error);
  const starters = enabled.filter(p => (p.id === "claude" || p.id === "codex") && s.backends?.[p.id]?.ready);
  const firstReady = enabled.find(p => s.backends?.[p.id]?.ready);
  const startHint = starters.length ? `Choose ${starters.map(p => `+ ${p.label}`).join(" / ")} and a project.` : firstReady ? `Use /fam ${firstReady.id} <message> to start a quest in the current zone.` : "";
  const readyLabels = enabled.filter(p => s.backends?.[p.id]?.ready).map(p => p.label).filter(Boolean);
  const readyText = readyLabels.length === 1 ? `An agent is ready (${readyLabels[0]})` : readyLabels.length > 1 ? `Agents are ready (${readyLabels.join(", ")})` : "An agent is ready";
  const chatReady = enabled.some(p => p.id === s.chat?.agent && (p.id === "claude" || p.id === "codex") && s.backends?.[p.id]?.ready);
  const steps = [
    { label: "Choose a familiar", done: prepared || unknownSignIn, text: ready ? readyText : prepared ? "Sign-in found; agents start with WoW" : unknownSignIn ? "Installed; sign-in is not yet verified" : "Enable an agent and check its sign-in below" },
    { label: "Open WoW", done: !!s.game, text: s.game ? "Game window found" : "Use Windowed or Windowed (Fullscreen)" },
    { label: "Meet in game", done: !!s.linked, text: s.linked ? "Runestrip linked" : "Restart WoW, tick Familiar and Familiar Sync at character select (Load out of date AddOns), then press Enter and type /fam" },
  ];
  const guide = (title: string, text: string, level: "ok" | "warn" | "muted", action?: "providers" | "config" | "pause") => ({ title, text, level, action, steps });
  if (s.overlay?.paused) return guide("The Glass is paused", "Resume the overlay to see live replies again. Your conversations are kept.", "warn", "pause");
  if (!enabled.length) return guide("Choose your familiar", "Use an installed agent below. You can add more familiars whenever you like.", "warn", "providers");
  if (!prepared && !ready && !unknownSignIn) return guide("Check your familiar’s sign-in", "Use Sign in below, or complete setup in the agent’s own tool. A saved sign-in is checked again when the agent starts.", "warn", "providers");
  if (!s.install && !s.linked) return guide("Find your WoW installation", "Open config and check wowRoot and wowFlavor. Then Reload config and choose Reinstall addon in Link details below. Restart WoW once after first installation.", "warn", "config");
  if (!s.game) return guide("Your familiars are waiting for WoW", "Open WoW in Windowed or Windowed (Fullscreen). Familiar stays in the tray while you’re away; agents start when WoW opens.", "muted");
  if (s.game.minimized || s.game.foreground === false) return guide("Return to your WoW window", "The Glass waits while WoW is minimized or in the background. Return to the game when you’re ready.", "muted");
  if (s.capture?.error) return guide("The Runestrip needs attention", "Capture reported an error. Check the link details below, keep WoW visible, and make sure its coloured strip is uncovered.", "warn");
  if (!s.linked) return guide("Looking for the game link", "The coloured dots top-left are how Familiar talks to your PC. Enable Familiar in AddOns and type /fam. Restart WoW once after first installation. If the dots are covered, /fam strip tr moves them to the top-right.", "warn");
  if (!ready) return guide("Linked; waiting for a familiar", "The game link is working. Check the agent status below before sending a message.", "warn", "providers");
  if (s.layout?.ui === false) return guide("Your game UI is hidden", "Show the game UI again when you want to read Familiar’s live replies.", "muted");
  if (!s.layout?.panel) return guide("Your familiars are ready", `Type /fam or click the minimap imp to open your Quest Log. Pick an existing conversation to continue.${chatReady ? " Use + Chat for a quick question." : " " + startHint}`, "ok");
  return guide("Linked. Your next quest awaits.", `Pick a conversation to continue. ${startHint} Enter sends; Shift+Enter adds a line. Approvals appear in the conversation.`, "ok");
}

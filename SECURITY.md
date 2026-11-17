# Security policy

Report vulnerabilities privately through GitHub's private vulnerability reporting: **Security →
Report a vulnerability** on this repository
(https://github.com/Zeezy3z/familiar/security/advisories/new). Do not open a public issue for
anything exploitable. Expect an acknowledgement within 7 days.

Supported version: `main` and the latest release tag. Familiar sends no telemetry and has no
server.

## Trust model

Anything that runs Lua in the player's WoW client (another addon, an imported string, a macro) can
draw the Runestrip and call `/fam`. Familiar treats every message from the game as a request, never
as authority:

* **Approval authority is the Windows app's** (`companion/src/main/physical.ts`). An approval from
  the game counts only for a request card the Glass itself painted and reported (`painted`), that
  has stayed unchanged in place for 800 ms with the game in front and has been read to its end, and
  only on a real press and release of the Approve key registered in the control panel, or, when the
  player turned on **Approve by mouse click** (`approveByClick`, off by default), a real mouse
  release inside that painted button. Each proof names one action for one request and is used once.
  Rectangles and claims sent by the addon are never used to approve.
* The game can never change a quest's mode or grant **Always**; both are set only in the control
  panel. The game may change sounds and turn privacy on, never off; no other setting.
* Quests do not load the player's own agent configuration (allow rules, hooks, MCP servers) unless
  **Use my existing agent configuration** (`inheritAgentConfig`) is on.
* A folder typed in game must be under a configured project root, a project, or a known zone.
* No path from the game or the control panel reaches bypass-permissions / danger-full-access / yolo
  modes. Deny and Stop need no proof.

## In scope

* **The in-game trust boundary.** Anything that lets the game, a Runestrip frame, a saved variable,
  `FamiliarSync`, another window or an agent's output get past the rules above: an approval
  without a real press of the registered key (or, with click approval on, a real click on the
  Glass's own button), one proof approving more than one request, an approval for a card the player
  could not have read, **Always** or a mode change from the game, a setting changed from the game
  beyond the list above, the player's agent configuration loaded with the switch off (Claude), a
  typed folder outside the allowed set, a request card shortened so its tail is hidden, `/fam`
  input reaching an agent with a different meaning than typed.
* **Electron IPC.** The preloads (`companion/src/main/preload-overlay.ts`, `preload-capture.ts`,
  `preload-control.ts`), renderer → main message validation (including `painted`),
  `shell.openExternal` targets, sanitisation of agent output on the Glass, the dev hooks on
  127.0.0.1:47810/47811 (token, Origin/Host checks, off in distributed builds).
* **The Runestrip decoder and codec** (`companion/src/link/`): crafted pixel input that crashes,
  hangs or desynchronises Familiar, CRC bypass, message injection by another window drawing in the
  capture region.
* **Agent adapters** (`companion/src/agents/`): any path where Familiar reads, copies or stores
  agent credentials; environment sanitisation (`*YOLO*` stripping); ACP mode negotiation; the
  Wowhead tool fetching anything other than one Wowhead Classic NPC, object or quest page.
* Supply chain: `package-lock.json`, `scripts/build.mjs`, the GitHub workflows.

## Known limits (not vulnerabilities by themselves)

* **Another addon can start a quest or send it a message without the player's input.** In Accept
  edits or Auto that quest can act without consent. In Ask first it still needs the player's
  approval to change anything.
* **Zones organise work; they do not contain an agent.** A familiar runs with the player's access on
  the PC. Ask first and the request cards are the control, not the folder.
* **A hostile addon can still draw misleading UI** in the game (fake text, a fake card in its own
  frames) and can deny, stop and archive, within the budgets in the README. It cannot press the
  player's Approve key, and Familiar approves nothing on its word.
* **Click approval is weaker than the key.** With `approveByClick` on, something in the game could
  arrange for a real request to sit where the player is about to click. The card must still have
  settled and been read to its end, and the pointer must have entered the button after that.
* **Some clicks work with click approval off.** Answers to an agent's question and confirming a
  desktop conversation are clicks on the Glass's own buttons, with the same proof, because they have
  no key alternative.
* **Agent isolation is partial.** With **Use my existing agent configuration** off, Claude loads no
  settings files or MCP servers. Codex and ACP agents still load their own configuration files:
  Familiar switches only Codex's plugins and apps off per quest.
* Reports that cross the rules in the trust model (approving without the real key or click, mode
  escalation, bypass modes, hidden card content) are in scope.

## Out of scope

* Blizzard's client, servers or anti-cheat; the behaviour of Claude Code, Codex, Hermes or Grok
  themselves (report to their vendors); social engineering of the player into approving a command.
* Anything requiring local admin or a modified build.

# Security policy

Report vulnerabilities privately through GitHub's private vulnerability reporting: **Security →
Report a vulnerability** on this repository
(https://github.com/Zeezy3z/familiar/security/advisories/new). Do not open a public issue for
anything exploitable. Expect an acknowledgement within 7 days.

Supported version: `main` and the latest release tag. Familiar sends no telemetry and has no
server.

## In scope

* **The in-game trust boundary.** Anything that lets text shown in the game, a Runestrip frame, a
  saved variable or an agent's output escalate past what the README documents: a quest leaving
  Ask first without the player choosing it in the desktop control panel, any route from the game
  or the control panel to bypass-permissions / danger-full-access / yolo modes, approval cards
  truncated so the tail is hidden, `/fam` commands reaching an agent with a different meaning than
  typed.
* **Overlay / control panel IPC.** The Electron preload bridge (`companion/src/main/preload.ts`),
  `contextBridge` channels, `shell.openExternal` targets, renderer → main message validation,
  sanitisation of agent output in the overlay, the dev hooks on 127.0.0.1:47810/47811 (token,
  Origin/Host checks).
* **The Runestrip decoder and codec** (`companion/src/link/`): crafted pixel input that crashes,
  hangs or desynchronises the companion, CRC bypass, message injection by another window drawing
  in the capture region.
* **Agent adapters** (`companion/src/agents/`): any path where Familiar reads, copies or stores
  agent credentials; environment sanitisation (`*YOLO*` stripping); ACP mode negotiation.
* Supply chain: `package-lock.json`, `scripts/build.mjs`, the GitHub workflows.

## Known and documented (not a vulnerability by itself)

Other addons running in the same WoW client can send messages and press Deny/Stop; they cannot
approve without your real mouse click or key press on the PC, which Approve/Always are matched to (README,
"What can talk to your agents"). Reports that show this crossing the limits above (approving
without a real click or key, mode escalation, bypass modes, hidden card content) are in scope.

## Out of scope

* Blizzard's client, servers or anti-cheat; the behaviour of Claude Code, Codex, Hermes or Grok
  themselves (report to their vendors); social engineering of the player into approving a command.
* Anything requiring local admin or a modified build.

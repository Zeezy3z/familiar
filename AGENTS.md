# AGENTS.md — Familiar

Familiar lets a player talk to their own coding agents (Claude Code, Codex, any ACP agent) from
inside World of Warcraft: Forever. This file is the contract for human contributors and coding
agents alike. Read `docs/design.md` (architecture) and `docs/protocol.md` (Runestrip wire format)
first. Words: quest (a conversation), zone (a project folder), familiar (an agent), Runestrip (the
colour strip), Glass (the overlay), Familiar (the Windows app).

## Hard rules

* **Zero input automation.** Never send keystrokes, mouse input, window messages or focus changes
  to the game, never read game memory, never route anything through Blizzard's servers. The addon
  only draws; the companion only reads the game window's pixels and draws its own click-through
  window. Changes that cross this line are out of scope regardless of who asks.
* The addon targets the **Mainline/retail API family** (`## Interface: 16001, 16002, 16003`), Lua
  5.1. Every widget method and global it uses must exist in WoW: Forever —
  `companion/test/addon.test.ts` enforces it against `test/fixtures/wow-api.json`.
* **Codec parity.** `addon/Familiar/Link.lua` and `companion/src/link/codec.ts` implement the same
  protocol; change both together and keep `companion/test/codec.test.ts` (Lua↔TS parity) green.
* Project discovery never offers a folder matched by `exclude` in `%APPDATA%\Familiar\config.json`
  or containing an empty `.nofamiliar` file; keep defaults generic (`DEFAULT_CONFIG` in
  `companion/src/hub/config.ts`).
* **Ask first, and no bypass path.** Quests start in Ask first unless the player chose another
  default in the control panel. The game can never change a quest's mode or grant Always: modes
  (default and the open quest's) and **Always** are set only in the control panel. Never add a path
  from the game UI or the control panel to bypass-permissions / danger-full-access / yolo modes.
  Approvals reach the player: ACP sessions are kept in a mode that asks (or not opened), Codex
  approvals never go to its reviewer subagent outside Auto, and a pending approval card is never
  shortened.
* **Approval authority is main's.** A decision from the game that grants something (Approve, option
  answers, Continue, Retry, Copy) needs main's proof for exactly that action
  (`companion/src/main/physical.ts`, read-only `GetAsyncKeyState`/`GetCursorPos`): a card the Glass
  painted and reported (`painted`), settled and read to its end, and a fresh press of the registered
  Approve key or, only with `approveByClick` on (default off), a real release inside that painted
  button. One proof, one action, used once. Never approve from rectangles or claims the addon sends,
  and never add an uncorroborated path; Deny and Stop are the only decisions that need none.
* **The game may change almost nothing.** Settings from the game go through `Hub.settings(…,
  "game")`: sounds, and privacy or start-with-Windows only towards on (`FROM_GAME`). `approveByClick`,
  `inheritAgentConfig`, modes and the Approve key are the PC's. Folders typed in game must be under a
  configured root, a project or a known zone.
* **Quests do not inherit the player's agent configuration** (allow rules, hooks, MCP servers)
  unless `inheritAgentConfig` is on (default off). Claude still gets the project's `CLAUDE.md` as
  plain text. Codex gets plugins and apps off per quest; its `config.toml` MCP servers and rules are
  outside Familiar's reach, so do not claim more.
* **`FamiliarSync` holds a timestamp and status only** (no transcript, no titles); it sits in the WoW
  folder where any addon can read it.
* **If you are running inside Familiar** (a quest started or continued from WoW), you are a child of
  the companion process: never kill `electron.exe`, run `scripts/dev-restart.sh`, or restart the
  companion yourself — that ends your own turn. Finish the change, run the tests, and ask the user
  to restart Familiar from the tray (addon-only changes just need `/reload` in game).

## Layout

* `addon/Familiar/` — the addon (linked into the WoW AddOns folder by the companion).
* `companion/src/link` — codec + decoder; `capture/` — WGC capture renderer; `hub/` — state machine
  and render model; `agents/` — Claude Agent SDK, Codex app-server and ACP adapters; `overlay/` —
  Glass; `control/` — desktop control panel; `main/` — Electron main, Win32 (koffi), approval
  authority (`physical.ts`), WoW install and `FamiliarSync`; `shared/` — words, cues and types used by
  more than one side; `fakewow/` — stand-in game window for end-to-end tests.

## Commands (from `companion/`)

* `npm ci --ignore-scripts --no-audit --no-fund` — clean install from the lockfile (Node 24+).
* `npm test` — codec parity, decoder robustness, headless addon + API conformance, hub journeys,
  approval authority, render model, safety defaults.
* `npm run typecheck`
* `npm run build` (`node scripts/build.mjs`) — bundle to `dist/`.
* `scripts/dev-restart.sh --fake` then `node scripts/e2e.mjs [--agents]` — live pipeline tests over
  real pixels (FakeWoW). Dev hooks listen on 127.0.0.1:47810/47811 only with `FAMILIAR_DEV=1` in a
  source checkout (never in the installed app or the release ZIP) and answer only requests with
  header `x-familiar-dev-token` set to the run's token
  (`%TEMP%\familiar-dev-<port>.token`); requests with an Origin header or another Host are refused.
* `node scripts/extract-wow-api.mjs <wow-ui-source@forever>` — refresh `test/fixtures/wow-api.json`.

Run typecheck and tests locally before pushing; see `docs/ci.md`.

## Tests

* Journey/E2E tests first; unit tests only for pure kernels no journey can reach.
* Never edit an expected result or doctor a fixture to make a test pass. If a requested change
  deliberately alters behaviour, list each old → new expectation in the PR under
  "Deliberate test changes".
* One home per rule: extend an existing helper or constant before adding one.

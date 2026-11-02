# AGENTS.md — Familiar

Familiar lets a player talk to their own coding agents (Claude Code, Codex, any ACP agent) from
inside World of Warcraft: Forever. This file is the contract for human contributors and coding
agents alike. Read `docs/design.md` (architecture) and `docs/protocol.md` (Runestrip wire format)
first.

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
* **Ask first, and no bypass path.** Quests started from the game default to Ask first. The in-game
  Mode button only cycles Ask first ↔ Plan only; Accept edits and Auto are chosen only in the
  desktop control panel. Never add a path from the game UI or the control panel to
  bypass-permissions / danger-full-access / yolo modes. Approvals reach the player: ACP sessions are
  kept in a mode that asks (or not opened), Codex approvals never go to its reviewer subagent outside
  Auto, and a pending approval card is never shortened.
* **If you are running inside Familiar** (a quest started or continued from WoW), you are a child of
  the companion process: never kill `electron.exe`, run `scripts/dev-restart.sh`, or restart the
  companion yourself — that ends your own turn. Finish the change, run the tests, and ask the user
  to restart Familiar from the tray (addon-only changes just need `/reload` in game).

## Layout

* `addon/Familiar/` — the addon (linked into the WoW AddOns folder by the companion).
* `companion/src/link` — codec + decoder; `capture/` — WGC capture renderer; `hub/` — state machine
  and render model; `agents/` — Claude Agent SDK, Codex app-server and ACP adapters; `overlay/` —
  Glass; `control/` — desktop control panel; `main/` — Electron main, Win32 (koffi), WoW
  install/snapshot; `fakewow/` — stand-in game window for end-to-end tests.

## Commands (from `companion/`)

* `npm ci --ignore-scripts --no-audit --no-fund` — clean install from the lockfile (Node 24+).
* `npm test` — codec parity, decoder robustness, headless addon + API conformance, hub journeys.
* `npm run typecheck`
* `npm run build` (`node scripts/build.mjs`) — bundle to `dist/`.
* `scripts/dev-restart.sh --fake` then `node scripts/e2e.mjs [--agents]` — live pipeline tests over
  real pixels (FakeWoW). Dev hooks listen on 127.0.0.1:47810/47811 only with `FAMILIAR_DEV=1` and
  answer only requests with header `x-familiar-dev-token` set to the run's token
  (`%TEMP%\familiar-dev-<port>.token`); requests with an Origin header or another Host are refused.
* `node scripts/extract-wow-api.mjs <wow-ui-source@forever>` — refresh `test/fixtures/wow-api.json`.

Run typecheck and tests locally before pushing; see `docs/ci.md`.

## Tests

* Journey/E2E tests first; unit tests only for pure kernels no journey can reach.
* Never edit an expected result or doctor a fixture to make a test pass. If a requested change
  deliberately alters behaviour, list each old → new expectation in the PR under
  "Deliberate test changes".
* One home per rule: extend an existing helper or constant before adding one.

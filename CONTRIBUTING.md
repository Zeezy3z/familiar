# Contributing to Familiar

Thanks for helping. Read [AGENTS.md](AGENTS.md) first: it is the contract for humans and coding
agents alike.

## Dev setup

Windows 11, Node 24 (matches CI). A WoW: Forever client is needed only for in-game checks, not for
the test suite.

```sh
cd companion
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test                 # codec parity, decoder robustness, headless addon + API conformance, hub journeys
npm run build            # bundle to dist/
scripts/dev-restart.sh --fake && node scripts/e2e.mjs [--agents]   # live pipeline over real pixels (FakeWoW)
```

Dev hooks listen on 127.0.0.1 only, only with `FAMILIAR_DEV=1`, and only answer the per-run
token; do not weaken that. Run typecheck and tests locally before pushing (`docs/ci.md`).

## Hard boundaries (PRs that cross these are closed, whoever asks)

* **Zero input automation.** No keystrokes, mouse input, window messages or focus changes to the
  game; no reading game memory; nothing routed through Blizzard's servers. The addon only draws;
  the companion only reads the game window's pixels and draws its own click-through window.
* **Approvals stay with the player.** No PR that adds a bypass or auto-approve path from the game:
  nothing in the game UI or the control panel may reach bypass-permissions /
  danger-full-access / yolo modes, the in-game Mode button stays limited to Ask first ↔ Plan only,
  and a pending approval card is never shortened.
* **Codec parity.** `addon/Familiar/Link.lua` and `companion/src/link/codec.ts` implement the same
  protocol. Change both in the same PR and keep `companion/test/codec.test.ts` green.
* **API conformance.** Every widget method and global the addon uses must exist in WoW: Forever
  (`## Interface: 16001, 16002, 16003`); `companion/test/addon.test.ts` enforces it against
  `test/fixtures/wow-api.json`.
* **No telemetry, no credential handling.** Familiar never phones home and never reads, copies or
  stores agent credentials.

## How to contribute

1. Open an issue (bug, feature or suggestion) before large changes.
2. Journey/E2E test first; unit tests only for pure kernels the journeys cannot reach.
3. Never edit an expected result or doctor a fixture to make a test pass. If a change deliberately
   alters behaviour, list each old → new expectation in the PR under "Deliberate test changes".
4. One home per rule: extend an existing helper or constant before adding one.
5. Keep the PR body factual: what changed, why, how it was verified (local commands, in-game check).

Commits are squash-merged. By submitting a PR you agree your contribution is licensed under the
repository's MIT licence.

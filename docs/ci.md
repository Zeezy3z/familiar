# Local-first CI

The [Glass preview workflow](../.github/workflows/glass-preview.yml) is the executable source of
truth: one fast test/build/renderer job on pull requests and on pushes to `main`. Validate locally
first; do not use repeated pushes as a test loop.

## Before a push

Use Node 24 (matches CI). From `companion/`, on the final candidate:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

The clean install follows the lockfile and skips install hooks; repeat it when the lockfile or
toolchain changes. Focused tests are for diagnosis, not a replacement for the full suite. Check
`git diff --check` from the repository root. Keep addon API conformance, Lua/TypeScript codec
parity and the journey tests; remove a test only with a concrete obsolete/duplicate rationale and
retained coverage. List deliberate expectation changes in the PR (see `AGENTS.md`). If a local
check cannot run, say so in the PR.

If you changed what ships in the release download (`Run Familiar.cmd`, `boot.cjs`,
`self-test.cjs`, `scripts/prebuilt.mjs`, dependencies), commit, then also build and check it on
Windows: `node scripts/prebuilt.mjs build <scratch>\FamiliarApp-test-windows.zip` and
`node scripts/prebuilt.mjs check <same zip>`. The Windows verify workflow does the same on pull
requests and manual runs (not on pushes) and keeps the zip as an artifact for 3 days.

For documentation-only edits, check links and documented commands against their actual
definitions. The workflow does not run for ordinary docs changes; a filtered or absent check is
not a passing check.

## Diagnose before retrying

Read the first failing step and its logs for the exact commit. Distinguish an application failure
from a dependency, runner or browser-install failure. Reproduce application failures locally, fix
the cause and revalidate before pushing. Do not weaken assertions, update fixtures to turn a run
green, or retry a deterministic failure on the same SHA. For a diagnosed transient failure, rerun
the failed job only.

## What the evidence proves

- PR runs check out the PR head SHA; the push to `main` checks the integrated tree. A green PR
  head alone does not prove the merged tree.
- Local typecheck, tests and build catch cheap failures. For visual diagnosis, from `companion/`
  run `node scripts/build.mjs`, then `node scripts/preview.mjs`, and open
  `http://127.0.0.1:47812/control.html?scenario=setup` (also `waiting`, `searching`, `linked`,
  `paused`, `action-error`) or `overlay.html?scenario=running` (also `approval`, `finished`,
  `interrupted`, `desktop`, `long`, `external-long`, `quiet`). This is the real renderer with a
  synthetic in-memory bridge: no Electron main process, settings, credentials, game or agents.
- `scripts/preview-smoke.mjs` runs only on GitHub Actions; do not spoof `GITHUB_ACTIONS` to claim
  a local substitute. Its browser journeys exercise built renderers, hit testing and reading
  continuity.
- The prebuilt check's `--self-test` proves the extracted download loads koffi and has its bundle
  and addon, holds no Claude Agent SDK or Claude Code, downloads both from npm with
  `fetch-claude.cjs` (sha512 against the lockfile), then runs that `claude.exe` and imports that
  SDK, with no Node on PATH. It never starts the companion,
  so it says nothing about windows, the overlay or WoW, nor about SmartScreen or antivirus on a
  file downloaded with a browser.
- `docs/media/` holds the README's screenshots, rendered from the real overlay and control panel
  with sample data (`npm run media` from `companion/`, `scripts/render-media.mjs`, same
  `FAMILIAR_QA_MODULE` convention as the smoke). A person reviews and commits them; CI never
  commits output, but the smoke job runs the renderer and fails unless it produces every PNG, so
  it cannot rot. Regenerate them after a Glass or control-panel change. `test/readme-media.test.mjs`
  fails when the README points at a `docs/media` file that is not there, or shows an image
  without its "Rendered from the real … with sample data." caption.
- Hosted browser evidence does not establish native Windows/WGC/FakeWoW or live in-game
  behaviour. Keep those checks distinct. If you are running inside Familiar, the `AGENTS.md`
  restart prohibition applies.

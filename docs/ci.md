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

## The live pipeline on Windows (FakeWoW)

No hosted job runs this: it needs a desktop, WGC capture and a window in front. From `companion/`,
after `npm run build` (and `node node_modules/electron/install.js` once, since `npm ci
--ignore-scripts` leaves Electron's binary out):

```sh
scripts/dev-restart.sh --fake --profile <scratch>/fam-e2e   # FakeWoW + companion, dev hooks on
node scripts/e2e.mjs [--agents]
scripts/dev-restart.sh --stop --profile <scratch>/fam-e2e   # stops only what the script started
```

- `--profile` keeps the run off your own Familiar: `APPDATA`/`LOCALAPPDATA` and Chromium's user
  data under the folder (Electron ignores `%APPDATA%` for its own folder and single-instance
  lock), and a first-use `config.json` whose `wowRoot` is a fake `_forever_` there. Without it the
  run uses your `%APPDATA%\Familiar` and links the addon into the real WoW folder. Dev runs
  (`FAMILIAR_DEV=1`) never write the start-with-Windows entry either way.
- FakeWoW must be the foreground window when the companion starts and during the run: the Glass
  hides and ignores clicks otherwise, and `e2e.mjs` stops at its foreground check. Do not type
  while it is in front: FakeWoW turns keys into composer text and Enter sends it.
- `--agents` resumes a Claude quest from before a companion restart: start one in a zone outside
  `%TEMP%` (excluded by default), rerun `dev-restart.sh` without `--fake`, then `e2e.mjs --agents`.
- It proves capture → decoder → Hub → Glass on this PC's real pixels, and that synthetic clicks and
  keys are refused. It does not prove the addon's Lua in the real client, the window rects WoW
  reports, or a corroborated approve (the script's input is synthetic, so main refuses it).

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

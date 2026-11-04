# Releasing

A `v*` tag push runs [`release.yml`](../.github/workflows/release.yml), which packages the addon
with the [BigWigs packager](https://github.com/BigWigsMods/packager) (pinned by commit) and
publishes a GitHub release, then builds the prebuilt app zip on Windows and attaches it.
Configuration: [`.pkgmeta`](../.pkgmeta).

## Cut a release

1. Set the same version in `addon/Familiar/Familiar.toc` (`## Version: X.Y.Z`) and
   `companion/package.json` (`"version": "X.Y.Z"`). Plain numbers; no `beta` suffix.
2. Run the checks in [ci.md](ci.md), then commit and get it onto `main`. The pull request's
   Windows verify run uploads the app zip as an artifact (kept 3 days): try it on a PC without
   Node before tagging.
3. From `main`:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The workflow fails before publishing anything if the tag, the TOC and `package.json` disagree.
A tag push also runs the Windows verify workflow. A rerun of the same tag updates the existing
release in place. Open the release afterwards and check that all four files are there.

## What the release contains

* `Familiar-vX.Y.Z-forever.zip`: the addon. One root folder, `Familiar/`, holding `Familiar.toc`,
  the Lua/XML files and `LICENSE`. The workflow downloads it again and fails unless that holds.
* `release.json`: packager metadata (file name, flavor `forever`, Interface numbers) that addon
  managers read.
* `FamiliarApp-vX.Y.Z-windows.zip`: the app users download, prebuilt so it runs without Node or
  npm (about 150 MB, 355 MB unpacked). Root folder `Familiar/` with the repository layout, as
  `git archive` exports the tag, plus `companion/dist/`, the production `companion/node_modules/`
  and the stock Electron binary in `companion/node_modules/electron/dist/`. Dev tooling, source
  maps, type declarations, docs and Electron locales other than en-US are pruned. Anthropic's
  proprietary packages are left out: the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and
  its Claude Code binary (`@anthropic-ai/claude-agent-sdk-win32-x64`); the SDK's open-source
  dependencies stay. `Run Familiar.cmd` runs `companion/fetch-claude.cjs` with the bundled
  Electron as Node, which downloads the versions `package-lock.json` pins for this PC from
  `https://registry.npmjs.org` only (about 112 MB, 250 MB unpacked), checks each against the
  lockfile's sha512 `integrity`, and moves them to the usual `node_modules` paths only once both
  are checked. It returns at once when those versions are in place, so an upgrade extracted over
  an old folder gets the new ones; it never runs at login (`--background`), and a failed
  download only means Claude doesn't work until a later run succeeds: until then the Familiars
  card and any Claude quest say "Not downloaded yet — run Run Familiar.cmd again …"
  (`companion/src/agents/claude-download.ts`). The marker
  `companion/.prebuilt` (version and `package-lock.json` hash) makes `Run Familiar.cmd` skip Node,
  npm and the build, and keeps `boot.cjs` from ever rebuilding. A Windows job runs
  [`companion/scripts/prebuilt.mjs`](../companion/scripts/prebuilt.mjs) `build`, then `check`:
  it extracts the zip to a temp folder, checks the required files and CRLF line endings in
  `Run Familiar.cmd`, fails if either Claude package is in the zip, and with every `node.exe` removed from
  PATH runs `electron.exe companion --self-test` there (koffi loads and makes a native call,
  `dist/main.js` and `Familiar.toc` exist, Claude Code is `skip`: not downloaded yet), then
  `fetch-claude.cjs` as the first run does (a real npm download), then the self-test again
  (`claude.exe --version` runs), imports the downloaded SDK, then runs the fetch once more,
  which must find everything in place. Only then
  is it uploaded. Its name must not start with
  `Familiar-`: the addon zip check expects exactly one `Familiar-*.zip`. To build and check one
  locally on Windows (Node 24): `node companion/scripts/prebuilt.mjs build <out>.zip`, then
  `... check <out>.zip`; `build` packs the committed `HEAD`, not uncommitted changes.
* `SHA256SUMS.txt`: SHA-256 of the app zip and the addon zip, written by the workflow after it
  re-downloads the addon zip. Re-running a tag (or just its failed app job) replaces both files.
* GitHub's automatic "Source code (zip)": not the supported download; the README points to the
  `FamiliarApp` zip.
* Notes: [`release-body.md`](release-body.md) (the GIF, `docs/media/familiar.gif`, or else
  `approval.png` when the tag has one; "Familiar in one minute"; the downloads), then the commit log
  since the previous tag. The workflow fills in the tag, version and repository and keeps the
  block between `<!-- release-body -->` markers, so a rerun replaces it. Edit the notes by hand
  afterwards as usual. While Familiar is in beta the workflow marks the release as a prerelease
  titled `Familiar X.Y.Z beta`.

## Addon managers

WowUp ("Install from URL") and CurseBreaker (`add https://github.com/Zeezy3z/familiar`) install
from the latest GitHub release using `release.json`. Whether each recognizes the `forever` flavor
and the WoW: Forever AddOns folder is not yet confirmed; test before pointing users at it. Some
managers skip prereleases unless a beta channel is selected. Manual install: unzip into
`<WoW: Forever>\Interface\AddOns\`.

## CurseForge and Wago (later)

Uploads to a site are skipped while its token or project ID is missing, so the GitHub release keeps
working on its own.

1. Create the projects (moderation takes days). Say on both pages that the addon requires the
   Familiar companion app.
2. Add to `Familiar.toc`: `## X-Curse-Project-ID: <numeric id>` and `## X-Wago-ID: <Wago id>`.
3. Add repository secrets `CF_API_TOKEN` and `WAGO_API_TOKEN`, and pass them in the packager step's
   `env` in `release.yml`.

The packager marks a CurseForge/Wago file beta only if the tag contains `beta`, so a plain `vX.Y.Z`
tag uploads as a release. WoWInterface does not support WoW: Forever yet.

## Checksums

`SHA256SUMS.txt` (above) is the checksum list the README sends users to. GitHub also computes a
SHA-256 digest for every uploaded release asset and shows it next to the asset on the release page
(also `gh release view vX.Y.Z --json assets` and the REST API's `digest` field). Verify with
`sha256sum` (or `Get-FileHash` on Windows). The automatic source archive is not an uploaded asset
and has no published digest.

## Signed installer

[`installer.yml`](../.github/workflows/installer.yml) runs on every `v*` tag and on manual dispatch.
It always packages the companion (`companion/electron-builder.yml`), checks the result with
[`companion/scripts/installer-check.mjs`](../companion/scripts/installer-check.mjs) and runs
`Familiar.exe --self-test` on it, but publishes nothing unsigned. It builds, signs and uploads the
per-user NSIS installer only when the repository variable `SIGNING_READY` is `true`. Signing uses
Azure Artifact Signing through GitHub OIDC, so there is no Azure secret key.
`companion/build/sign.cjs` signs every file electron-builder hands it and refuses any Claude Agent
SDK file. The job then checks the signatures of `Familiar.exe` and the installer.

Like the app zip, the installer carries no Anthropic code. `electron-builder.yml` leaves out the
Claude Agent SDK and its Claude Code binary package; the SDK's open-source dependencies stay. The
build writes `companion/dist/claude-pins.json` from `package-lock.json` (`scripts/build.mjs`: name,
version, registry URL and sha512 of both win32-x64 packages), and it ships inside `app.asar` with
`fetch-claude.cjs`. On first run the installed app downloads exactly those versions from
`https://registry.npmjs.org` into `%LOCALAPPDATA%\Familiar\claude`, checks each against its sha512
and moves them into place only once both are checked (`fetchClaude({ root, pins })`, in the app,
with progress and **Retry** in the Familiars card). Both jobs fail unless:

* `installer-check.mjs release/win-unpacked` finds no `@anthropic-ai/claude-agent-sdk*` folder
  and no `claude`/`claude.exe` anywhere under `release/win-unpacked`, neither as files nor inside
  `app.asar`, and finds `dist/claude-pins.json`, `fetch-claude.cjs` and `self-test.cjs` in
  `app.asar`;
* `Familiar.exe --self-test` reads the pins and reports `skip Claude Code (claude --version): not
  downloaded yet` (a fresh runner has no `%LOCALAPPDATA%\Familiar\claude`).

**Publish the installer only when `SIGNING_READY` is `true`,** never an unsigned one. Set it after a
manual run of `installer.yml` on `main` has passed (step 5 below).

To turn it on:

1. In Azure, create an Artifact Signing account and certificate profile and finish identity
   validation. Create an app registration and give it the *Artifact Signing Certificate Profile
   Signer* role on the profile. Add a federated credential for GitHub Actions with entity type
   *Environment*, name `signing`, for this repository.
2. In GitHub, create the environment `signing` and limit it to `v*` tags (add `main` as well if
   you want manual signing runs).
3. Add these repository secrets: `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` (the app registration).
4. Add these repository variables:
   * `AZURE_SIGNING_ENDPOINT`: the account's regional endpoint, for example
     `https://eus.codesigning.azure.net/`.
   * `AZURE_SIGNING_ACCOUNT`: the Artifact Signing account name.
   * `AZURE_SIGNING_PROFILE`: the certificate profile name.
   * `SIGNING_PUBLISHER`: the certificate's subject CN, exactly as it appears. Choose it once:
     once in-app updates exist, changing it breaks them for installed users.
5. Run the workflow once by hand with `SIGNING_READY` unset to confirm the package check and the
   self-test pass. Then
   set `SIGNING_READY` to `true`. A manual run signs and verifies but uploads nothing; the next
   tag adds `Familiar-Setup-X.Y.Z.exe`, its `.blockmap`, `latest.yml` and a `SHA256SUMS.txt` line.

The installer job waits for `release.yml` to create the release first. If you re-run
`release.yml` for a tag, it rewrites `SHA256SUMS.txt` without the installer line, so re-run the
installer job afterwards.

Local unsigned build, for testing only (never publish its output): from `companion/`, run
`npm run build`, then `npx electron-builder --win --dir`, then
`node scripts/installer-check.mjs release/win-unpacked` and
`release\win-unpacked\Familiar.exe --self-test` from Git Bash. With Smart App Control on, Windows
may refuse to run the freshly built, unsigned `Familiar.exe` ("An Application Control policy has
blocked this file"); CI's runner is the place to run it then. Don't start the packaged app
normally on a machine you use: it writes the startup entry and the WoW AddOns folder, and
downloads Claude Code into `%LOCALAPPDATA%\Familiar\claude`.

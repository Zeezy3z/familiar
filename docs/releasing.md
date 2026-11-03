# Releasing

A `v*` tag push runs [`release.yml`](../.github/workflows/release.yml), which packages the addon
with the [BigWigs packager](https://github.com/BigWigsMods/packager) (pinned by commit) and
publishes a GitHub release. Configuration: [`.pkgmeta`](../.pkgmeta).

## Cut a release

1. Set the same version in `addon/Familiar/Familiar.toc` (`## Version: X.Y.Z`) and
   `companion/package.json` (`"version": "X.Y.Z"`). Plain numbers; no `beta` suffix.
2. Run the checks in [ci.md](ci.md), then commit and get it onto `main`.
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
* `FamiliarApp-vX.Y.Z-windows.zip`: the app users download (companion plus addon, root folder
  `Familiar/`, `Run Familiar.cmd` inside). The workflow builds it from the tag with `git archive`,
  checks it holds `Run Familiar.cmd`, `companion/package-lock.json` and `addon/Familiar/Familiar.toc`
  and that `Run Familiar.cmd` has CRLF line endings, then uploads it. Its name must not start with
  `Familiar-`: the addon zip check expects exactly one `Familiar-*.zip`.
* `SHA256SUMS.txt`: SHA-256 of the app zip and the addon zip, written by the workflow after it
  re-downloads the addon zip. Re-running a tag replaces both new files.
* GitHub's automatic "Source code (zip)": not the supported download; the README points to the
  `FamiliarApp` zip.
* Notes: the commit log since the previous tag. While Familiar is in beta the workflow marks the
  release as a prerelease titled `Familiar X.Y.Z beta`.

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

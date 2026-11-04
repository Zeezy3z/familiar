# Third-party notices

Familiar is MIT-licensed (see [LICENSE](LICENSE)). It depends on the packages below, at the
versions pinned in `companion/package-lock.json`. In a git clone, `Run Familiar.cmd` installs them
from the npm registry on your own machine (`npm ci`). The release download
`FamiliarApp-vX.Y.Z-windows.zip` includes the runtime packages below and the Electron binary
(MIT; Chromium and Node.js notices in `companion/node_modules/electron/dist/LICENSE` and
`LICENSES.chromium.html`), each with the licence files its package publishes, in its folder under
`companion/node_modules/`, **except Anthropic's Claude packages**: the download contains no
Anthropic proprietary code, neither `@anthropic-ai/claude-agent-sdk` nor
`@anthropic-ai/claude-agent-sdk-win32-x64`. Its first run downloads both from the npm registry
onto your own machine (`companion/fetch-claude.cjs`), at the versions the lockfile pins and
checked against the lockfile's hashes. The Windows installer (`Familiar-Setup-X.Y.Z.exe`) leaves
them out the same way: the installed app downloads them on first run into
`%LOCALAPPDATA%\Familiar\claude`. This repository and its downloads never redistribute them.
The SDK's open-source dependencies, such as @anthropic-ai/sdk (MIT), are in the download.

## Runtime dependencies (companion)

| Package | Version | Licence | Notes |
|---|---|---|---|
| @agentclientprotocol/sdk | 1.7.0 | Apache-2.0 | ACP client for Hermes, Grok Build and other ACP agents. |
| @anthropic-ai/claude-agent-sdk (with its platform package @anthropic-ai/claude-agent-sdk-win32-x64) | 0.3.293 | Proprietary: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." | The platform package contains the unmodified Claude Code binary. Both are downloaded from npm onto your machine at first run, under Anthropic's terms (`npm ci` in a git clone, `fetch-claude.cjs` in the release download); not bundled by `scripts/build.mjs` (marked `external`), not committed, and not in the release download or the installer: the installed app downloads both from npm on first run into `%LOCALAPPDATA%\Familiar\claude`, at the versions `package-lock.json` pins (shipped as `dist/claude-pins.json`), checked against their sha512. Familiar never modifies either. See `docs/releasing.md`. |
| @fontsource/marcellus | 5.3.0 | SIL Open Font License 1.1 (OFL-1.1) | Font "Marcellus", Copyright (c) 2012 Brian J. Bonislawsky DBA Astigmatic (AOETI), with Reserved Font Name "Marcellus". `scripts/build.mjs` copies `marcellus-latin-400-normal.woff2` into the local `dist/assets/` for the overlay and control panel. |
| dompurify | 3.4.16 | MPL-2.0 OR Apache-2.0 | Used under the Apache-2.0 option. |
| highlight.js | 11.12.0 | BSD-3-Clause | Copyright (c) 2006, Ivan Sagalaev. |
| koffi | 3.3.2 | MIT | Copyright (C) 2026 Niels Martignène. Win32 FFI (window tracking). |
| marked | 18.0.14 | MIT | Copyright (c) 2018+, MarkedJS; Copyright (c) 2011-2018, Christopher Jeffrey. |

Transitive runtime dependencies are listed in `companion/package-lock.json`; their licences are
permissive (MIT, ISC, BSD, Apache-2.0, Unlicense), including @anthropic-ai/sdk 0.131.0 (MIT).
Two of them publish no licence file, only a `"license": "MIT"` field in their `package.json`:
@koromix/koffi-win32-x64 (koffi's native module) and standardwebhooks.

## Development dependencies

| Package | Version | Licence |
|---|---|---|
| electron | 44.10.1 | MIT (bundles Chromium and Node.js, each with its own notices inside the Electron distribution). Only its binary (`dist/`) is in the release download |
| esbuild | 0.28.2 | MIT |
| fengari | 0.1.5 | MIT (Lua 5.3 VM in JavaScript, used by the headless addon tests) |
| tsx | 4.23.15 | MIT |
| typescript | 7.0.2 | Apache-2.0 |
| vitest | 5.0.3 | MIT |
| @types/node | 26.6.4 | MIT |

## SIL Open Font License 1.1

The Marcellus font is licensed under the SIL Open Font License, Version 1.1. The full licence
text ships with the package at `companion/node_modules/@fontsource/marcellus/LICENSE` and is
available at https://openfontlicense.org/open-font-license-official-text/. Under the OFL the font
may be bundled with software under any licence; it may not be sold by itself, and modified
versions may not use the Reserved Font Name "Marcellus".

## Other

* World of Warcraft, its API and the `Interface\Icons\Ability_Hunter_Pet_Owl` icon referenced by
  the addon are © Blizzard Entertainment. The icon is referenced by game path and is not included
  in this repository. Familiar is a fan project, not affiliated with or endorsed by Blizzard
  Entertainment.
* "Claude" and "Claude Code" are trademarks of Anthropic; "Codex" is a trademark of OpenAI.
  Familiar runs these tools as installed by the user; it is not built, endorsed or partnered by
  either company.

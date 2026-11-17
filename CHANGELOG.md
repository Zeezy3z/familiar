# Changelog

All notable changes to Familiar. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### What you need to do

* **Set an Approve key, or turn on click approval.** Approving in game now uses the key you register:
  bind **Approve the pending request** in WoW (Options → Keybindings → AddOns → Familiar), then in
  the control panel choose **Safety → Approve key → Set key…** and press the same key. If you prefer
  clicking, turn on **Safety → Approve by mouse click**. With neither, requests can be approved only
  in the control panel.
* **Modes and Always are in the control panel now.** **Safety → Open quest** sets the mode of the
  quest open in the game; **Requests waiting** has **Always**. The game no longer changes either.
* **If your quests relied on your own allow rules, hooks or MCP servers,** turn on **Safety → Use my
  existing agent configuration**. It is off by default.
* If you had bound the scroll, tracker, log or view keys, those bindings are gone; use `/fam tracker`,
  `/fam log`, the mouse wheel and the view button.

### Changed

* Approving in game: the Approve key is the default; clicking the card is an opt-in setting. Either
  way the Windows app decides: only a request the Glass has shown, unchanged, for a moment and that
  you scrolled to the end of can be approved, and each key press or click approves one request.
  Deny and Stop work as before.
* Quests started from the game no longer load your own Claude Code settings (allow rules, hooks)
  or MCP servers by default. The project's `CLAUDE.md` is still read. For Codex, plugins and apps are
  switched off per quest; MCP servers and rules in your Codex `config.toml` still apply.
* From the game you can change sounds and turn Stream-safe on; turning privacy off, start with
  Windows and every other setting are on the PC. A folder path typed in game must be under a
  project folder you added or a zone Familiar already lists.
* `/fam`: one short help list (about 11 lines). A single unknown word or a command with the wrong
  arguments shows help instead of being sent to your quest. Commands that moved (`approve`,
  `always`, `autostart`, `font`, `opacity`, `private`, `quiet`, `warnings`, `suggest`, `native`,
  `view`, `draft`, `caughtup`) say where the setting went; `pin`, `hide`, `unhide`, `archived` and
  `sync` are gone. `/fam stream` only turns Stream-safe on.
* The window: **+ Quest** (pick a familiar, then a zone) replaces **+ Claude** / **+ Codex**, which
  remain on the Glass welcome page; the bottom bar has **Deny**, **Stop** and **Send**; one view
  button cycles Full → Quest only → Compact. Seven keybinds.
* The Glass: zones keep a fixed order (Chats first, then by name), each shows five rows plus
  **+N more**, and every row shows its age. One-line waiting banner, the pending request pinned at
  the bottom, a docked **Latest**, and the same words everywhere: *Needs you*, *Reply ready*.
* The control panel has a fixed layout: Requests waiting, one status line, Play, Safety,
  Familiars, Projects, Troubleshooting, and a footer with Check for updates, Start with Windows and
  Suggest a change. Privacy is one control with three levels.
* The Runestrip always uses its near-black colours; the palette setting is gone. The link finds the
  strip in any corner, reads its colours from the strip itself, and says plainly when HDR or a
  colour filter makes it unreadable.
* Familiar captures the game at 2 fps while WoW is not in front (30 fps when it is), to save CPU.
* Check for updates now sees beta releases.

### Added

* **Copy** on a finished reply puts its visible text on the Windows clipboard.
* A Windows notice when a quest finishes while WoW is not in front (the same setting as the notice
  for waiting requests).

### Removed

* The saved in-game copy of your conversation and the **Text** button: `FamiliarSync` now holds a
  timestamp and status only, and the window says when Familiar last ran.
* Chat defaults and "Find your way back" from the control panel (the chat defaults remain in
  `config.json`). Quiet play moved to **Play → Notifications**.
* The **Mode** button in the game window.
* Approving a plan with **Always** no longer switches the quest to Accept edits.
* Spoken notices.

### Security

* The README's network section now lists all three kinds of request Familiar makes: the Claude Code
  download, the update check, and Wowhead page lookups for Claude chats.

### For contributors

* Approval authority lives in `main/physical.ts` (`ApprovalGate`), fed by the Glass's `painted`
  report; main tells the Glass how to offer approval with `approve`. Rectangles from the addon are
  never used to approve.
* New config keys `approveByClick` and `inheritAgentConfig` (both default `false`); settings from
  the game go through `Hub.settings(…, "game")`.
* Protocol: `hover` and several keys removed; `key new` takes a familiar id; capture accepts `rate`.
  See `docs/protocol.md`.
* New suites: `test/physical.test.ts` (extended), `test/safety.test.ts`, `test/viewmodel.test.ts`,
  `test/geometry.test.ts`.
* Release: a `v*` tag publishes only after `windows.yml` passes; source maps are no longer shipped;
  five packages that esbuild bundles moved to devDependencies; the README media check runs on
  `docs.yml`. See `docs/releasing.md` and `docs/ci.md`.
* Development environment switches are dead in the installed app and the release ZIP.

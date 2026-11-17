# Roadmap & test plan

Status: ✅ done · ⬜ open

## Milestones

| # | Milestone | Status |
|---|---|---|
| M0 | Research: addon limits on Forever, agent backends, capture/overlay feasibility (`docs/research.md`) | ✅ |
| M1 | Runestrip codec (Lua + TS) with cross-language parity tests, gamma/noise/fractional-scale/I420 robustness | ✅ |
| M2 | Addon: quest-log window, composer, touch surfaces, buttons, tracker, minimap + compartment, keybinds, slash commands, layout reporter, saved-status view | ✅ |
| M3 | Companion: WoW window tracking (koffi), WGC capture, decoder lock/acquire, overlay placement/visibility, control panel, tray, single instance, no error dialogs | ✅ |
| M4 | Hub: zones (configured project roots + Codex projects + recent sessions, `exclude` / `.nofamiliar`), quests, drafts, selection, approvals, toasts, persistence | ✅ |
| M5 | Claude backend (Agent SDK): new/resume/fork, streaming, tools, objectives, approvals incl. questions + plan exit, modes, models, retry | ✅ |
| M6 | Codex backend (app-server): new/resume/fork, streaming, tools, plan, approvals, modes, models, projects | ✅ |
| M7 | Glass renderer: quest log, details, markdown/code, tool expand, approval cards, tracker, toasts, key glows, occluder cut-outs, chimes | ✅ |
| M8 | FamiliarSync saved status + addon installer (junction into `Interface\AddOns`, broken links re-pointed) | ✅ |
| M9 | FakeWoW harness + dev hooks; end-to-end runs: Claude quest, Codex quest, approve/deny via card click, message bursts, scripted suite (`scripts/e2e.mjs`) | ✅ |
| M10 | Headless addon harness (fengari + WoW mock) + Forever API conformance check | ✅ |
| M11 | Hub state-machine tests with fake backends | ✅ |
| M12 | Extras: in-game diffs for edit approvals, type-to-pick zones, `/fam claude @zone`, abandon quests, mode/model toasts, near-black Runestrip levels, monitor-capture fallback, `/fam diag`, opt-in start with Windows | ✅ |
| M13 | In-game verification on WoW: Forever across more PCs, monitors and DPI settings (checklist below) | ⬜ |
| M14 | Runestrip inside the panel border, `Screenshot()` uplink fallback | ⬜ |
| M15 | Thread hygiene: follow desktop archive, noise filters, running badge, agent filter, `+N more`, worktree + Codex chats zones | ✅ |
| M16 | Offline honesty: opt-in start with Windows (`/fam autostart`), lazy backends, outbox/acks/heartbeat, honest offline bar, interrupted turns | ✅ |
| M17 | Chat zone: no-repo chat (`+ Chat`, `/fam ask`), live web search, Forever-grounded instructions, character context | ✅ |
| M18 | Provider registry + generic ACP backend (`@agentclientprotocol/sdk`): Hermes (ACP + read-only `state.db` catalog incl. bot sessions), Grok Build, any ACP agent via config | ✅ |
| M19 | Thread continuity: one owner at a time, "Continue in app", holder prompt instead of a silent fork, default-mode setting, `/fam focus game` / `stay`, catch-up acks | ✅ |
| M20 | First public release: Windows 11 + Node 24 launcher checks, install detection from the running game, Interface `16001, 16002, 16003`, neutral defaults, docs and licensing | ✅ |
| M21 | Trust and clarity: approval authority in main (painted cards, Approve key by default, opt-in click), Always and modes only in the control panel, quests without the player's agent configuration by default, typed folders limited to known roots, saved status without transcript, one `/fam` verb table, fixed control-panel layout, stable Quest Log order, one Runestrip level set with ramp diagnosis, 2 fps background capture | ✅ |

## Next

* ⬜ In-game verification across more PCs, monitors, DPI settings and HDR (M13).
* ⬜ Codex: a per-quest switch for MCP servers and rules in `~/.codex/config.toml` (none known in
  the app-server; plugins and apps are switched off already).
* ⬜ Hermes and Grok resume paths for threads started outside ACP.
* ⬜ Clean up agent processes orphaned by a hard crash.

## Test matrix

| Layer | How | Where |
|---|---|---|
| Codec parity | Lua (fengari) vs TS cell-for-cell; CRC check value | `companion/test/codec.test.ts` |
| Decoder robustness | synthetic renders: fractional pitch, offsets, gamma, noise, I420 chroma, clipped and collapsed ramps | `codec.test.ts` |
| Addon logic | real addon files in a WoW mock: boot, hello, layout, composer, chunking, clicks, wheel, buttons, `/fam` verb table and help, retired settings | `companion/test/addon.test.ts` |
| API conformance | every widget method/global used exists in Forever (from `wow-ui-source@forever`) | `addon.test.ts` + `test/fixtures/wow-api.json` |
| Hub logic | fake backends: zones/exclusions, typed folders, drafts, streaming, approvals, adopt/resume, archive | `companion/test/hub.test.ts` |
| Quest Log model | zone order, five rows per zone and `+N more`, ages, twins, refusal lines | `companion/test/viewmodel.test.ts` |
| Approval authority | press log, painted-card gate, Approve key and click proofs, consumption | `companion/test/physical.test.ts` |
| Safety defaults | agent configuration not inherited by default; dev switches dead in a distributed build | `companion/test/safety.test.ts` |
| Display geometry | DPI origins, client corners, layout px at 150% | `companion/test/geometry.test.ts` |
| Privacy | Hide names and Stream-safe in the model, notices and FamiliarSync | `companion/test/private-mode.test.ts` |
| Control panel | journey, status line, Approve key status, privacy levels, familiar status | `companion/test/journey.test.ts` |
| Main kernels | Link Doctor, Windows notices, update check, capture gate, FamiliarSync and addon install | `doctor`, `notices`, `update`, `capture-gate`, `wow` `.test.ts` |
| Agents | Claude/Codex adapters (incl. project instructions without the player's configuration), ACP against an in-process agent, Wowhead tool | `agents`, `acp`, `wowhead` `.test.ts` |
| Live pipeline | FakeWoW window → real WGC capture → decoder → Hub → real Claude/Codex → Glass; composite snapshots | `scripts/dev-restart.sh --fake`, `node scripts/e2e.mjs --agents` |
| In-game | checklist below | WoW: Forever |

## In-game checklist

1. Start the companion (`Run Familiar.cmd`), then WoW. In the character-select **AddOns** list,
   make sure **Familiar** and **Familiar Sync** are enabled (first install needs a WoW restart).
2. In game: chat shows "Familiar: ready". A small coloured line is at the very top-left.
3. The control panel says **All set**; **Troubleshooting → Runestrip link** shows ~30 fps, CRC 0.
   (`/fam strip` prints strip info.)
4. `/fam` opens the window; the Glass paints the Quest Log and welcome page inside the panes,
   aligned to the borders. Drag the window: the Glass follows it; resize with the bottom-right
   grip: the panes resize along.
5. Set an Approve key (WoW keybind and **Safety → Approve key**). `+ Quest` → Claude Code → click a
   zone → type a question → Enter. Watch it stream; the tracker shows it working.
6. Ask it to create a file → pinned request + orange toast → scroll to its end → press the Approve
   key. Deny and Stop from the bottom bar. With **Approve by mouse click** on, the card's Approve
   button works too.
7. Same with Codex.
8. Click a dimmed desktop thread → history loads → send a message to continue it.
9. **Copy** under a finished reply → the text is on the Windows clipboard. Quit Familiar, `/reload`
   → the window says when Familiar was closed.
10. Change UI scale, resize the window, toggle Windowed (Fullscreen): Glass stays aligned.
11. Alt-Tab away: Glass hides and capture drops to 2 fps; back: reappears at 30 fps. Alt+Z hides
    UI: Glass hides.

# Familiar — design proposal

> Talk to your Claude Code and Codex agents from inside World of Warcraft: Forever — across any
> project folder, with live streaming replies and in-game approvals — without leaving the game and
> without automating the game.

## 1. Goals

1. **Never leave the game.** Start, continue, steer and approve agent work from the WoW UI.
2. **Both ecosystems.** Claude Code (Agent SDK) and Codex (ChatGPT/Codex desktop's app-server), with
   the user's existing logins — including continuing threads started in either desktop app.
3. **Any project.** Pick a project ("zone") from your configured project roots and recent agent
   history, or type a path under one of them or under a known zone (`mkdir` to create one), and
   start a quest there.
4. **Feels native.** Quest-log metaphor, WoW chrome, keybindings, slash commands, minimap button,
   tracker, raid-warning toasts, sounds.
5. **No game automation.** No input injection, no process hooks, no memory reads, nothing routed through
   Blizzard servers.

## 2. The constraint, and the idea

WoW addons are sealed: they can draw, but cannot talk to anything outside the game in real time.
The two directions are therefore solved separately, each with the most capable channel that
involves **no interaction with the game process**:

* **Uplink (game → PC): the Runestrip.** The addon paints a small grid of solid-colour cells in a
  screen corner. The companion reads them from the game window with Windows.Graphics.Capture, the
  same API OBS uses. Typed prompts, clicks, scrolls and window layout flow out at ~2–5 KB/s.
* **Downlink (PC → you): the Glass.** The companion paints live content in a transparent,
  click-through, always-on-top window aligned exactly over the addon's panels, so streamed answers,
  code blocks, tool calls and approval cards appear *inside* the WoW window. Your mouse and keyboard
  still go to WoW; WoW reports each click back over the Runestrip and the Glass hit-tests what it
  drew there.

The addon is the **terminal** (chrome, input, keybinds); the companion is the **mainframe** (agents,
state); the Glass is the **phosphor** (live pixels). A third, slow channel — a data addon the
companion rewrites (`FamiliarSync`), read at login and `/reload` — gives the addon a timestamp and a
status, never the conversation: the window says when Familiar last saved, or that it was closed,
while the Glass is not drawing.

```
 ┌──────────────── WoW: Forever ────────────────┐        ┌──────────── Familiar companion (Electron) ─────────────┐
 │ Familiar addon (Lua)                         │ pixels │  capture (WGC) → Runestrip decoder → Hub ──► Claude SDK │
 │  • quest-log window, composer, buttons       │ ─────► │                                     │  └──► Codex app- │
 │  • touch surfaces → click/wheel/hover events │        │                                     │       server     │
 │  • Runestrip (top-left, pixel-perfect)       │        │  render model ◄─────────────────────┘                  │
 │  • FamiliarSync status (on /reload)    ◄─────┼─ file ─┤  status writer                                         │
 └──────────────────────────────────────────────┘        │  Glass overlay (click-through, aligned) ──► you        │
                         ▲  you see Glass over the panel  └────────────────────────────────────────────────────────┘
```

## 3. In-game experience

**Window ("Familiar")** — WoW dialog chrome with the owl-familiar icon:

* **Quest Log (left, on the Glass):** zones = projects, quests = threads (✦ Claude, ◈ Codex).
  Zones keep one order, Chats first and then by name; live activity never moves a zone (clicks are
  hit-tested by position). Each zone lists its five newest rows plus `+N more`; rows that need you,
  are working, failed, are unread or are selected always show. Every row carries its age (a time
  stamp when two rows read the same). Status glyphs (◌ working, ! needs you, ✗ failed), unread dots,
  and desktop-app threads dimmed under each zone (not archived, started by a person, active
  recently; pinned and running always; none under Hide names). Click a zone to collapse it,
  right-click to start a quest there; right-click a quest to archive it. `/fam show <agent>` filters.
* **Quest details (right, on the Glass):** title, zone, a mode chip and a state chip (*Needs you*,
  *Reply ready*, …; the same words everywhere, `shared/words.ts`), model, tokens/cost; **Objectives**;
  the transcript (markdown, highlighted code, collapsible tool calls); a one-line waiting banner
  that opens into the catch-up notes; the pending request **pinned** under the transcript, the one the
  Approve key acts on; a docked **Latest** chip; **Copy** under each finished reply of a Familiar
  quest (main writes the reply's visible text, HTML and hidden comments stripped, to the Windows
  clipboard on a proven click).
* **Welcome (right pane, nothing selected):** the quest giver. A round portrait (idle, working,
  asking, asleep or puzzled, from the render model), "Well met." and who it is linked to, then quest
  rows: *Ask a game question*, *Work on a project*, *Continue a conversation*, each a name, one dim
  line and its buttons on the right, and the one-line tutorial replay. The portrait is a picture
  only and is hidden when the pane is too short.
* **Chats zone:** `+ Chat` / `/fam ask` — a cheap model with web search and nothing else (no repo,
  files or shell); the character's class, level, location and quest log go along. Codex desktop
  chats without a project are listed here too.
* **Composer (native):** multi-line; Enter sends, Shift+Enter newline, Ctrl+↑/↓ history; a
  **Discard** button clears an unsent draft.
* **Toolbar (native):** `+ Quest` (one familiar switched on: its zone picker at once; more: a small
  menu, which the layout reports as an occluder), `+ Chat`, `Back`, `Model` (opens the model list).
  There is no Mode button: the game can never change a quest's mode. `+ Claude` / `+ Codex` exist
  only on the Glass welcome page.
* **Bottom bar (native):** the view button (Full → Quest only → Compact; Quest only is remembered,
  Compact lasts the session), the status line, `Deny`, `Stop`, `Send`. There is no Approve or
  Always button: approving is the Approve key, or a click on the card when click approval is on.
* **Saved status (native, under the Glass):** what `FamiliarSync` says — never ran, closed at a
  time, or saved at a time — so a player without the Glass knows why. No conversation.

**Visual tokens and button order.** The Glass and the control panel share one token set, defined in
`overlay.css` `:root` and `control.html`: gold `#ffd100` (titles, buttons), gold-dim `#c9a227`, text
`#ece4d4`, text-dim `#bfb6a4`, muted `#9c9384`, ok `#7dd96b`, warn orange `#ff8040` (approval,
unknown), err `#ff5a4f`, info blue `#71d5ff` (working, links), agent glyphs `#d98a60` (Claude) and
`#7fd1a8` (Codex), borders `rgba(143,115,64,.45)`. Type has four sizes, `--fs-sm` · `--fs-md` ·
`--fs-lg` · `--fs-xl`, plus `--row-font` for the Quest Log rows. On the Glass they are ratios of the
layout-derived `--small-font` / `--body-font` (small, body, 1.25×, 1.7×), never absolute pixels,
because those carry the 11/10 px floors; the control panel's are fixed at 12 / 14 / 16 / 22 px.
Every font size in `overlay.css` and `control.html` is one of those tokens, `var(--row-font)`,
`1em`, `inherit` or the raid toast's `max(…)`; `test/type-scale.test.ts` keeps anything else out.
The display face is for chrome and buttons, the sans face for prose, mono for code only. State is
never colour alone: each status shows a glyph and a word (✓ ! ✗ ◌). The canonical request order is
**Approve · Deny · Always (this quest)**. On the Glass a card shows only the first two: the way to
approve (*Press F9 to approve*, or a filled Approve button when click approval is on, hidden until
the request has been read to its end) and a filled Deny; Always is given only in the control panel,
as a ghost button (dashed border, right-aligned) that applies to the current quest for Claude and
Codex. Pane rects, `--row-h` and the status/tracker rects come from `Layout.lua`; styling may add
depth inside a rect but never changes its size. Motion has three durations: `--m-fast` 150 ms (state
changes), `--m-arrive` 350 ms (arrivals: toast, card, seal, badge, a request on the panel) and
`--m-settle` 600 ms (the Quest Complete moment settling). Nothing is longer and nothing loops but
the caret; reduced motion turns it all off. `test/motion.test.ts` keeps literal durations out of
`overlay.css` and `control.html`.

**Tracker** — a small movable frame like the quest objective tracker: active quests, what each
familiar is doing right now (current objective or tool), progress `3/5`, approvals in orange.
Click a line to open that quest.

**Toasts and sounds** — raid-warning style banners when a quest finishes, fails or needs approval,
and six synthesized cues (`shared/cues.ts`: oscillators and filtered noise from
a pure score, no recordings): *Quest started* (a parchment unroll), *Needs your approval* (a bell),
*Approved* (a stamp), *Quest Complete* (a rising three-note phrase), *Answer ready* (one soft note,
for a chat) and *Quest Failed* (two low notes stepping down). Approved and Quest started answer
the player's own action, so in combat they are dropped, never held; the others keep the
hold-and-summarize path. Deny, Stop and refusals are silent, and nothing plays while a quest works.
The volume is `soundVolume` (0-100, default 70), set in the control panel or with `/fam sound`.

**Stream-safe curtain** — with Stream-safe on, replies, sent messages, tool lines and objectives
are blurred and sit under a dark veil with a gold top edge; a click on one lifts the veil for 8
seconds. Approval cards are never blurred and never veiled, and the status bar shows chips
(*Stream-safe on*, *Hide names on*, *Alerts muted*) instead of a suffix.

**Slash commands** — one verb table in `Core.lua` (verb, argument check, handler, help line; about
11 help lines). Anything that is not a verb and has two or more words goes to the selected quest. A
single unknown word prints the closest verb; a verb with arguments it does not take prints its
usage; neither reaches a familiar. Verbs that left `/fam` (approve, always, autostart, font,
opacity, private, native, view, …) print where the setting went. The list is in the README.

**Keybindings** (Options → Keybindings → AddOns → Familiar), seven: toggle the window, focus the
composer, approve, deny, stop, next quest, previous quest. Also: minimap button and the AddOn
compartment. The minimap button wears a small `!` (a request is waiting) or `?` (a reply is unread)
at its top-right, drawn by the Glass on the button's rectangle that the addon reports in the layout
message; it takes no clicks, carries no text, and paints nothing when the rectangle is absent.

**Desktop control panel** (tray → Open Familiar) — everything that must not be reachable from the
game, in a fixed order that never moves between states (`control/control.ts`):

1. **Header:** portrait (follows the journey: puzzled while unlinked, asking while a request waits,
   working while Claude Code downloads or a quest runs, else idle), name, running version, link
   badge, a mode pill only while new quests do not start in Ask first, and a line when the addon
   and the app are different versions. Painted workshop band behind (`assets/workshop-1600.jpg`).
2. **Requests waiting** (only while there is one): every pending approval except multiple-choice
   questions, each with its whole text and **Approve · Deny · Always**; requests the in-game card
   cannot show whole carry *Too long for the in-game card*. See §5.
3. **Status line:** "All set — type /fam in WoW", or the one thing in the way with its action (the
   Link Doctor's sentence from `main/doctor.ts` while unlinked); the three-step strip *Agents · WoW
   · Link* shows only while setup is incomplete; **Pause overlay**.
4. **Play:** Text size, Sounds (volume, **Play a sample**), Notifications (raid-warning style; the
   Windows notice; Quiet play, which holds ordinary completion notices), **Privacy on the Glass** —
   one control, three levels (Off · Hide names · Hide names and blur replies) over `privateMode` and
   `blurTranscript`.
5. **Safety:** **Open quest** (the mode of the quest open in the game), **New quests start in**
   (warning box for Accept edits and Auto), **Approve key** (Set key… records a key press; warns
   about keys used for playing), **Approve by mouse click** (`approveByClick`), **Use my existing
   agent configuration** (`inheritAgentConfig`).
6. **Familiars:** one row per agent with one status (`familiarStatus`), Use, Sign in, Install…,
   Retry and download progress.
7. **Projects** (collapsed once a folder is set): folders added by hand or as folders of projects.
8. **Troubleshooting** (collapsed): Runestrip link (and **Save what Familiar sees**, a 320×32 px
   crop of the strip corner), World of Warcraft, Addon (**Reinstall addon**, **Test overlay**),
   Familiar on this PC (Open config, Reload config, Open log file, Copy diagnostics, Rescan desktop
   quests, build identity), Log.
9. **Footer:** **Check for updates** (one request to GitHub per click), **Start with Windows**,
   **Suggest a change**.

Each setting is a row: label, control, one hint line. Two button styles: a ghost for everything
secondary and red `primary` for the one action that moves you on; on a request, Approve is the
Glass's green, Deny is red and Always is the dashed ghost, so Deny never looks quieter than
Approve. Journey wording comes from `control/journey.ts` (version and update wording from
`control/build.ts`); nothing there changes a setting. Everything that came from an agent, the game
or the network is set as text, never as markup.

**UI voice.** How Familiar's own words read, on the PC and in the Glass:

1. The familiar speaks in the first person only about its own state: "I can't see the game yet.",
   "I'm waiting for WoW.", "Ready when you are."
2. One sentence, then the action. The line under it says what to do, plainly and literally.
3. Safety copy is literal and never in character: approval cards, refusals, mode warnings, cut
   banners, the Link Doctor's sentence and the Windows notice keep their words and their chrome.
4. No exclamation marks.
5. WoW flavour lives in nouns (quest, zone, familiar, Quest Log), never in verbs.
6. Titles can be in voice; the explanation beneath a title never is.
7. State is a glyph plus a word, never colour or a picture alone; a portrait never carries state
   on its own.
8. Numbers are plain ("3/3 objectives · 2 edits · $0.21"); no names, paths or reply text in
   decoration.

## 4. Agent integration

| | Claude | Codex |
|---|---|---|
| Transport | `@anthropic-ai/claude-agent-sdk` `query()` with streaming input, one per open thread (idle-closed after 15 min, resumed on demand) | one `codex.exe app-server` (JSON-RPC/stdio) from the desktop app's install |
| Auth | `ANTHROPIC_API_KEY`, or whatever sign-in the unmodified Claude Code binary finds on the PC | `~/.codex/auth.json` ChatGPT login |
| New thread | pre-assigned `sessionId`, `cwd` = zone | `thread/start {cwd}` |
| Continue desktop thread | `resume`; `forkSession` only while it's open in another app (a live `~/.claude/sessions/<pid>.json`); a turn after it changed elsewhere reloads it | `thread/resume`; `thread/fork` when Codex reports another "active writer". Released 30 s after each turn so the Codex app can continue it |
| Streaming | `stream_event` text/thinking deltas | `item/agentMessage/delta` |
| Objectives | Task*/TodoWrite tool calls (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`) | `turn/plan/updated` |
| Approvals | `canUseTool` (incl. AskUserQuestion, ExitPlanMode) | `item/commandExecution|fileChange|permissions/requestApproval` |
| Modes | default / acceptEdits / plan / auto | untrusted+read-only / on-request+workspace-write / read-only+plan instructions / auto_review |
| Player's config | off by default (`inheritAgentConfig`): `settingSources: []`, `strictMcpConfig`, and the project's `CLAUDE.md` / `.claude/CLAUDE.md` passed as plain-text system prompt (40,000 chars max); on: `settingSources: user, project, local` | off: `features.plugins` and `features.apps` false per thread; `config.toml` MCP servers and rules still load (no per-thread switch); AGENTS.md picked up by Codex |

**Any other agent** (Hermes, Grok Build, Gemini CLI, ...) goes through one generic Agent Client
Protocol backend (`agents/acp.ts`, official TS SDK): one stdio child per provider, one ACP session per
quest; `session/new|resume|load|fork|list|prompt|cancel|set_mode`, model via config option or
`session/set_model`; `session/update` → deltas, tool calls, plan (objectives), usage, title;
`session/request_permission` → in-game approval card. Capabilities are taken from `initialize`;
unsafe modes (yolo, bypass, don't-ask) are never selected. A provider can add a *catalog* of its own
session store for threads started elsewhere (Hermes: read-only `state.db`, incl. messaging-gateway
sessions; sessions ACP can't resume continue as a new session seeded with a digest).

Projects come from the subfolders of your configured project roots (`projectRoots`, empty by
default), Codex desktop projects and recent session folders, merged by path. Paths matching
`exclude` in `config.json` (defaults: `node_modules`, `.git`, temp dirs) and folders containing an
empty `.nofamiliar` file are never offered. Editable in `%APPDATA%\Familiar\config.json`, or from
the control panel's Projects card (a folder dialog; an excluded folder is refused with the reason).

## 5. Safety

* No synthetic input, no window messages or focus changes to WoW, no process access beyond
  `PROCESS_QUERY_LIMITED_INFORMATION` to find the window. Overlay is `WS_EX_TRANSPARENT` +
  `NOACTIVATE` and never takes focus.
* Agents run under the user's normal permissions; default mode **Ask first**; every edit/command
  the agent wants is a request. A zone organises work; it does not contain the agent. A path typed
  in game must be under `projectRoots`, `projects` or a known zone (`Hub.inKnownFolder`, checked
  before and after resolving junctions).
* **Approval authority is main's** (`main/physical.ts`). Any Lua in the client can draw strip
  frames, so a `key approve` or a `click` from the addon is only a hint, and no rectangle the addon
  declares is used to approve. The Glass reports each granting control it painted (`painted`: action,
  button rect, card rect, text hash), only when it is wholly in view and topmost; the Approve control
  of a pinned card is painted only after its request was read to the end. `ApprovalGate` makes a
  card eligible once it has stayed unchanged at the same place for 800 ms while the game or Glass is
  in front and the link is up; a move, a layout change or a reconnect restarts the wait. A proof is
  a fresh press-and-release of the registered Approve key (exact modifiers) within 1.5 s, or, with
  `approveByClick`, a left release inside that painted button by a pointer that entered it after the
  card became eligible. The proof names the action it covers (type, quest, request, decision) and is
  consumed. Option answers, desktop-thread continuation, Retry and Copy need the same click proof
  and work by click even with `approveByClick` off (answers have no key alternative). Deny and Stop
  need none.
* **The game can never change a quest's mode or grant Always.** The hub refuses `allowAlways`
  from the Glass, and the addon has no Mode button; the panel sets the open quest's mode
  (`setSelectedMode`) and the default. The game may change only `sound` and `soundVolume`, and turn
  privacy or autostart on (`FROM_GAME`, `ONLY_ON_FROM_GAME` in `hub.ts`); the addon sends only
  `sound` and `stream`.
* The control panel lists every pending approval (multiple-choice questions stay in the game) and
  shows the whole text before the buttons. A request too long for the in-game card (`cut`) can be
  denied from the game but never approved there; it is approved only in the panel. Only a real
  click or key press in the focused panel window decides (`event.isTrusted`); panel decisions are
  `origin: "panel"`, reachable only from main's control-window IPC.
* A Windows notice (tray balloon) appears for a request raised, or a quest finished, while WoW is
  not in front. It carries no request or reply text (project and quest names only, generic with
  Hide names) and its click only opens the panel.
* Familiar's own network use: the Claude Code download from the npm registry (pinned versions,
  sha512-checked), the user-clicked update check (one GET to GitHub's releases list), and the
  Wowhead Classic page fetch behind Claude chats' map tool (`agents/wowhead.ts`: one NPC, object or
  quest page per call, no cookies). See the README's Privacy & data.
* Transcripts stay on the PC (`%APPDATA%\Familiar`); `FamiliarSync` holds no names and no
  conversation. Nothing goes through Blizzard's servers. Dev test hooks bind to 127.0.0.1, only
  exist with `FAMILIAR_DEV=1` in a source checkout (dead in the installed app and the release ZIP),
  and only answer requests carrying the run's token; requests with an Origin header or another Host
  are refused (`companion/src/main/dev-hooks.ts`).

## 6. Alternatives considered

* **Native-only (claude-wow style):** Screenshot files out, LoD mailbox in. Works in any display
  mode but replies are slot-limited, polled, and plain text; reloads needed every ~200 messages.
* **Overlay-only app (Discord-overlay style):** simplest, but steals focus and isn't "in" the game
  UI (no keybinds, chrome, or in-game slash commands).
* **Keystroke injection:** fastest native path, but it is exactly the input-automation line.

Familiar combines the best parts: native control surface + live overlay + a saved status.

## 7. Known limits (beta)

* Requires **Windowed** or **Windowed (Fullscreen)** (modern WoW has no exclusive fullscreen).
* Capture: Windows.Graphics.Capture on the game window first; if no Runestrip locks within 15 s
  the companion tries capturing the monitor (game must be visible), then backs off for 2 minutes.
* The Glass sits above WoW: WoW frames opened *over* the Familiar window are cut out for known
  frames (tooltips, menus, popups, map…) but unknown ones may be painted over.
* Runestrip is visible (top-left, 256×16 px while sending, 128×4 px idle). Its data cells are
  near-black (levels 0/28/56/84, the only set); in-panel placement is planned once calibrated
  in-game. HDR or a colour filter can run its grey steps together; the Link Doctor then says so.
* Capture runs at 30 fps while the game or the Glass is in front and at 2 fps after 3 s in the
  background or while minimized (main sends the capture page `rate`).
* No live ack channel from the companion to the addon: prompts are sent twice and de-duplicated,
  carry an id, and wait in the addon's outbox (SavedVariables) until `FamiliarSync` lists the id
  (`acked`) — checked at login / `/reload`, with `/fam resend` for the rest. The native status bar
  shows the saved status (only readable when the Glass isn't covering it); `FamiliarSync` carries a
  5-minute heartbeat (`generatedAt`) and `stoppedAt` on a clean quit.

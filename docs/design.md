# Familiar — design proposal

> Talk to your Claude Code and Codex agents from inside World of Warcraft: Forever — across any
> project folder, with live streaming replies and in-game approvals — without leaving the game and
> without automating the game.

## 1. Goals

1. **Never leave the game.** Start, continue, steer and approve agent work from the WoW UI.
2. **Both ecosystems.** Claude Code (Agent SDK) and Codex (ChatGPT/Codex desktop's app-server), with
   the user's existing logins — including continuing threads started in either desktop app.
3. **Any folder.** Pick a project ("zone") from your configured project roots and recent agent history, or type a path
   (`mkdir` to create one), and spawn a new thread there.
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
companion rewrites (`FamiliarSync`) — gives the addon a native, copyable snapshot after `/reload`
or at login, and is the fallback when the Glass cannot be shown.

```
 ┌──────────────── WoW: Forever ────────────────┐        ┌──────────── Familiar companion (Electron) ─────────────┐
 │ Familiar addon (Lua)                         │ pixels │  capture (WGC) → Runestrip decoder → Hub ──► Claude SDK │
 │  • quest-log window, composer, buttons       │ ─────► │                                     │  └──► Codex app- │
 │  • touch surfaces → click/wheel/hover events │        │                                     │       server     │
 │  • Runestrip (top-left, pixel-perfect)       │        │  render model ◄─────────────────────┘                  │
 │  • FamiliarSync snapshot (on /reload)  ◄─────┼─ file ─┤  snapshot writer                                       │
 └──────────────────────────────────────────────┘        │  Glass overlay (click-through, aligned) ──► you        │
                         ▲  you see Glass over the panel  └────────────────────────────────────────────────────────┘
```

## 3. In-game experience

**Window ("Familiar")** — WoW dialog chrome with the imp-familiar icon:

* **Quest Log (left):** zones = projects, quests = threads (✦ Claude, ◈ Codex). Status glyphs
  (◌ working, ! needs approval, ✗ failed), unread dots, desktop-app threads shown dimmed under each
  zone — the same set the desktop apps show (not archived, started by a person, active recently;
  pinned/starred and running threads always). Click a zone to collapse, right-click to start a
  quest there; right-click a quest to abandon it (the session stays in the agent's own history);
  right-click a dimmed thread to hide it. `/fam pin`, `/fam show <agent>` filter what's listed.
* **Quest details (right):** title, zone, status, mode, model, tokens/cost; **Objectives** (the
  agent's live todo/plan list); the transcript (markdown, syntax-highlighted code, collapsible tool
  calls with output); **approval cards** with Approve / Deny / Always (this quest) (or the agent's
  multiple-choice options).
* **Welcome (right pane, nothing selected):** the quest giver. A round portrait of the familiar
  (idle, working, asking, asleep or puzzled, chosen from the render model: link, ready agents, running
  quests, requests waiting on you), "Well met." and who it is linked to, then four quest rows that fit
  the pane: *Ask a game question*, *Work on a project*, *Continue a conversation*, each a name, one dim
  line and its buttons on the right (never a button inside a sentence), and the one-line tutorial
  replay. With no quests it says so and how to wake it; unlinked or with no agent ready the row's line
  says what it cannot see. The portrait is hidden when the pane is too short for it. It is a picture
  only: the page has no hit areas besides its buttons and links.
* **Chats zone (top of the Quest Log):** `+ Chat` / `/fam ask` — talk to a cheap model with web
  search and nothing else (no repo, files or shell), for game questions and lookups; the character's
  class/level/zone go along. Codex desktop chats without a project are listed here too.
* **Composer:** multi-line; Enter sends, Shift+Enter newline, Ctrl+↑/↓ history, Ctrl+V paste.
* **Toolbar:** `+ Claude`, `+ Codex` (zone picker → draft → first message starts the quest),
  `Back`, `Model` (cycle), `Mode` (Ask first ↔ Plan only; Accept edits and Auto are chosen only in
  the desktop control panel), `Text` (native copyable transcript).
* **Bottom bar:** link/agent status; `Approve` `Deny` `Always` `Stop` `Send` (Approve glows when
  something is waiting).

**Visual tokens and button order.** The Glass and the control panel share one token set, defined
in `overlay.css` `:root` and `control.html`: gold `#ffd100` (titles, buttons), gold-dim `#c9a227`,
text `#ece4d4`, text-dim `#bfb6a4`, muted `#9c9384`, ok `#7dd96b`, warn orange `#ff8040`
(approval, unknown), err `#ff5a4f`, info blue `#71d5ff` (working, links), agent glyphs
`#d98a60` (Claude) and `#7fd1a8` (Codex), borders `rgba(143,115,64,.45)`. Type has four sizes,
`--fs-sm` · `--fs-md` · `--fs-lg` · `--fs-xl`, plus `--row-font` for the Quest Log rows. On the Glass
they are ratios of the layout-derived `--small-font` / `--body-font` (small, body, 1.25×, 1.7×),
never absolute pixels, because those carry the 11/10 px floors; the control panel's are fixed at
12 / 14 / 16 / 22 px. Every font size in `overlay.css` and `control.html` is one of those tokens,
`var(--row-font)`, `1em`, `inherit` or the raid toast's `max(…)`; `test/type-scale.test.ts` keeps
anything else out. The display face is for chrome and buttons, the sans face for prose, mono for
code only. State is never colour alone: each status shows a glyph and a word (✓ ! ✗ ◌). The
canonical approval-card order is **Approve · Deny · Always (this quest)**: Approve and Deny are
filled buttons, Always is a ghost button (dashed border, right-aligned) that applies only to the
current quest. Pane rects, `--row-h` and the status/tracker rects come from `Layout.lua`; styling
may add depth inside a rect but never changes its size. Motion has three durations: `--m-fast`
150 ms (state changes), `--m-arrive` 350 ms (arrivals: toast, card, seal, badge, a request on the
panel) and `--m-settle` 600 ms (the Quest Complete moment settling). Nothing is longer and nothing
loops but the caret; reduced motion turns it all off. `test/motion.test.ts` keeps literal
durations out of `overlay.css` and `control.html`.

**Tracker** — a small movable frame like the quest objective tracker: active quests, what each
familiar is doing right now (current objective or tool), progress `3/5`, approvals in orange.
Click a line to open that quest.

**Toasts and sounds** — raid-warning style banners when a quest finishes, fails or needs approval
(optional speech), and six synthesized cues (`shared/cues.ts`: oscillators and filtered noise from
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

**Slash commands** — `/fam` toggle · `/fam <text>` send to the selected quest · `/fam claude <text>`
/ `/fam codex <text>` start a quest in the current zone · `/fam approve|deny|always|stop` ·
`/fam tracker` · `/fam native` · `/fam strip tl|tr|bl|br` · `/fam reload`.

**Keybindings** (Options → Keybindings → AddOns → Familiar): toggle, focus composer, approve,
deny, stop, next/previous quest, tracker. Also: minimap button and the AddOn compartment. The
minimap button wears a small `!` (a request is waiting) or `?` (a reply is unread) at its top-right,
drawn by the Glass on the button's rectangle that the addon reports in the layout message; it takes
no clicks, carries no text, and paints nothing when the rectangle is absent.

**Desktop control panel** (tray → Open Familiar) — everything that must not be reachable from the
game, as three steps and one fold, laid out as a settings page. Top to bottom: **Requests waiting**
(every pending approval, while there is one, each with its whole text in a box that scrolls past
160 px so the next request stays in view; the ones the in-game card cannot show whole carry a badge;
one hint line, "Approve here or in the game. Nothing happens until you click."; see §5); the **step
strip** *Agents · WoW · Link*, each with ✓ and one short line whose whole sentence is its tooltip
(while the link is not up the Link line says *Not linked yet* and the Link Doctor's sentence, from
`main/doctor.ts`, is the journey text under the title, in its own colour), and under it the first
undone step's content (the Familiars card for step 1 and while the first-run choice is open, the
guidance text for steps 2–3, a single "All set" line when everything is done); the **Projects** card
(folders added by hand or as folders of projects; it sits here until a folder has been added, then
moves under Advanced); **In game** — Text size, Stream-safe, Sounds (a volume slider and **Play a
sample**, which plays the six cues one per click in the panel itself, so they can be heard without
the game); and one collapsed **Advanced** section: Familiars (once step 1 is done; it stays above
Advanced while Claude Code is downloading, failed or missing, with its progress and **Retry**; a
*Status* row per familiar says what its backend reports, e.g. "starts when World of Warcraft is
running"), Chat defaults, New quests start in (Accept edits and Auto are chosen only here; a risky
default opens Advanced so its warning box is not hidden, and the box sits under the row, never
folded away), Approve key (what is registered, and a warning for keys also used for playing), Quiet
play, Notices (raid warnings; the Windows notice for a waiting request), Hide names, Companion
controls (including **Check for updates**, a user click that makes one request to GitHub), link
details and logs (including **Save what Familiar sees**, a 320×32 px crop of the strip corner), and
Suggest a change. Each setting is a row: the label with its `/fam` command beneath in mono, the
control, then **one** hint line. A card's longer explanation sits word for word in a closed **How it
works** at its bottom, so moving a sentence there never rewrites it (safety copy included). Buttons
say what they do: red for an action on your behalf (Sign in, Install…, Retry, Keep these choices,
Add a project folder…, Play a sample, Reinstall addon, Open as GitHub issue, and Deny), green for
**Approve** in Requests waiting and nowhere else (the Glass's green), ghost for utilities (Open
config, Reload config, Open log file, Copy diagnostics, Rescan desktop threads, Pause overlay, Check
for updates, Test overlay, Save what Familiar sees), dashed for Always (this quest); Deny never looks
quieter than Approve. The journey and Requests cards are flat (`--card`) with a 2 px rule on top, gold
and warn. The header's mode badge stays outside Advanced as the always-visible safety cue; beside the
title is the running version (`v0.5.0`), and a line beside it says when the addon and the app are
different versions. Journey wording, step lines and state come from `control/journey.ts` (version
and update wording from `control/build.ts`); nothing there changes a setting. Everything that came
from an agent, the game or the network is set as text, never as markup. The header carries a small
portrait that follows the journey (puzzled while the Link step is undone, asking while a request
waits on you, working while Claude Code downloads or a quest runs, otherwise idle; a face whose
picture is missing from the build falls back to idle), over a painted workshop band
(`assets/workshop-1600.jpg`, original art, under a gradient that keeps the title legible).

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
| Project rules | `settingSources: user, project, local` (repo CLAUDE.md applies) | AGENTS.md picked up by Codex |

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
  the agent wants is an in-game approval. Bypass-permissions modes are not reachable from the game.
* The control panel lists every pending approval (multiple-choice questions stay in the game) and
  shows the whole text before the buttons. A request too long for the in-game card (`cut`) can be
  denied from the game but never approved there, even with proof of input; Approve and Always for
  it happen only in the panel. Only a real click or key press in the focused panel window decides
  (`event.isTrusted`; a script-made click does nothing, and nothing is sent automatically); that is
  physical input on the PC by construction, not a path from the game and not a bypass mode.
  Panel decisions are `origin: "panel"`, reachable only from main's control-window IPC.
* A Windows notice (tray balloon) appears for an approval raised while WoW is not in front. It
  carries no request text (project and quest names only, generic with Hide names) and its click
  only opens the panel.
* The companion's own network use is two requests: the Claude Code download from the npm registry
  (pinned versions, sha512-checked) and the user-clicked update check (one GET to GitHub). See the
  README's Privacy & data.
* Transcripts stay on the PC (`%APPDATA%\Familiar`, the WoW `FamiliarSync` file). Nothing goes
  through Blizzard's servers. Dev test hooks bind to 127.0.0.1, only exist with `FAMILIAR_DEV=1`, and
  only answer requests carrying the run's token; requests with an Origin header or another Host are
  refused (`companion/src/main/dev-hooks.ts`).

## 6. Alternatives considered

* **Native-only (claude-wow style):** Screenshot files out, LoD mailbox in. Works in any display
  mode but replies are slot-limited, polled, and plain text; reloads needed every ~200 messages.
* **Overlay-only app (Discord-overlay style):** simplest, but steals focus and isn't "in" the game
  UI (no keybinds, chrome, or in-game slash commands).
* **Keystroke injection:** fastest native path, but it is exactly the input-automation line.

Familiar combines the best parts: native control surface + live overlay + native snapshot.

## 7. Known limits (beta)

* Requires **Windowed** or **Windowed (Fullscreen)** (modern WoW has no exclusive fullscreen).
* Capture: Windows.Graphics.Capture on the game window first; if no Runestrip locks within 15 s
  the companion tries capturing the monitor (game must be visible), then backs off for 2 minutes.
* The Glass sits above WoW: WoW frames opened *over* the Familiar window are cut out for known
  frames (tooltips, menus, popups, map…) but unknown ones may be painted over.
* Runestrip is visible (top-left, 256×16 px while sending, 128×4 px idle). A dim palette and
  in-panel placement are planned once calibrated in-game.
* No live ack channel from the companion to the addon: prompts are sent twice and de-duplicated,
  carry an id, and wait in the addon's outbox (SavedVariables) until `FamiliarSync` lists the id
  (`acked`) — checked at login / `/reload`, with `/fam resend` for the rest. The native status bar
  says "Familiar isn't running" (it's only readable when the Glass isn't covering it);
  `FamiliarSync` carries a 5-minute heartbeat (`generatedAt`) and `stoppedAt` on a clean quit.

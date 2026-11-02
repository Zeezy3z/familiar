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
  calls with output); **approval cards** with Approve / Always / Deny (or the agent's
  multiple-choice options).
* **Chats zone (top of the Quest Log):** `+ Chat` / `/fam ask` — talk to a cheap model with web
  search and nothing else (no repo, files or shell), for game questions and lookups; the character's
  class/level/zone go along. Codex desktop chats without a project are listed here too.
* **Composer:** multi-line; Enter sends, Shift+Enter newline, Ctrl+↑/↓ history, Ctrl+V paste.
* **Toolbar:** `+ Claude`, `+ Codex` (zone picker → draft → first message starts the quest),
  `Back`, `Model` (cycle), `Mode` (Ask first ↔ Plan only; Accept edits and Auto are chosen only in
  the desktop control panel), `Text` (native copyable transcript).
* **Bottom bar:** link/agent status; `Approve` `Deny` `Always` `Stop` `Send` (Approve glows when
  something is waiting).

**Tracker** — a small movable frame like the quest objective tracker: active quests, what each
familiar is doing right now (current objective or tool), progress `3/5`, approvals in orange.
Click a line to open that quest.

**Toasts** — raid-warning style banners when a quest finishes, fails or needs approval, plus a
synthesized chime (optional speech).

**Slash commands** — `/fam` toggle · `/fam <text>` send to the selected quest · `/fam claude <text>`
/ `/fam codex <text>` start a quest in the current zone · `/fam approve|deny|always|stop` ·
`/fam tracker` · `/fam native` · `/fam strip tl|tr|bl|br` · `/fam reload`.

**Keybindings** (Options → Keybindings → AddOns → Familiar): toggle, focus composer, approve,
deny, stop, next/previous quest, tracker. Also: minimap button and the AddOn compartment.

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
empty `.nofamiliar` file are never offered. Editable in `%APPDATA%\Familiar\config.json`.

## 5. Safety

* No synthetic input, no window messages or focus changes to WoW, no process access beyond
  `PROCESS_QUERY_LIMITED_INFORMATION` to find the window. Overlay is `WS_EX_TRANSPARENT` +
  `NOACTIVATE` and never takes focus.
* Agents run under the user's normal permissions; default mode **Ask first**; every edit/command
  the agent wants is an in-game approval. Bypass-permissions modes are not reachable from the game.
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

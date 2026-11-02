# Research: how far can a WoW: Forever addon go?

Research run 2026-10-03, against the WoW: Forever beta client (then installed in the
`_classic_beta_` folder as WowB.exe, build 1.60.1.70009; the live client uses `_forever_`).

## TL;DR

* **Forever is a Mainline-family client.** Internal game type `camelot`, Interface **16001**, retail
  (12.1.x) UI architecture and API, including the Midnight-era addon restrictions (secret values,
  combat-log lockdown, Lua CPU budgets). It is *not* Classic-API: plan for `C_*` namespaces,
  `BackdropTemplate`, `SetResizeBounds`, `C_EncodingUtil` (native JSON), AddonCompartment, etc.
* **Addons are sealed.** No sockets, no `io`/`os`, no `loadfile`/`require`, no clipboard access
  (`CopyToClipboard` is protected). The only ways bytes leave: pixels on screen, files the *client*
  writes (SavedVariables on reload/logout, `Screenshot()`, logs), and sound.
* **Bytes coming in are harder still.** Lua files are read when an addon loads (login, `/reload`,
  or `C_AddOns.LoadAddOn` of a load-on-demand addon — once per UI session per addon). Files created
  after the client starts are invisible until a restart. Assets are cached for the process.
* **Prior art exists on Forever:** `rdimascio/wow-ai` ("claude-wow", MIT) ships an addon ↔ Claude
  Code/Codex bridge using `Screenshot()` files outbound and 200 pre-created LoD "mailbox" slots
  inbound; `0xinuarashi/wow-forever-codex` reads replies out of glyph widths of 65 535
  pre-created font files. Both are native-only and therefore slot-limited and slow.

## Channels considered

| Direction | Channel | Verdict |
|---|---|---|
| out | **Pixel strip read by live window capture (WGC)** | ✅ chosen. 30 fps, ~2–5 KB/s, no player action, works covered/background. Needs windowed or windowed-fullscreen (modern WoW has no exclusive fullscreen). |
| out | `Screenshot()` + read PNG | Bit-exact and works fullscreen, but ~1 s/latency, disk churn, visible "screen captured" flow. Kept as a future fallback. |
| out | SavedVariables | Only on `/reload`/logout. Fallback only. |
| out | Chat log / whisper-to-self | Routes through Blizzard servers or flushes in 2–48 KB blocks. Rejected. |
| in  | **Click-through overlay window over the game** ("Glass") | ✅ chosen for live content. Real-time, rich (markdown, code, diffs), zero interaction with the game process. |
| in  | Data addon file read at login / `/reload` (WeakAuras-Companion pattern) | ✅ chosen for the native snapshot (`FamiliarSync`). |
| in  | LoD mailbox slots + deleted-file signals | Works (claude-wow measured it) but single-use per UI session, 200+ folders in the AddOns list. Not needed given the overlay; possible future native fallback. |
| in  | Synthetic keystrokes into an addon edit box | ❌ rejected: input automation is the line Blizzard enforces; also steals focus. |

## Facts that shaped the design (with sources)

* TOC: `## Interface: 16001`; Forever resolves `_Camelot.toc` → `_Mainline.toc` → `.toc`; comma
  lists allowed. — warcraft.wiki.gg/wiki/TOC_format; Forever FrameXML (`Gethe/wow-ui-source`,
  branch `forever`); crash dumps in `_classic_beta_\Errors` (`engineSurveyPatch 16001`).
* Pixel-perfect drawing: `frame:SetIgnoreParentScale(true); frame:SetScale(768 / physicalHeight)`
  makes 1 unit = 1 physical pixel; `SetColorTexture` with alpha 1. — used live on Forever by
  claude-wow; `PixelUtil`.
* `/run` and `/dump` can be blocked in the beta (`C_AddOns.GetScriptsDisallowedForBeta`), so the
  addon exposes its own `/fam` diagnostics.
* `ReloadUI()` / `C_UI.Reload()` need a hardware event (click/keypress), not a timer.
* Electron `desktopCapturer` window capture uses Windows.Graphics.Capture, draws no yellow border
  by default, captures occluded windows, and delivers I420 frames (2×2 chroma) — cells must be ≥4 px
  and sampled at their centres. Measured on this PC: ~29 fps, `VideoFrame.copyTo(rect)` ≈ 0.08 ms,
  100% decode.
* A topmost transparent click-through window over a borderless D3D12 game stays on top and does
  not take focus (`setIgnoreMouseEvents(true)` without `forward`, `focusable:false`,
  `WS_EX_TOOLWINDOW`). Cost: DWM composition while visible, so Glass hides itself when idle.
* Policy: the EULA's bot clause targets software that "allows the automated control of a Game";
  2024–25 statements target input broadcasting and client modification. Reading pixels and drawing
  a separate window touch neither. Lowest-risk order (claude-wow's survey): SavedVariables +
  reload < reading client logs < `Screenshot()` files < continuous screen capture < chat through
  Blizzard servers. Familiar sits at "continuous screen capture" with **no input** of any kind.
* Agents: Codex desktop ships `codex.exe app-server` (JSON-RPC over stdio; threads, turns,
  streaming items, plan updates, approval server-requests, `project/list`, shared `~/.codex` state).
  Claude Code via `@anthropic-ai/claude-agent-sdk` 0.3.x: streaming-input `query()`, `canUseTool`
  approvals, `listSessions`/`getSessionMessages` across the desktop app's sessions, subscription
  auth from the logged-in CLI. Note: omitted `permissionMode` now means `auto` — Familiar passes
  `default` explicitly.

Raw research reports (WoW API limits, agent backends, capture/overlay prototype) are summarized
here; prototypes lived in the session scratchpad and are reproduced by the code in this repo.

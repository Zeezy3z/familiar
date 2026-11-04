# Runestrip protocol (v1)

Shared by `addon/Familiar/Link.lua` and `companion/src/link/codec.ts`; parity is enforced by
`companion/test/codec.test.ts` (the Lua is executed in fengari and compared cell-for-cell).

## Geometry

* A grid of `cols × rows` square cells, `cell` physical pixels each (default 64×4 @ 4 px; idle
  beacon 32×1). Anchored to a screen corner of `UIParent` with `SetIgnoreParentScale(true)` and
  `SetScale(768 / physicalHeight)` so one unit is one physical pixel. Frame strata `TOOLTIP`.
* Cells are read row-major. The first 8 cells of row 0 are fixed:

| # | colour | role |
|---|---|---|
| 0 | (255,0,255) magenta | finder |
| 1 | (0,255,0) green | finder |
| 2 | (0,0,0) | calibration level 0 |
| 3 | (85,85,85) | calibration level 1 |
| 4 | (170,170,170) | calibration level 2 |
| 5 | (255,255,255) | calibration level 3 |
| 6 | (0,255,255) cyan | finder |
| 7 | (255,255,0) yellow | finder |

* Every other cell carries one 6-bit symbol: 2 bits each of R, G, B at levels 0/85/170/255.
  The decoder classifies each channel to the nearest *measured* calibration level, so monotonic
  gamma/brightness/contrast curves and capture colour conversion are absorbed.
* Bytes pack into symbols big-endian: 3 bytes → 4 symbols.

## Frame

```
 0  MAGIC 0x46 ('F')
 1  VERSION 1
 2  cols
 3  rows
 4  seq (u16, increments for every new frame drawn)
 6  flags (bit0 IDLE, bit1 REPEAT)
 7  msgId (u16)
 9  chunkIdx
10  chunkCount
11  payload length (u16)
13  payload …
 …  CRC-16/CCITT-FALSE over bytes 0..13+len-1 (u16)
```

Capacity = ⌊(cols·rows − 8)·6/8⌋ bytes; a 64×4 strip carries 171 payload bytes per frame.

## Timing and reliability

* Each frame stays on screen ≥ `hold` (70 ms) **and** ≥ 2 rendered frames, so a 30 fps capture
  sees every frame at least once.
* There is no back-channel. Messages flagged *reliable* (prompts, keys, clicks) are transmitted
  twice; the companion de-duplicates by `msgId + CRC(payload) + length` for 30 s (a `msgId` reused
  after `/reload` with different content still goes through).
* Keyed messages (`layout`, `hello`, `hover`) replace any not-yet-sent message with the same key.
* Idle: a 32×1 beacon whose `seq` ticks once a second — the companion uses it to know the UI is
  visible and where the strip is.

## Decoding (companion)

1. Capture the game window (WGC via Electron `desktopCapturer`), frames pinned to the window size.
2. Search the client's top-left area every 250 ms (whole frame every 2 s) for a magenta edge; sweep
   pitches (integers first) and sub-pixel origins until the 8-cell finder verifies at cell centres.
3. `acquire`: try nearby pitches/origins until a frame passes CRC; keep the lock and decode only a
   small region around it per captured frame (≈0.1 ms).
4. After 3 consecutive CRC failures, re-acquire around the lock; if the finder disappears, search.

## Messages (payload = UTF-8 JSON, `v: 1`)

| `t` | fields | meaning |
|---|---|---|
| `hello` | addon, build, iface, char, realm, locale, syncAt, viewKeys? | sent at login and every 20 s |
| `layout` | scr[w,h], px, fpx, panel, native, focus?, drag, combat, ui, win/list/detail/status/tracker rects `[x,y,w,h]` (physical px, client origin top-left), rowH, keys{name:rect}, occ[rects], op (window background opacity %, omitted at 100) | where the Glass may paint; on change and every 4 s |
| `prompt` | text, id, ctx? | composer / `/fam <text>`; `id` is handled once (resends are dropped) and echoed in `FamiliarSync.acked` |
| `quick` | agent, text, id | `/fam claude|codex <text>` |
| `quests` | text? | empty text means no quests; omitted text means context sharing is off/unavailable. The quest log, one line per quest with objective progress (`[x]`/`[ ]`); sent when it changes (debounced 4 s) and every 5 min; read-only; used by chats |
| `ask` | text, id, new?, ctx? | `/fam ask [new] <text>`: continue the latest chat (or start one). `ctx` (also on `prompt`): one line of character context, "level 20 Night Elf Rogue (Alliance) in Darkshore - Auberdine"; used for chats only |
| `key` | k ∈ newClaude, newCodex, back, mode, model, native, approve, deny, always, stop, next, prev, tools, pin, hide, hidden, unhide, show, autostart, newChat, stream, tutorial; optional `view` (`full`/`focus`, see below), optional `a` (argument, e.g. `show` → "claude,codex" / "all"; `stream` → "on" / "off" / ""), `src` (`button` / `bind` / `slash`). approve / always / mode are acted on only when the companion matches them to physical input on the PC; `src` only tells it which check to run | buttons, keybinds, slash |
| `click` | r (list/detail/tracker/status), x, y (0..1 within the region), b (L/R) | hit-tested by the Glass |
| `wheel` | r, d (accumulated notches); `d` ≤ −9999 on `detail` means jump to the latest reply and follow | scroll the Glass region; sent by the mouse wheel and by the Scroll keybindings |
| `hover` | r, x, y (−1 = left) | hover highlight, low priority |
| `dragstart` | kind (move/size), target (win/tracker), rect, cx, cy, min?, max? | a Familiar frame is being dragged or resized: its rect, the cursor and the resize limits (physical px). The companion then follows the OS cursor itself (read-only) until `dragstop` |
| `dragstop` | | the drag ended; the exact `layout` follows |

Queue priority: everything is **urgent** (sent ahead of background traffic, keeping its own order)
except `quests`, `hello` and `hover`. Chunks of different messages may interleave; the companion
reassembles per message id.

A prompt's acknowledgement means Familiar handled the message, not that a provider accepted it.
Before starting the provider, Familiar saves the prompt in its quest/chat transcript. If provider
initialization fails, it saves an error and setup guidance in that same transcript and catch-up
notes. The original message ID remains acknowledged across reloads, so an outbox resend does not
retry it. After fixing provider setup, the player can recall the prompt with Ctrl+Up and Send to
submit a new message ID; Familiar never retries it automatically.

## FamiliarSync fields (companion → addon, read at login / `/reload`)

`generatedAt` (companion clock, epoch s; rewritten at least every 5 min), `stoppedAt` (clean quit),
`acked` (ids of handled `prompt`/`quick`/`ask` messages), `providers` (agent ids for
`/fam <id> <text>` and `/fam show <id>`), `list` (Quest Log rows), `selected` (native transcript), `fontScale` (text size 0.8–1.6; optional).

`fontScale` is the companion's text size setting. At login the addon adopts it when present (clamped to
0.8–1.6, steps of 0.1) and sizes the native quest-list rows to `round(16 × fontScale)` — the Glass
sizes its row text from `layout.rowH`, so both follow. A change in the control panel therefore reaches
the quest list after the next `/reload`. `/fam font …` also applies the size to the list at once in
the addon (same words as the companion: bigger, smaller, reset, 80–160) and still sends the `font`
key, so the companion's setting stays the source after the next login. Without a snapshot the addon
keeps the last size `/fam font` set (`FamiliarDB.fontScale`).


## Unfinished composer recovery (local only)

The addon saves one unfinished composer draft in `FamiliarCharDB`, declared with
`SavedVariablesPerCharacter`. This is scoped by WoW to the current account/realm/character;
existing `FamiliarDB` settings, submitted history and outbox retain their schema. Text is stored
as typed (including escaped pipes), never sent during save/restore, and limited to 65,536 bytes.
Oversized edits remain in the composer with a warning; the last complete bounded version remains
saved and is identified as such after reload. WoW persists SavedVariables on ordinary logout or
`/reload`, not continuously to disk or reliably after a crash/forced exit.

A saved draft restores only into an empty composer with a visible check-the-message-target cue.
It does not bind to a conversation: the addon has no live selection downlink, and `FamiliarSync`'s
selected transcript is only a snapshot. A current draft is never overwritten by restore.
Ctrl+Up/Down previews do not replace the underlying saved draft; editing a recalled message does.
Deleting all composer text, `/fam draft discard`, or a successful `SendTracked` enqueue clears the
composer draft. An enqueue failure keeps it, and outbox acknowledgement reconciliation never
modifies it. Successful enqueue means queued locally, not provider receipt or acceptance.

## Conversation-only focus view

`layout.focus` is presentation state; it never authorizes a decision. Focus-capable addon key
messages carry their current `view: "full" | "focus"` on every key path, including slash commands.
Approve/Deny/Always in focus can act only on a pending request in the selected conversation;
a request elsewhere produces Full view guidance. `hello.viewKeys: 1` or any provided key context
monotonically identifies a focus-capable addon for this Hub lifetime. Missing context then blocks
all decision keys, even after a delayed legacy hello. A truly older addon on a fresh Hub retains
legacy missing-context behavior; hot-downgrading an addon requires a companion restart to restore
that legacy fallback. Any provided value other than `full` or `focus` blocks all
approval, desktop-confirmation and held-message decisions. Do not infer key context from layout,
which may still be queued. Explicit request-ID-bound card decisions keep their existing semantics.
Glass Stop carries the displayed thread ID and is rejected if the selection or running/pending
state has changed before handling it.

The native Focus / Full view button, unassigned FAMILIAR_VIEW binding and `/fam view focus|full`
change only presentation. The normal Log binding and `/fam log` remain separate. Focus crops the
list and top chrome at the current detail width (324-unit minimum, versus 560 full); the normal
720-unit window becomes 484 units. Both sizes are addon UI units and scale with WoW. Screen
clamping may change position. Glass preserves its message anchor through header/layout changes.
At very narrow widths with large text, the compact title/Continue/Details row may wrap rather than
clip controls; the selected font size is unchanged. Details reveals the full title, context,
handoff destination and objectives. Other-conversation review is read-only and never acknowledges
updates or changes the target. The native composer remains the same widget with the same draft.

Full view restores the pre-focus geometry, log state and tracker visibility even after a focus
resize/drag. Focus geometry never replaces saved full-view settings. Closing/reopening preserves
focus for that session; login or `/reload` starts in full view. New/Back/project-start commands
restore full view, and next/previous retain focus with a check-target cue for an existing draft.
The native Full view button and fallback snapshot warning remain available without Glass. Focus
does not change Quiet play, permissions, provider behavior or catch-up records.

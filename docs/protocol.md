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
| 3 | (28,28,28) | calibration level 1 |
| 4 | (56,56,56) | calibration level 2 |
| 5 | (84,84,84) | calibration level 3 |
| 6 | (0,255,255) cyan | finder |
| 7 | (255,255,0) yellow | finder |

* Every other cell carries one 6-bit symbol: 2 bits each of R, G, B at levels 0/28/56/84. This is
  the only level set (there is no palette setting); it is kept low because a full-range ramp clips
  on clients that draw the strip brighter than asked.
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
* Keyed messages (`layout`, `hello`, `quests`) replace any not-yet-sent message with the same key.
* Idle: a 32×1 beacon whose `seq` ticks once a second — the companion uses it to know the UI is
  visible and where the strip is.

## Decoding (companion)

1. Capture the game window (WGC via Electron `desktopCapturer`), frames pinned to the window size,
   at 30 fps while the game or the Glass is in front and 2 fps after 3 s in the background or while
   minimized (main sends the capture page `rate { fps }`; the stream is not restarted).
2. While unlocked, search the four client corners every 250 ms (each search starts at the next
   corner) and the whole frame every 2 s, within a 40 ms budget, for a magenta edge; sweep pitches
   (integers first) and sub-pixel origins until the 8-cell finder verifies at cell centres.
3. The finder is judged against colours measured in the finder itself: magenta, green, cyan and
   yellow each light two channels and leave one dark, so every channel has a measured on and off
   level whatever the client's gain, gamma or tint. The grey ramp (cells 2–5) gives the four
   measured levels per channel; symbols are classified against their midpoints, then refined from
   the cells read as each level.
4. If two ramp steps read the same (a rise under 3 on any channel), the result is `ramp`: the strip
   is there but cannot be read, usually HDR or a colour filter. A `ramp` miss keeps the lock and is
   reported over other misses; the Link Doctor names it.
5. `acquire`: try nearby pitches/origins until a frame passes CRC; only a CRC-verified frame locks.
   Keep the lock and decode only a small region around it per captured frame.
6. After 3 consecutive CRC failures, re-acquire around the lock; if the finder disappears, search.

## Messages (payload = UTF-8 JSON, `v: 1`)

| `t` | fields | meaning |
|---|---|---|
| `hello` | addon, build, iface, char, realm, locale, syncAt, viewKeys? | sent at login and every 20 s |
| `layout` | scr[w,h], px, fpx, panel, focus? (compact view), drag, combat, ui, win/list/detail/status/tracker rects `[x,y,w,h]` (physical px, client origin top-left), mini (the minimap button's rect, same units; omitted while it is not visible), rowH, keys{stop: rect} (for the glow only; never used to approve), occ[rects] (frames above the window, tracker or minimap button, including the `+ Quest` menu), op (window background opacity %, omitted at 100) | where the Glass may paint; on change, every 3.5 s while the window is open, every 15 s while it is closed |
| `prompt` | text, id, ctx? | composer / `/fam <text>`; `id` is handled once (resends are dropped) and echoed in `FamiliarSync.acked` |
| `quick` | agent, text, id | `/fam claude|codex <text>` |
| `quests` | text? | empty text means no quests; omitted text means context sharing is off/unavailable. The quest log, one line per quest with objective progress (`[x]`/`[ ]`); sent when it changes (debounced 4 s) and every 5 min; read-only; used by chats |
| `ask` | text, id, new?, ctx? | `/fam ask [new] <text>`: continue the latest chat (or start one). `ctx` (also on `prompt`): one line of character context, "level 20 Night Elf Rogue (Alliance) in Darkshore - Auberdine"; used for chats only |
| `key` | k ∈ new (with `a` = familiar id), newClaude, newCodex, newChat, back, model, approve, deny, stop, next, prev, archive, unarchive, open, tools, tutorial, show, stream, sound; `view` (`full`/`focus`, see below); optional `a` (`show` → "claude,codex" / "all"; `stream` → "on"; `sound` → "on" / "off" / "0-100"); `src` (`button` / `bind` / `slash`). `approve` acts only with main's proof for the pinned card (the Approve key; design §5); `stream` and `sound` pass the hub's settings gate (the game may only turn privacy on). Other keys are ignored | buttons, keybinds, slash |
| `click` | r (list/detail/tracker/status), x, y (0..1 within the region), b (L/R) | hit-tested by the Glass |
| `wheel` | r, d (accumulated notches); `d` ≤ −9999 on `detail` means jump to the latest reply and follow | scroll the Glass region; sent by the mouse wheel and by the Scroll keybindings |
| `dragstart` | kind (move/size), target (win/tracker), rect, cx, cy, min?, max? | a Familiar frame is being dragged or resized: its rect, the cursor and the resize limits (physical px). The companion then follows the OS cursor itself (read-only) until `dragstop` |
| `dragstop` | | the drag ended; the exact `layout` follows |

Removed: the `hover` message, and the keys `mode`, `native`, `always`, `pin`, `hide`, `hidden`,
`unhide`, `autostart`, `font`, `caughtup`, `suggest`, `quiet`, `private` and `warnings`.

Queue priority: everything is **urgent** (sent ahead of background traffic, keeping its own order)
except `quests` and `hello`. Chunks of different messages may interleave; the companion
reassembles per message id.

A prompt's acknowledgement means Familiar handled the message, not that a provider accepted it.
Before starting the provider, Familiar saves the prompt in its quest/chat transcript. If provider
initialization fails, it saves an error and setup guidance in that same transcript and catch-up
notes. The original message ID remains acknowledged across reloads, so an outbox resend does not
retry it. After fixing provider setup, the player can recall the prompt with Ctrl+Up and Send to
submit a new message ID; Familiar never retries it automatically.

## FamiliarSync fields (companion → addon, read at login / `/reload`)

A timestamp and a status, never the conversation and never quest titles; every write replaces the
whole file. `generatedAt` (companion clock, epoch s; rewritten at least every 5 min), `stoppedAt`
(clean quit), `acked` (the last 60 ids of handled `prompt`/`quick`/`ask` messages), `fontScale`
(the control panel's text size, 0.8–1.6; the addon sizes quest-list rows to `round(16 × fontScale)`
at login), `providers` (ids of familiars switched on, for `/fam <id> <text>`, `/fam show` and the
`+ Quest` menu), `notice` (saved-quests storage guidance, free of names and message text; optional).
The addon derives one of three states from it: never ran, closed at `stoppedAt`, or saved at
`generatedAt`.

## Companion-internal messages

Not on the strip: Electron IPC between main and its renderers, listed here because they carry the
capture rate and approval authority.

| channel | direction | fields | meaning |
|---|---|---|---|
| `rate` | main → capture | fps | cap the running capture track (30 in front, 2 in the background) |
| `painted` | Glass → main | list of { act, rect, card, sig } | the granting buttons the Glass has on screen (fractions of its window; `sig` hashes the card text); the only rectangles approvals use; at most 16 |
| `approve` | main → Glass | byClick, key | how a card offers approval: an Approve button (`approveByClick`) or "Press <key> to approve" |

## Unfinished composer recovery (local only)

The addon saves one unfinished composer draft in `FamiliarCharDB`, declared with
`SavedVariablesPerCharacter`. This is scoped by WoW to the current account/realm/character;
existing `FamiliarDB` settings, submitted history and outbox retain their schema. Text is stored
as typed (including escaped pipes), never sent during save/restore, and limited to 65,536 bytes.
Oversized edits remain in the composer with a warning; the last complete bounded version remains
saved and is identified as such after reload. WoW persists SavedVariables on ordinary logout or
`/reload`, not continuously to disk or reliably after a crash/forced exit.

A saved draft restores only into an empty composer with a visible check-the-message-target cue.
It does not bind to a conversation: the addon has no live selection downlink, and `FamiliarSync`
names no conversation. A current draft is never overwritten by restore.
Ctrl+Up/Down previews do not replace the underlying saved draft; editing a recalled message does.
Deleting all composer text, the **Discard** button, or a successful `SendTracked` enqueue clears the
composer draft. An enqueue failure keeps it, and outbox acknowledgement reconciliation never
modifies it. Successful enqueue means queued locally, not provider receipt or acceptance.

## Compact view (`focus`)

`layout.focus` is presentation state; it never authorizes a decision. Focus-capable addon key
messages carry their current `view: "full" | "focus"` on every key path, including slash commands.
Approve/Deny in focus can act only on a pending request in the selected conversation;
a request elsewhere produces Full view guidance. `hello.viewKeys: 1` or any provided key context
monotonically identifies a focus-capable addon for this Hub lifetime. Missing context then blocks
all decision keys, even after a delayed legacy hello. A truly older addon on a fresh Hub retains
legacy missing-context behavior; hot-downgrading an addon requires a companion restart to restore
that legacy fallback. Any provided value other than `full` or `focus` blocks all
approval, desktop-confirmation and held-message decisions. Do not infer key context from layout,
which may still be queued. Explicit request-ID-bound card decisions keep their existing semantics.
Glass Stop carries the displayed thread ID and is rejected if the selection or running/pending
state has changed before handling it.

The native view button cycles Full → Quest only (quest list hidden, remembered; also `/fam log`)
→ Compact (`focus`, this session only) → Full, and changes only presentation. Focus crops the
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
The view button and the saved status remain available without the Glass. Compact does not change
permissions, provider behavior or catch-up records.

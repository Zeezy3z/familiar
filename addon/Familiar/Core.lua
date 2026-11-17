-- Familiar core: saved settings, the outgoing message API, events and slash commands.
-- The addon is a "terminal": it owns the in-game chrome and input, transmits everything over the
-- Runestrip, and lets Familiar on the PC paint live content on top (the Glass).
local ADDON, ns = ...

ns.VERSION = (C_AddOns and C_AddOns.GetAddOnMetadata or GetAddOnMetadata)(ADDON, "Version") or "dev"
-- Bindings.xml needs a global. Export only what it calls, as wrappers: nothing here reaches ns,
-- Send, Link or the saved settings. Any addon can still call these, so each is exactly what a
-- keypress does and nothing more (Familiar verifies approvals against real input anyway).
local BIND_KEYS = { approve = true, deny = true, stop = true, next = true, prev = true }
_G.Familiar = {
  Toggle = function() ns.UI.Toggle() end,
  Focus = function() ns.UI.Focus() end,
  Key = function(k) if BIND_KEYS[k] then ns.UI.Key(k, "bind") end end,
}

BINDING_HEADER_FAMILIAR = "Familiar"
BINDING_NAME_FAMILIAR_TOGGLE = "Open or close the Familiar window"
BINDING_NAME_FAMILIAR_FOCUS = "Type to your familiar (puts the keyboard in the message box)"
BINDING_NAME_FAMILIAR_APPROVE = "Approve the pending request"
BINDING_NAME_FAMILIAR_DENY = "Deny the pending request"
BINDING_NAME_FAMILIAR_STOP = "Stop the running turn"
BINDING_NAME_FAMILIAR_NEXT = "Next quest"
BINDING_NAME_FAMILIAR_PREV = "Previous quest"

local defaults = {
  stripPos = "TOPLEFT",
  window = { point = "CENTER", x = 0, y = 40, w = 720, h = 440 },
  shown = false,
  tracker = { shown = true, point = "RIGHT", x = -60, y = 120, w = 240, h = 150 },
  minimap = { angle = 210 },
  fontScale = 1, -- quest list text size, 0.8-1.6 (the control panel's Text size, adopted at login)
  opacity = 100, -- window background, percent (Options -> AddOns -> Familiar)
  sendFocus = "game", -- after Send, keys go back to the game ("stay": keep typing in the message box)
  logCollapsed = false, -- the quest list is hidden (view button, /fam log)
  history = {},
  outbox = {}, -- prompts not yet confirmed by Familiar (see ns.SendTracked)
  chatContext = true, -- tell chats your class, level, location and quest log (/fam ask context off)
  -- Optional, absent until used: logExpandedW (window width before the quest list was hidden),
  -- outboxDropped (prompts pushed out of a full outbox, reported at the next login).
}
-- Keys older versions saved that are no longer settings: the Runestrip's protocol constants
-- (Link.lua owns them), the palette, and options that had no way to set them.
local RETIRED = { "palette", "stripInset", "cell", "cols", "rows", "hold", "hover", "hideInCombat", "enterSends" }

-- A text size read from FamiliarSync or saved settings: 0.8-1.6 in steps of 0.1; unusable means 100%.
local FONT_MIN, FONT_MAX = 0.8, 1.6
function ns.SanitizeFontScale(v)
  v = tonumber(v)
  if not v or v ~= v then return 1 end
  return math.floor(math.min(FONT_MAX, math.max(FONT_MIN, v)) * 10 + 0.5) / 10
end

local function applyDefaults(dst, src)
  for k, v in pairs(src) do
    if type(v) == "table" then
      if type(dst[k]) ~= "table" then dst[k] = {} end
      applyDefaults(dst[k], v)
    elseif dst[k] == nil then
      dst[k] = v
    end
  end
end

-- Outgoing messages -----------------------------------------------------------------------------
-- reliable: transmitted twice (Familiar de-duplicates). key: coalesce with queued same-key.
-- Guard: run a handler protected. The first failure is reported once (chat + Familiar's log) and
-- the handler switches itself off, so a bug can never spam errors every frame or tooltip.
local reported = {}
function ns.Guard(name, fn, keepAlive)
  local dead = false
  return function(...)
    if dead then return end
    local ok, err = pcall(fn, ...)
    if ok then return end
    if not keepAlive then dead = true end
    if reported[name] then return end
    reported[name] = true
    err = tostring(err)
    pcall(function()
      DEFAULT_CHAT_FRAME:AddMessage("|cff9d7cffFamiliar|r: |cffff5a4f" .. name .. " failed" .. (keepAlive and "" or " and was switched off") .. ": " .. err .. "|r")
    end)
    pcall(ns.Send, { t = "error", where = name, err = err }, true)
  end
end

local encodeJSON = (C_EncodingUtil and C_EncodingUtil.SerializeJSON) or ns.Json.encode

-- WoW edit boxes escape a typed "|" as "||"; familiars must receive what the player typed.
function ns.Unescape(text)
  return (text:gsub("||", "|"))
end

-- Background messages wait behind everything the player is doing right now.
local BACKGROUND = { quests = true, hello = true }

function ns.Send(msg, reliable, key)
  msg.v = 1
  local ok, payload = pcall(encodeJSON, msg)
  if not ok then payload = ns.Json.encode(msg) end
  return ns.Link.Enqueue(payload, { reliable = reliable, key = key, urgent = not BACKGROUND[msg.t] })
end

-- Saved status ----------------------------------------------------------------------------------
-- FamiliarSync is written by Familiar on the PC and read only at login / reload: a timestamp and
-- a status, never the conversation. This is everything the addon can know about Familiar without
-- the Glass: "never" (no saved status: it has not run), "closed" (it said so when it quit), or
-- "saved" (it was running when this was saved; the game window may merely be inactive now).
local function when(t) return date("%Y-%m-%d %H:%M", tonumber(t) or 0) end
function ns.SavedState()
  local d = FamiliarSyncData
  if type(d) ~= "table" then
    return "never", "Familiar isn't running on your PC - start it there",
      "No saved status: Familiar hasn't run on your PC yet. Start it there; it shows your quests over this window."
  elseif d.stoppedAt then
    return "closed", "Familiar was closed " .. when(d.stoppedAt) .. " - start it on your PC",
      "Familiar was closed on " .. when(d.stoppedAt) .. ". Start it on your PC to see your quests here."
  end
  return "saved", "Saved " .. when(d.generatedAt) .. " - not live",
    "Saved " .. when(d.generatedAt) .. ". Live view resumes when the game window is active; if it does not, open Familiar from the tray."
end

-- Familiar is known not to be running (as of login / reload).
function ns.AppClosed() return ns.SavedState() ~= "saved" end

-- Outbox -----------------------------------------------------------------------------------------
-- Nothing tells the addon live whether Familiar is reading the Runestrip. So prompts get an id and
-- stay in FamiliarDB.outbox until Familiar lists that id in FamiliarSync (read at login / reload).
-- Whatever is left can be resent on request; Familiar ignores ids it already handled.
local idSeq = 0
function ns.SendTracked(msg)
  idSeq = idSeq + 1
  msg.id = ("%x%04x%x"):format(GetServerTime(), math.random(0, 0xffff), idSeq)
  if not ns.Send(msg, true) then return false end
  local box = ns.db.outbox
  box[#box + 1] = { id = msg.id, t = msg.t, agent = msg.agent, text = msg.text, new = msg.new, ctx = msg.ctx, at = GetServerTime() }
  while #box > 20 do
    table.remove(box, 1)
    -- Reported at the next login only if something did go missing (see reconcileOutbox).
    ns.db.outboxDropped = (ns.db.outboxDropped or 0) + 1
  end
  return true
end

-- One line about the character for chats ("level 20 Night Elf Rogue (Alliance) in Darkshore -
-- Auberdine"). Only read from the game's own API; Familiar uses it for chats only.
function ns.GameContext()
  if not ns.db.chatContext then return nil end
  local ok, ctx = pcall(function()
    local level = UnitLevel("player")
    local class = UnitClass("player")
    local race = UnitRace("player")
    local faction = UnitFactionGroup("player")
    local zone, sub = GetZoneText(), GetSubZoneText()
    local where = zone or ""
    if sub and sub ~= "" and sub ~= zone then where = where .. " - " .. sub end
    return ("level %s %s %s%s%s"):format(tostring(level or "?"), race or "", class or "",
      faction and (" (" .. faction .. ")") or "", where ~= "" and (" in " .. where) or "")
  end)
  return ok and ctx or nil
end

-- At login / reload: drop what Familiar confirmed and tell the player about the rest. Nothing is
-- sent again unless the player asks (/fam resend).
local function reconcileOutbox()
  local data = type(FamiliarSyncData) == "table" and FamiliarSyncData or nil
  local acked = {}
  for _, id in ipairs(data and data.acked or {}) do acked[id] = true end
  local now = GetServerTime()
  local keep, missed, expired = {}, 0, 0
  for _, m in ipairs(ns.db.outbox) do
    if acked[m.id] then
      -- it arrived
    elseif now - (m.at or 0) >= 86400 then
      expired = expired + 1
    else
      keep[#keep + 1] = m
      -- Missed for sure if a status saved after it doesn't list it, or Familiar was closed /
      -- silent (it saves at least every 5 min) when it was sent.
      local after = data and data.generatedAt and data.generatedAt >= (m.at or 0) + 5
      local down = not data or (data.stoppedAt and data.stoppedAt <= (m.at or 0) + 5) or now - (data.generatedAt or 0) > 600
      if after or down then missed = missed + 1 end
    end
  end
  ns.db.outbox = keep
  if missed > 0 then
    ns.Print(("|cffff9d2e%d message%s did not reach Familiar on your PC.|r /fam resend sends %s again (to the quest selected then), /fam discard drops %s."):format(
      missed, missed > 1 and "s" or "", missed > 1 and "them" or "it", missed > 1 and "them" or "it"))
  end
  -- Messages pushed out of a full outbox are older than the ones kept. If all of those arrived,
  -- so (almost certainly) did these; if some didn't, these may not have either.
  local dropped = expired + ((missed > 0 or expired > 0) and (ns.db.outboxDropped or 0) or 0)
  ns.db.outboxDropped = nil
  if dropped > 0 then
    ns.Print(("|cffff9d2e%d older message%s dropped|r from the outbox (it keeps the newest 20, for a day) and can't be resent."):format(
      dropped, dropped > 1 and "s were" or " was"))
  end
  local state, short = ns.SavedState()
  if state ~= "saved" then ns.Print(short .. ".") end
end
ns.ReconcileOutbox = reconcileOutbox

local function resend()
  local n = 0
  for _, m in ipairs(ns.db.outbox) do
    -- Same id: Familiar drops it if the first copy did arrive after all.
    if ns.Send({ t = m.t, id = m.id, agent = m.agent, text = m.text, new = m.new, ctx = m.ctx }, true) then n = n + 1 end
  end
  ns.Print(n > 0 and ("resent %d message%s."):format(n, n > 1 and "s" or "") or "nothing to resend.")
end

function Familiar_OnCompartmentClick(_, button)
  if button == "RightButton" then ns.Tracker.Toggle() else ns.UI.Toggle() end
end

-- The familiar's own face (media/familiar.tga, 64x64): the minimap button and the window title use it.
-- No file extension: the client tries .blp, then .tga. If the client refuses it, the game's owl icon is
-- loaded by path exactly as before, so the worst case is the old look; /fam diag says which is in use.
ns.ICON = "Interface\\AddOns\\Familiar\\media\\familiar"
ns.ICON_FALLBACK = "Interface\\Icons\\Ability_Hunter_Pet_Owl"
function ns.SetIcon(tex)
  local ok = tex:SetTexture(ns.ICON)
  if ok and tex:GetTexture() then ns.iconSource = "own"; return "own" end
  tex:SetTexture(ns.ICON_FALLBACK)
  tex:SetTexCoord(0.05, 0.95, 0.05, 0.95) -- only the spell icon needs its square bevel trimmed
  ns.iconSource = "fallback"
  return "fallback"
end

function ns.Print(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
  DEFAULT_CHAT_FRAME:AddMessage("|cff9d7cffFamiliar|r: " .. table.concat(parts, " "))
end

local function hello()
  local version, build, _, iface = GetBuildInfo()
  ns.Send({
    t = "hello",
    addon = ns.VERSION,
    build = version .. "." .. build,
    iface = iface,
    char = UnitName("player"),
    realm = GetRealmName(),
    locale = GetLocale(),
    syncAt = type(FamiliarSyncData) == "table" and FamiliarSyncData.generatedAt or 0,
  }, false, "hello")
end

-- Events ----------------------------------------------------------------------------------------
local ev = CreateFrame("Frame")
local function initStep(name, fn) ns.Guard("init " .. name, fn)() end
ev:RegisterEvent("ADDON_LOADED")
ev:RegisterEvent("PLAYER_LOGIN")
ev:RegisterEvent("PLAYER_LOGOUT")
ev:RegisterEvent("PLAYER_REGEN_DISABLED")
ev:RegisterEvent("PLAYER_REGEN_ENABLED")
ev:SetScript("OnEvent", ns.Guard("events", function(_, event, arg1)
  if event == "ADDON_LOADED" and arg1 == ADDON then
    FamiliarDB = FamiliarDB or {}
    for _, k in ipairs(RETIRED) do FamiliarDB[k] = nil end
    if type(FamiliarDB.minimap) == "table" then FamiliarDB.minimap.hide = nil end
    applyDefaults(FamiliarDB, defaults)
    ns.db = FamiliarDB
    -- WoW scopes this file to the current account / realm / character. The saved status never
    -- names a conversation, so an unsent message box is never bound to one.
    if type(FamiliarCharDB) ~= "table" then FamiliarCharDB = {} end
    ns.charDB = FamiliarCharDB
  elseif event == "PLAYER_LOGIN" then
    -- The control panel's text size is the source at login (so it reaches the quest list after a
    -- /reload); without a saved status, keep the last size.
    local synced = type(FamiliarSyncData) == "table" and FamiliarSyncData.fontScale
    ns.db.fontScale = ns.SanitizeFontScale(synced or ns.db.fontScale)
    -- Each module starts independently: one failing must not take the others (or the link) down.
    initStep("link", ns.Link.Init)
    initStep("window", ns.UI.Init)
    initStep("tracker", ns.Tracker.Init)
    initStep("minimap", ns.Minimap.Init)
    initStep("options", ns.Options.Init)
    initStep("layout", ns.Layout.Init)
    initStep("hello", hello)
    initStep("outbox", reconcileOutbox)
    initStep("quests", ns.Quests.Init)
    C_Timer.NewTicker(20, ns.Guard("hello", hello, true))
    if ns.db.shown and ns.UI.frame then initStep("show", ns.UI.Show) end
    ns.Print("ready - /fam to open, /fam help for commands.")
  elseif event == "PLAYER_LOGOUT" then
    -- SavedVariables are written after this event on ordinary logout and /reload.
    if ns.UI.SaveDraft then ns.UI.SaveDraft() end
  elseif event == "PLAYER_REGEN_DISABLED" or event == "PLAYER_REGEN_ENABLED" then
    ns.inCombat = event == "PLAYER_REGEN_DISABLED"
    ns.Layout.Dirty()
  end
end, true))

-- Slash commands --------------------------------------------------------------------------------
-- One table: each verb has an argument check, a handler and one help line (verbs that share a
-- line share its text). Anything that is not a verb and has more than one word is a message for
-- the selected quest. A single unknown word, or a verb with arguments it doesn't take, never
-- reaches a familiar: it prints the closest verb or that verb's usage.

-- Familiars: Claude and Codex always, plus whatever Familiar has installed (Hermes, Grok...), as
-- listed in the last saved status.
local function IsProvider(word)
  if word == "claude" or word == "codex" then return true end
  for _, id in ipairs(type(FamiliarSyncData) == "table" and FamiliarSyncData.providers or {}) do
    if id == word then return true end
  end
  return false
end

local function IsAgentFilter(rest)
  if rest == "" then return false end
  for word in rest:lower():gmatch("[^%s,]+") do
    if word ~= "all" and not IsProvider(word) then return false end
  end
  return true
end

local function viewName() return ns.UI.focusMode and "focus" or "full" end
local function setting(k, a) ns.Send({ t = "key", k = k, a = a, view = viewName() }, true) end
local function key(k) return function() ns.UI.Key(k, "slash") end end

local NONE = function(rest) return rest == "" end
local ANY = function() return true end
local function oneOf(...)
  local ok = {}
  for i = 1, select("#", ...) do ok[select(i, ...)] = true end
  return function(rest) return ok[rest:lower()] == true end
end

local HELP_FIRST = {
  "/fam - open or close the window; /fam <message> - send it to the selected quest",
  "/fam claude | codex <message> - start a new quest with that familiar (others too, when installed)",
}
local H = {
  ask = "/fam ask <question> - chat with no zone (game questions, web search); ask new <question> starts a fresh chat; ask context on | off",
  decide = "/fam stop | deny - stop the running turn / deny the pending request (approve with your Approve key)",
  panes = "/fam tracker | log - show or hide the quest tracker / the quest list",
  stream = "/fam stream - turn Stream-safe on: names hidden, replies veiled on the Glass (turn it off in the control panel)",
  sound = "/fam sound [on | off | 0-100] - chimes when a quest finishes, needs approval or fails",
  quest = "/fam archive | unarchive | open - archive the selected quest / restore archived ones / continue it in its familiar's own app",
  outbox = "/fam resend | discard - send again / drop messages that did not reach Familiar",
  misc = "/fam tutorial | reload | diag | strip tl | tr | bl | br - practice quest / reload the UI / diagnostics / move the Runestrip",
  more = "/fam show all | claude | codex, tools, focus game | stay - filter the quest list / tool call detail / where keys go after Send",
}

local function diag()
  local version, build, _, iface = GetBuildInfo()
  local w, h = GetPhysicalScreenSize()
  ns.Print(("client %s.%s (interface %s) - addon %s"):format(version, build, tostring(iface), ns.VERSION))
  ns.Print(("screen %dx%d px - UI scale %.3f - Runestrip %s %dx%d @%dpx scale %.4f - queue %d"):format(
    w, h, UIParent:GetEffectiveScale(), ns.db.stripPos, ns.Link.cols, ns.Link.rows, ns.Link.cell,
    ns.Link.frame and ns.Link.frame:GetEffectiveScale() or 0, ns.Link.QueueDepth()))
  -- Which frames are under the cursor (and do they take the mouse wheel)? Helps diagnose scrolling.
  local names = {}
  for i, f in ipairs(GetMouseFoci() or {}) do
    local ok, desc = pcall(function()
      return (f:GetName() or ("<" .. f:GetObjectType() .. ">")) .. (f:IsMouseWheelEnabled() and "+wheel" or "")
    end)
    names[i] = ok and desc or "?"
  end
  ns.Print("icon: " .. (ns.iconSource == "own" and "own" or ns.iconSource == "fallback" and "fallback (game icon)" or "not drawn"))
  local mini = ns.Layout.prect(ns.Minimap.button)
  ns.Print(mini and ("minimap: %d,%d %d\195\151%d"):format(mini[1], mini[2], mini[3], mini[4]) or "minimap: hidden")
  ns.Print("under cursor: " .. (#names > 0 and table.concat(names, ", ") or "nothing"))
  local _, short = ns.SavedState()
  ns.Print(("native JSON %s - %s - window %s - tracker %s"):format(
    (C_EncodingUtil and C_EncodingUtil.SerializeJSON) and "yes" or "no", short,
    ns.UI.IsShown() and "open" or "closed", ns.Tracker.IsShown() and "shown" or "hidden"))
end

local CORNERS = { tl = "TOPLEFT", tr = "TOPRIGHT", bl = "BOTTOMLEFT", br = "BOTTOMRIGHT" }
local function strip(rest)
  local pos = CORNERS[rest:lower()]
  if pos then
    ns.db.stripPos = pos
    ns.Link.ApplyGeometry()
  end
  local w, h = GetPhysicalScreenSize()
  ns.Print(("Runestrip %s, %dx%d cells @ %dpx, queue %d - screen %dx%d px - UI scale %.3f - strip scale %.4f"):format(
    ns.db.stripPos, ns.Link.cols, ns.Link.rows, ns.Link.cell, ns.Link.QueueDepth(), w, h,
    UIParent:GetEffectiveScale(), ns.Link.frame and ns.Link.frame:GetEffectiveScale() or 0))
end

local function ask(rest)
  local lower = rest:lower()
  if lower == "context off" or lower == "context on" then
    ns.db.chatContext = lower == "context on"
    ns.Print(ns.db.chatContext and "chats will know your class, level, location and quest log." or "chats no longer get your class, level, location or quest log.")
    ns.Send({ t = "quests", text = ns.db.chatContext and ns.Quests.Snapshot() or nil }, false, "quests")
  elseif rest == "" then
    ns.UI.Key("newChat", "slash")
    ns.UI.Show()
  else
    ns.UI.SetFocusMode(false)
    local fresh, text = false, rest
    if lower:match("^new%s") then fresh, text = true, strtrim(rest:sub(5)) end
    ns.UI.SendTyped({ t = "ask", text = ns.Unescape(text), new = fresh or nil, ctx = ns.GameContext() }, text, "asking...")
  end
end

local printHelp
local VERBS = {
  -- Help with words is still help; a sentence after it gets the same hint as other verbs'.
  { "help", ANY, function(rest)
    printHelp()
    if rest:find("%s") then ns.Print("To send that as a message, type it in the Familiar window.") end
  end },
  { "ask", ANY, ask, H.ask },
  { "stop", NONE, key("stop"), H.decide },
  { "deny", NONE, key("deny"), H.decide },
  { "tracker", NONE, function() ns.Tracker.Toggle() end, H.panes },
  { "log", NONE, function() ns.UI.ToggleLog() end, H.panes },
  -- The game may only turn Stream-safe on; turning it off is a control panel choice.
  { "stream", oneOf("", "on"), function() setting("stream", "on") end, H.stream },
  { "sound", function(rest) return oneOf("", "on", "off")(rest) or rest:match("^%d+%%?$") ~= nil end,
    function(rest) setting("sound", rest:lower()) end, H.sound },
  { "archive", NONE, key("archive"), H.quest },
  { "unarchive", NONE, key("unarchive"), H.quest },
  { "open", NONE, key("open"), H.quest },
  { "resend", NONE, resend, H.outbox },
  { "discard", NONE, function()
    local n = #ns.db.outbox
    ns.db.outbox = {}
    ns.Print(("dropped %d unsent message%s."):format(n, n == 1 and "" or "s"))
  end, H.outbox },
  { "tutorial", NONE, function()
    -- Familiar selects the practice quest; make sure the window is open to show it.
    ns.UI.SetFocusMode(false)
    ns.UI.Key("tutorial", "slash")
    ns.UI.Show()
  end, H.misc },
  { "reload", NONE, function() C_UI.Reload() end, H.misc },
  { "diag", NONE, diag, H.misc },
  { "strip", oneOf("", "tl", "tr", "bl", "br"), strip, H.misc },
  -- No other way to set these three: the quest list filter is remembered by Familiar, tool call
  -- detail and keyboard-after-Send have no control panel switch.
  { "show", IsAgentFilter, function(rest) setting("show", rest:lower()) end, H.more },
  { "tools", NONE, key("tools"), H.more },
  { "focus", oneOf("", "game", "stay"), function(rest)
    if rest ~= "" then ns.db.sendFocus = rest:lower() end
    ns.Print(ns.db.sendFocus == "stay" and "after Send, you keep typing in Familiar (/fam focus game to change)." or "after Send, your keys go back to the game (/fam focus stay to change).")
  end, H.more },
}
local BY_NAME = {}
for _, v in ipairs(VERBS) do BY_NAME[v[1]] = v end

-- Verbs that left /fam: say where each went, so an old habit ("/fam autostart off") is never sent
-- to a familiar as a message.
local MOVED = {
  approve = "approve with your Approve key (register it in the control panel)",
  always = "\"Always\" is in the control panel only",
  autostart = "starting with Windows is in the control panel",
  warnings = "notice style is in the control panel",
  quiet = "holding notices is in the control panel (Play -> Notifications)",
  font = "text size is in the control panel",
  opacity = "window opacity is in Options -> AddOns -> Familiar",
  private = "/fam stream turns Stream-safe on; Hide names alone is in the control panel",
  suggest = "Suggest a change is in the control panel",
  native = "the window keeps a saved status only; the conversation shows on the Glass",
  view = "use the view button at the bottom left of the window",
  draft = "use the Discard button above the message box",
  caughtup = "use Caught up on the Glass",
}

function printHelp()
  for _, line in ipairs(HELP_FIRST) do ns.Print(line) end
  local seen = {}
  for _, v in ipairs(VERBS) do
    if v[4] and not seen[v[4]] then
      seen[v[4]] = true
      ns.Print(v[4])
    end
  end
end

-- Edit distance, for "did you mean".
local function distance(a, b)
  local prev = {}
  for j = 0, #b do prev[j] = j end
  for i = 1, #a do
    local cur = { [0] = i }
    for j = 1, #b do
      cur[j] = math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a:byte(i) == b:byte(j) and 0 or 1))
    end
    prev = cur
  end
  return prev[#b]
end

local function closest(word)
  local best, bestD = "help", math.huge
  local names = { "claude", "codex" }
  for _, v in ipairs(VERBS) do names[#names + 1] = v[1] end
  for _, name in ipairs(names) do
    local d = distance(word, name)
    if d < bestD then best, bestD = name, d end
  end
  return best
end

SLASH_FAMILIAR1 = "/fam"
SLASH_FAMILIAR2 = "/familiar"
SlashCmdList.FAMILIAR = function(input)
  input = strtrim(input or "")
  if input == "" then return ns.UI.Toggle() end
  local cmd, rest = input:match("^(%S+)%s*(.-)$")
  cmd = cmd:lower()
  if MOVED[cmd] then return ns.Print(("/fam %s is gone: %s."):format(cmd, MOVED[cmd])) end
  local verb = BY_NAME[cmd]
  if verb then
    if verb[2](rest) then return verb[3](rest) end
    -- A sentence that happens to start with a command word ("/fam stop doing that"): say how to send it.
    return ns.Print("usage: " .. (verb[4] or HELP_FIRST[1])
      .. (rest:find("%s") and " - to send that as a message, type it in the Familiar window." or ""))
  end
  if IsProvider(cmd) then
    if rest == "" then return ns.Print("usage: " .. HELP_FIRST[2]) end
    ns.UI.SetFocusMode(false)
    return ns.UI.SendTyped({ t = "quick", agent = cmd, text = ns.Unescape(rest) }, rest, "summoning " .. cmd .. "...")
  end
  if rest == "" then
    return ns.Print(('Unknown command "%s" - did you mean /fam %s? /fam help lists commands. To send one word to your quest, type it in the Familiar window.'):format(
      cmd, closest(cmd)))
  end
  ns.UI.SendPrompt(input)
end

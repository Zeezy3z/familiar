-- Familiar core: saved settings, the outgoing message API, events and slash commands.
-- The addon is a "terminal": it owns the in-game chrome and input, transmits everything over the
-- Runestrip, and lets the companion paint live content on top (the Glass overlay).
local ADDON, ns = ...

ns.VERSION = (C_AddOns and C_AddOns.GetAddOnMetadata or GetAddOnMetadata)(ADDON, "Version") or "dev"
-- Bindings.xml needs a global. Export only what it calls, as wrappers: nothing here reaches ns,
-- Send, Link or the saved settings. Any addon can still call these, so each is exactly what a
-- keypress does and nothing more (the companion verifies approvals against real input anyway).
local BIND_KEYS = { approve = true, deny = true, stop = true, next = true, prev = true }
_G.Familiar = {
  Toggle = function() ns.UI.Toggle() end,
  Focus = function() ns.UI.Focus() end,
  Key = function(k) if BIND_KEYS[k] then ns.UI.Key(k, "bind") end end,
  ToggleTracker = function() ns.Tracker.Toggle() end,
  ToggleLog = function() ns.UI.ToggleLog() end,
  ToggleView = function() ns.UI.ToggleFocusMode() end,
}

BINDING_HEADER_FAMILIAR = "Familiar"
BINDING_NAME_FAMILIAR_TOGGLE = "Toggle Familiar window"
BINDING_NAME_FAMILIAR_FOCUS = "Speak to your familiar (focus composer)"
BINDING_NAME_FAMILIAR_APPROVE = "Approve pending request"
BINDING_NAME_FAMILIAR_DENY = "Deny pending request"
BINDING_NAME_FAMILIAR_STOP = "Stop the running turn"
BINDING_NAME_FAMILIAR_NEXT = "Next quest"
BINDING_NAME_FAMILIAR_PREV = "Previous quest"
BINDING_NAME_FAMILIAR_TRACKER = "Toggle quest tracker"
BINDING_NAME_FAMILIAR_VIEW = "Toggle conversation-only focus view"
BINDING_NAME_FAMILIAR_LOG = "Collapse / expand the quest log"

local defaults = {
  stripPos = "TOPLEFT",
  palette = "vivid", -- "dim" = near-black data cells (try once the link is confirmed working)
  stripInset = 0,
  cell = 4,
  cols = 64,
  rows = 4,
  hold = 0.07,
  window = { point = "CENTER", x = 0, y = 40, w = 720, h = 440 },
  shown = false,
  tracker = { shown = true, point = "RIGHT", x = -60, y = 120, w = 240, h = 150 },
  minimap = { angle = 210, hide = false },
  opacity = 100, -- window background, percent (Options -> AddOns -> Familiar, /fam opacity)
  hideInCombat = false,
  hover = false, -- stream hover positions to the Glass (more strip traffic)
  enterSends = true,
  sendFocus = "game", -- after Send, keys go back to the game ("stay": keep typing in the composer)
  history = {},
  outbox = {}, -- prompts not yet confirmed by the companion (see ns.SendTracked)
  chatContext = true, -- tell chats your class / level / zone (/fam ask context off)
}

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
-- reliable: transmitted twice (the companion de-duplicates). key: coalesce with queued same-key.
-- Guard: run a handler protected. The first failure is reported once (chat + companion log) and
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

-- WoW edit boxes escape a typed "|" as "||"; agents must receive what the player typed.
function ns.Unescape(text)
  return (text:gsub("||", "|"))
end

-- Background messages wait behind everything the player is doing right now.
local BACKGROUND = { quests = true, hello = true, hover = true }

function ns.Send(msg, reliable, key)
  msg.v = 1
  local ok, payload = pcall(encodeJSON, msg)
  if not ok then payload = ns.Json.encode(msg) end
  return ns.Link.Enqueue(payload, { reliable = reliable, key = key, urgent = not BACKGROUND[msg.t] })
end

-- Outbox -----------------------------------------------------------------------------------------
-- Nothing tells the addon live whether the companion is reading the Runestrip. So prompts get an
-- id and stay in FamiliarDB.outbox until the companion lists that id in FamiliarSync (read at
-- login / reload). Whatever is left can be resent; the companion ignores ids it already handled.
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
-- Auberdine"). Only read from the game's own API; the companion uses it for chats only.
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

-- At login / reload: drop what the companion confirmed and tell the player about the rest.
local function reconcileOutbox()
  local data = FamiliarSyncData
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
      -- Missed for sure if a snapshot written after it doesn't list it, or the companion was
      -- closed / silent (heartbeat every 5 min) when it was sent.
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
  if data and data.stoppedAt then
    ns.Print(("the companion was closed at %s - start Familiar on your PC."):format(date("%H:%M", data.stoppedAt)))
  elseif not data then
    ns.Print("start Familiar on your PC to talk to your agents (it paints over this window).")
  end
end
ns.ReconcileOutbox = reconcileOutbox

local function resend()
  local n = 0
  for _, m in ipairs(ns.db.outbox) do
    -- Same id: the companion drops it if the first copy did arrive after all.
    if ns.Send({ t = m.t, id = m.id, agent = m.agent, text = m.text, new = m.new, ctx = m.ctx }, true) then n = n + 1 end
  end
  ns.Print(n > 0 and ("resent %d message%s."):format(n, n > 1 and "s" or "") or "nothing to resend.")
end

function Familiar_OnCompartmentClick(_, button)
  if button == "RightButton" then ns.Tracker.Toggle() else ns.UI.Toggle() end
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
    viewKeys = 1, -- every native key carries its own full/focus context
    build = version .. "." .. build,
    iface = iface,
    char = UnitName("player"),
    realm = GetRealmName(),
    locale = GetLocale(),
    syncAt = FamiliarSyncData and FamiliarSyncData.generatedAt or 0,
  }, false, "hello")
end
ns.Hello = hello

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
    applyDefaults(FamiliarDB, defaults)
    ns.db = FamiliarDB
    -- WoW scopes this file to the current account / realm / character. Never bind an unsent
    -- composer to FamiliarSync.selected: that snapshot is not a live conversation target.
    if type(FamiliarCharDB) ~= "table" then FamiliarCharDB = {} end
    ns.charDB = FamiliarCharDB
    ns.Link.cols, ns.Link.rows, ns.Link.cell, ns.Link.hold = ns.db.cols, ns.db.rows, ns.db.cell, ns.db.hold
    ns.Link.SetPalette(ns.db.palette)
  elseif event == "PLAYER_LOGIN" then
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
  elseif event == "PLAYER_REGEN_DISABLED" then
    ns.inCombat = true
    if ns.db.hideInCombat then ns.UI.Hide(true) end
    ns.Layout.Dirty()
  elseif event == "PLAYER_REGEN_ENABLED" then
    ns.inCombat = false
    if ns.db.hideInCombat and ns.db.shown then ns.UI.Show() end
    ns.Layout.Dirty()
  end
end, true))

-- Slash commands --------------------------------------------------------------------------------
local HELP = {
  "/fam - toggle the Familiar window",
  "/fam <message> - send a message to the selected quest (thread)",
  "/fam claude <message> | /fam codex <message> - start a new quest with that familiar (also hermes, grok... when installed)",
  "/fam deny | stop - act on the selected quest (approve / always: click the card, or your Approve keybind)",
  "Mode button - permission mode for the selected quest: Ask first <-> Plan only. Accept edits and Auto are chosen in the desktop control panel.",
  "/fam tracker - toggle the quest tracker",
  "/fam view focus | full - conversation-only view, or restore full controls (session only)",
  "/fam log - collapse / expand the quest log (just the quest you're in)",
  "/fam strip [tl|tr|bl|br] - move the Runestrip (link) to a screen corner",
  "/fam strip dim | vivid - near-black or colourful Runestrip",
  "/fam reload - reload the UI to pull a fresh native snapshot",
  "/fam diag - print link/screen diagnostics",
  "/fam tools - tool calls: grouped / every step / hidden",
  "/fam pin - pin or unpin the selected desktop thread (listed even when old)",
  "/fam open - continue the selected quest in its agent's own app (Claude or Codex); Familiar lets go of it first",
  "/fam archive - archive the selected quest or thread (or right-click it); also in Codex/Hermes",
  "/fam unarchive - restore everything archived from Familiar; /fam archived counts them",
  "/fam show all | claude | codex - filter the Quest Log by agent",
  "/fam ask <question> - chat (no project, web search): game questions, anything; /fam ask new <q> starts a fresh chat",
  "/fam ask context on | off - include your class, level, zone and quest log in chats",
  "/fam resend | discard - send again / drop messages that did not reach the PC",
  "/fam draft discard - clear the unfinished composer draft for this character",
  "/fam autostart [on | off] - start Familiar with Windows (in the tray)",
  "/fam quiet [on | off] - defer ordinary completion notices; approvals and failures remain",
  "/fam caughtup - mark the selected quest's saved update caught up (never approves a request)",
  "/fam font bigger | smaller | reset | 80-160 - text size in the Familiar window",
  "/fam opacity [0-100] - window background opacity; no number opens Options -> AddOns -> Familiar",
  "/fam sound [on | off] - chimes when a quest finishes, needs approval or fails",
  "/fam warnings [on | off] - notices as raid warnings (mid-screen) or small in the Familiar window",
  "/fam native - toggle native (copyable) view of the current transcript",
  "/fam focus [game | stay] - after sending, give the keyboard back to the game (default) or keep typing",
}

local KEYWORDS = { approve = true, deny = true, always = true, stop = true }
-- Commands that take no argument; with extra words the line is a prompt ("/fam help me fix X").
local COMMANDS = { help = true, diag = true, tracker = true, native = true, reload = true, sync = true, tools = true, caughtup = true,
  pin = true, hide = true, hidden = true, unhide = true, resend = true, discard = true,
  archive = true, unarchive = true, archived = true, log = true, open = true }
-- No-argument commands handled by the companion.
local COMPANION_KEYS = { caughtup = true, tools = true, pin = true, hide = true, hidden = true, unhide = true,
  archive = true, unarchive = true, archived = true, open = true }
local STRIP_ARGS = { [""] = true, tl = true, tr = true, bl = true, br = true, dim = true, vivid = true }
-- "/fam font bigger" sets the text size; "/fam font is too small, why" is a prompt.
local FONT_WORDS = { [""] = true, bigger = true, smaller = true, larger = true, reset = true, default = true, up = true, down = true, ["+"] = true, ["-"] = true }
local function IsFontArg(rest)
  rest = rest:lower()
  return FONT_WORDS[rest] or rest:match("^%d+%%?$") ~= nil
end

-- "/fam show claude,codex" filters the Quest Log; "/fam show me the diff" is a prompt.
-- Providers: Claude and Codex always, plus whatever the companion has installed (Hermes, Grok...),
-- as listed in the last FamiliarSync snapshot.
local function IsProvider(word)
  if word == "claude" or word == "codex" then return true end
  for _, id in ipairs(FamiliarSyncData and FamiliarSyncData.providers or {}) do
    if id == word then return true end
  end
  return false
end

local function IsAgentFilter(rest)
  for word in rest:lower():gmatch("[^%s,]+") do
    if word ~= "all" and not IsProvider(word) then return false end
  end
  return true
end

SLASH_FAMILIAR1 = "/fam"
SLASH_FAMILIAR2 = "/familiar"
SlashCmdList.FAMILIAR = function(input)
  input = strtrim(input or "")
  local cmd, rest = input:match("^(%S+)%s*(.-)$")
  cmd = cmd and cmd:lower()
  if input == "" then
    ns.UI.Toggle()
  elseif COMMANDS[cmd] and rest ~= "" then
    ns.UI.SendPrompt(input)
  elseif cmd == "strip" and not STRIP_ARGS[rest] then
    ns.UI.SendPrompt(input)
  elseif cmd == "help" then
    for _, line in ipairs(HELP) do ns.Print(line) end
  elseif KEYWORDS[cmd] and rest == "" then
    ns.UI.Key(cmd, "slash")
  elseif cmd == "view" and (rest:lower() == "focus" or rest:lower() == "full") then
    ns.UI.SetFocusMode(rest:lower() == "focus")
    ns.UI.Show()
  elseif IsProvider(cmd) then
    ns.UI.SetFocusMode(false)
    if ns.UI.SendTyped({ t = "quick", agent = cmd, text = ns.Unescape(rest) }, rest) then ns.Print("summoning " .. cmd .. "...") end
  elseif cmd == "focus" and (rest == "" or rest:lower() == "game" or rest:lower() == "stay") then
    if rest ~= "" then ns.db.sendFocus = rest:lower() end
    ns.Print(ns.db.sendFocus == "stay" and "after sending, you keep typing in Familiar (/fam focus game to change)." or "after sending, your keys go back to the game (/fam focus stay to change).")
  elseif cmd == "ask" then
    local lower = rest:lower()
    if lower == "context off" or lower == "context on" then
      ns.db.chatContext = lower == "context on"
      ns.Print(ns.db.chatContext and "chats will know your class, level, zone and quest log." or "chats no longer get your class, level, zone or quest log.")
      ns.Send({ t = "quests", text = ns.db.chatContext and ns.Quests.Snapshot() or nil }, false, "quests")
    elseif rest == "" then
      ns.UI.Key("newChat", "slash")
      ns.UI.Show()
    else
      ns.UI.SetFocusMode(false)
      local fresh, text = false, rest
      if lower:match("^new%s") then fresh, text = true, strtrim(rest:sub(5)) end
      if ns.UI.SendTyped({ t = "ask", text = ns.Unescape(text), new = fresh or nil, ctx = ns.GameContext() }, text) then ns.Print("asking...") end
    end
  elseif cmd == "draft" and rest:lower() == "discard" then
    ns.UI.DiscardDraft()
  elseif cmd == "resend" then
    resend()
  elseif cmd == "discard" then
    local n = #ns.db.outbox
    ns.db.outbox = {}
    ns.Print(("dropped %d unsent message%s."):format(n, n == 1 and "" or "s"))
  elseif (cmd == "autostart" or cmd == "sound" or cmd == "warnings" or cmd == "quiet") and (rest == "" or rest:lower() == "on" or rest:lower() == "off") then
    ns.Send({ t = "key", k = cmd, a = rest:lower(), view = ns.UI.focusMode and "focus" or "full" }, true)
  elseif cmd == "font" and IsFontArg(rest) then
    ns.Send({ t = "key", k = "font", a = rest:lower(), view = ns.UI.focusMode and "focus" or "full" }, true)
  elseif cmd == "opacity" and (rest == "" or rest:match("^%d+%%?$")) then
    if rest == "" then ns.Options.Open() else ns.Options.SetOpacity(rest:match("%d+")) end
    ns.Print(("window background opacity %d%%."):format(ns.db.opacity))
  elseif cmd == "diag" then
    local version, build, _, iface = GetBuildInfo()
    local w, h = GetPhysicalScreenSize()
    ns.Print(("client %s.%s (interface %s) - addon %s"):format(version, build, tostring(iface), ns.VERSION))
    ns.Print(("screen %dx%d px - UI scale %.3f - strip %s %s %dx%d @%dpx scale %.4f - queue %d"):format(
      w, h, UIParent:GetEffectiveScale(), ns.db.stripPos, ns.db.palette, ns.Link.cols, ns.Link.rows, ns.Link.cell,
      ns.Link.frame and ns.Link.frame:GetEffectiveScale() or 0, ns.Link.QueueDepth()))
    -- Which frames are under the cursor (and do they take the mouse wheel)? Helps diagnose scrolling.
    local foci = GetMouseFoci() or {}
    local names = {}
    for i, f in ipairs(foci or {}) do
      local ok, desc = pcall(function()
        return (f:GetName() or ("<" .. f:GetObjectType() .. ">")) .. (f:IsMouseWheelEnabled() and "+wheel" or "")
      end)
      names[i] = ok and desc or "?"
    end
    ns.Print("under cursor: " .. (#names > 0 and table.concat(names, ", ") or "nothing"))
    ns.Print(("native JSON %s - snapshot %s - window %s - tracker %s"):format(
      (C_EncodingUtil and C_EncodingUtil.SerializeJSON) and "yes" or "no",
      FamiliarSyncData and date("%H:%M:%S", FamiliarSyncData.generatedAt or 0) or "none",
      ns.UI.IsShown() and "open" or "closed", ns.Tracker.IsShown() and "shown" or "hidden"))
  elseif cmd == "tracker" then
    ns.Tracker.Toggle()
  elseif cmd == "log" and rest == "" then
    ns.UI.ToggleLog()
  elseif COMPANION_KEYS[cmd] then
    ns.UI.Key(cmd, "slash")
  elseif cmd == "show" and IsAgentFilter(rest) then
    ns.Send({ t = "key", k = "show", a = rest:lower(), view = ns.UI.focusMode and "focus" or "full" }, true)
  elseif cmd == "native" then
    ns.UI.ToggleNative()
  elseif cmd == "reload" or cmd == "sync" then
    C_UI.Reload()
  elseif cmd == "strip" then
    local map = { tl = "TOPLEFT", tr = "TOPRIGHT", bl = "BOTTOMLEFT", br = "BOTTOMRIGHT" }
    if map[rest] then
      ns.db.stripPos = map[rest]
      ns.Link.ApplyGeometry()
    elseif rest == "dim" or rest == "vivid" then
      ns.db.palette = rest
      ns.Link.SetPalette(rest)
    end
    local w, h = GetPhysicalScreenSize()
    ns.Print(("Runestrip %s, %dx%d cells @ %dpx, queue %d - screen %dx%d px - UI scale %.3f - strip scale %.4f"):format(
      ns.db.stripPos, ns.Link.cols, ns.Link.rows, ns.Link.cell, ns.Link.QueueDepth(), w, h,
      UIParent:GetEffectiveScale(), ns.Link.frame and ns.Link.frame:GetEffectiveScale() or 0))
  else
    ns.UI.SendPrompt(input)
  end
end

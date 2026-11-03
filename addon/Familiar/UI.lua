-- Familiar main window. Native chrome (frame, buttons, composer) + "touch surfaces" whose live
-- content is painted by the companion's Glass overlay. Clicks/wheel on a surface are sent as
-- region-relative coordinates; the overlay hit-tests what it drew there.
local _, ns = ...

local UI = {}
ns.UI = UI

local floor, max, min = math.floor, math.max, math.min
UI.ROW_H = 16

local BACKDROP_MAIN = {
  bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background-Dark",
  edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
  tile = true, tileSize = 32, edgeSize = 32,
  insets = { left = 11, right = 12, top = 12, bottom = 11 },
}
local BACKDROP_PANE = {
  bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
  edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
  tile = true, tileSize = 16, edgeSize = 14,
  insets = { left = 3, right = 3, top = 3, bottom = 3 },
}
ns.BACKDROP_PANE = BACKDROP_PANE
-- Background colours at full opacity; the window opacity setting scales their alpha.
local PANE_BG = { 0.02, 0.02, 0.03, 0.85 }
local COMPOSER_BG = { 0, 0, 0, 0.9 }

local frame, listPane, detailPane, composer, editBox, statusText, nativeBox, nativeScroll
local anchorPanes -- defined with the panes below
local fullView, chrome = nil, {} -- focus is session-local; never saved across login/reload
local LOG_W = 236 -- quest log pane width + gap: what collapsing it takes off the window
local rows = {}
local draftNotice, draftDiscard, composerScroll
local draftNoticeText = false
local settingHistory = false
local draftInitialized = false
local DRAFT_LIMIT = 65536 -- bytes per character; never silently truncate a draft
UI.keys = {}

-- Touch surfaces ---------------------------------------------------------------------------------
local wheelAcc = {}
local function flushWheel(region)
  local d = wheelAcc[region]
  wheelAcc[region] = nil
  if d and d ~= 0 then ns.Send({ t = "wheel", r = region, d = d }) end
end

local function relCursor(surface)
  local x, y = GetCursorPosition()
  local s = surface:GetEffectiveScale()
  local l, b, w, h = surface:GetRect()
  if not l or w == 0 or h == 0 then return 0, 0 end
  local rx = (x / s - l) / w
  local ry = 1 - (y / s - b) / h
  return floor(min(1, max(0, rx)) * 10000 + 0.5) / 10000, floor(min(1, max(0, ry)) * 10000 + 0.5) / 10000
end

-- Make `surface` report clicks, wheel and (low-priority) hover for overlay region `region`.
function UI.Wheel(region, delta)
  local first = wheelAcc[region] == nil
  wheelAcc[region] = (wheelAcc[region] or 0) + delta
  if first then C_Timer.After(0.03, function() flushWheel(region) end) end
end

function UI.MakeSurface(surface, region)
  surface:EnableMouse(true)
  surface:EnableMouseWheel(true)
  surface:SetScript("OnMouseWheel", ns.Guard(region .. " wheel", function(_, delta) UI.Wheel(region, delta) end, true))
  surface:SetScript("OnMouseUp", ns.Guard(region .. " click", function(self, button)
    local rx, ry = relCursor(self)
    ns.Send({ t = "click", r = region, x = rx, y = ry, b = button == "RightButton" and "R" or "L" }, true)
  end, true))
  local lastHover, lastX, lastY = 0, -1, -1
  surface:SetScript("OnUpdate", ns.Guard(region .. " hover", function(self)
    if not ns.db.hover then return end
    if not self:IsMouseOver() then
      if lastX >= 0 then
        lastX, lastY = -1, -1
        ns.Send({ t = "hover", r = region, x = -1, y = -1 }, false, "hover")
      end
      return
    end
    local now = GetTime()
    if now - lastHover < 0.12 or ns.Link.QueueDepth() > 0 then return end
    local rx, ry = relCursor(self)
    if math.abs(rx - lastX) + math.abs(ry - lastY) < 0.004 then return end
    lastHover, lastX, lastY = now, rx, ry
    ns.Send({ t = "hover", r = region, x = rx, y = ry }, false, "hover")
  end))
end

-- Helpers ----------------------------------------------------------------------------------------
local function button(parent, text, width, key, tooltip)
  local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
  b:SetSize(width, 22)
  b:SetText(text)
  b:SetScript("OnClick", function() UI.Key(key) end)
  if tooltip then
    b:SetScript("OnEnter", function(self)
      GameTooltip:SetOwner(self, "ANCHOR_TOP")
      GameTooltip:SetText(tooltip, 1, 1, 1, 1, true)
      GameTooltip:Show()
    end)
    b:SetScript("OnLeave", GameTooltip_Hide)
  end
  UI.keys[key] = b
  return b
end

local function pane(parent)
  local p = CreateFrame("Frame", nil, parent, "BackdropTemplate")
  p:SetBackdrop(BACKDROP_PANE)
  p:SetBackdropColor(unpack(PANE_BG))
  p:SetBackdropBorderColor(0.55, 0.45, 0.25, 0.9)
  p:EnableMouseWheel(false)
  p.content = CreateFrame("Frame", nil, p)
  p.content:SetPoint("TOPLEFT", 5, -5)
  p.content:SetPoint("BOTTOMRIGHT", -5, 5)
  return p
end

-- src says how the player did it: "button" (a Familiar button), "bind" (keybinding), "slash".
-- The companion checks approve / always / mode against real input on the PC: a button press must
-- coincide with a physical click on that button, a binding with the Approve key registered in the
-- control panel. Slash commands can't be checked and never approve (deny / stop still work).
function UI.Key(k, src)
  if k == "send" then return UI.Submit() end
  if k == "newClaude" or k == "newCodex" or k == "newChat" or k == "back" then UI.SetFocusMode(false) end
  if (k == "next" or k == "prev") and editBox and editBox:GetText() ~= "" then UI.CheckDraftTarget() end
  -- Context travels with the decision itself; a queued layout may still describe the old view.
  ns.Send({ t = "key", k = k, src = src or "button", view = UI.focusMode and "focus" or "full" }, true)
  if k == "native" then UI.ToggleNative() end
end

-- Rows (native fallback labels + hover highlight; clicks go through the list surface) -----------
local function layoutRows()
  local c = listPane.content
  local n = max(1, floor(c:GetHeight() / UI.ROW_H))
  for i = 1, max(n, #rows) do
    local r = rows[i]
    if i <= n then
      if not r then
        r = CreateFrame("Frame", nil, c)
        r:SetHeight(UI.ROW_H)
        r.hl = r:CreateTexture(nil, "BACKGROUND")
        r.hl:SetTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight")
        r.hl:SetBlendMode("ADD")
        r.hl:SetAllPoints()
        r.hl:Hide()
        r.text = r:CreateFontString(nil, "ARTWORK", "GameFontNormalSmall")
        r.text:SetPoint("LEFT", 4, 0)
        r.text:SetPoint("RIGHT", -4, 0)
        r.text:SetJustifyH("LEFT")
        r.text:SetWordWrap(false)
        rows[i] = r
      end
      r:ClearAllPoints()
      r:SetPoint("TOPLEFT", c, "TOPLEFT", 0, -(i - 1) * UI.ROW_H)
      r:SetPoint("TOPRIGHT", c, "TOPRIGHT", 0, -(i - 1) * UI.ROW_H)
      r:Show()
    elseif r then
      r:Hide()
    end
  end
  UI.rowCount = n
  UI.RefreshNative()
end

-- Hover highlight follows the cursor without stealing mouse events from the surface.
local function updateRowHover()
  if not listPane:IsMouseOver() then
    for _, r in ipairs(rows) do r.hl:Hide() end
    return
  end
  for _, r in ipairs(rows) do r.hl:SetShown(r:IsShown() and r:IsMouseOver()) end
end

-- Native fallback (snapshot written by the companion, loaded at login / reload) -----------------
function UI.RefreshNative()
  local data = FamiliarSyncData
  local list = data and data.list or {}
  for i, r in ipairs(rows) do
    local item = list[i]
    if item then
      local indent = item.kind == "thread" and "    " or ""
      local color = item.kind == "zone" and "|cffffd100" or "|cffe0e0e0"
      r.text:SetText(indent .. color .. (item.text or "") .. "|r")
    else
      r.text:SetText(i == 1 and not data and "|cffff9d2eStart Familiar on your PC to see your quests here.|r" or "")
    end
  end
  if nativeBox then
    local sel = data and data.selected
    local text
    if sel then
      text = ("|cffffd100%s|r\n\n%s"):format(sel.title or "", sel.text or "")
    else
      text = "Familiar isn't running on your PC.\n\nOpen the Familiar folder and double-click Run Familiar.cmd; it paints "
        .. "live replies on top of this window. Messages you send meanwhile are kept: /fam resend sends them "
        .. "once it's running. A native copy of the selected quest is saved here on /reload."
    end
    if UI.focusMode then
      text = "Live Glass is unavailable or Text view is on. This is a saved snapshot, not live status.\nUse Full view below to restore controls; queued messages are not provider receipts.\n\n" .. text
    end
    nativeBox.locked = text
    nativeBox:SetText(text)
  end
  if statusText then
    -- The live overlay covers this bar while the companion is drawing, so whoever can read it is
    -- looking at a game without the companion.
    local msg
    if not data then
      msg = "Familiar isn't running on your PC - start it there"
    elseif data.stoppedAt then
      msg = ("Familiar was closed at %s - start it on your PC"):format(date("%H:%M", data.stoppedAt))
    else
      msg = ("Familiar isn't drawing - is it running on your PC? (last seen %s)"):format(date("%H:%M", data.generatedAt or 0))
    end
    statusText:SetText("|cffff9d2e" .. msg .. "|r")
  end
end

function UI.Echo(text)
  if nativeBox and nativeBox.locked then
    nativeBox.locked = nativeBox.locked .. "\n\n|cff9d7cff> " .. text .. "|r"
    nativeBox:SetText(nativeBox.locked)
  end
end

function UI.ToggleNative()
  UI.native = not UI.native
  if UI.nativeBadge then UI.nativeBadge:SetShown(UI.native) end
  -- In native view the transcript box takes the mouse (select + Ctrl+C); otherwise clicks fall
  -- through to the detail surface for the overlay.
  nativeBox:EnableMouse(UI.native)
  nativeScroll:EnableMouseWheel(UI.native)
  if nativeScroll.ScrollBar then nativeScroll.ScrollBar:SetShown(UI.native) end
  ns.Layout.Dirty()
end

-- Composer ---------------------------------------------------------------------------------------
-- The addon cannot know the live Glass selection. This is one character-local unsent composer,
-- not a per-conversation draft; restoring it never sends or changes the selected conversation.
local function updateDraftNotice()
  if not draftNotice then return end
  local warning = UI.draftTooLong and "Draft over 64 KB: copy it before reload; latest edits aren't saved."
    or UI.sendTooLong and "Too long to send (limit is about 40 KB): shorten or split it before Send."
    or UI.draftTargetChanged and "Conversation changed: check the message target before Send."
    or UI.draftRestored and "Recovered draft: check the message target before Send."
  local text = warning or ""
  if text == draftNoticeText then return end
  draftNoticeText = text
  draftNotice:SetText(text)
  draftNotice:SetShown(text ~= "")
  draftDiscard:SetShown(text ~= "")
  composerScroll:ClearAllPoints()
  composerScroll:SetPoint("TOPLEFT", 6, warning and -32 or -6)
  composerScroll:SetPoint("BOTTOMRIGHT", -26, 6)
end

function UI.CheckDraftTarget()
  UI.draftTargetChanged = true
  updateDraftNotice()
end

function UI.SaveDraft()
  -- A partial/failed UI initialization must not save its empty edit box over prior text.
  if not draftInitialized or not ns.charDB or not editBox or settingHistory then return end
  -- Ctrl+Up is a view of history, not an edit. Save the unfinished draft underneath it.
  local text = UI.histIdx and UI.histDraft or editBox:GetText() or ""
  local tooLong = #text > DRAFT_LIMIT
  if tooLong then
    -- Keep the last complete, bounded version, but identify it as older after a reload.
    ns.charDB.draftOverflow = true
    if not UI.draftTooLong then ns.Print("Draft exceeds 64 KB. Copy it before reload/logout; the latest edits cannot be saved.") end
  else
    ns.charDB.composerDraft = text ~= "" and text or nil
    ns.charDB.draftOverflow = nil
  end
  UI.draftTooLong = tooLong
  -- Room for the message's JSON wrapping and character context; the strip refuses anything larger.
  UI.sendTooLong = #text > ns.Link.maxPayload() - 512
  updateDraftNotice()
end

function UI.RestoreDraft()
  if not editBox or not ns.charDB then return end
  -- Initialization must never replace a draft already present in this UI instance.
  if editBox:GetText() ~= "" or UI.histIdx then return end
  local text = ns.charDB.composerDraft
  if type(text) ~= "string" or #text > DRAFT_LIMIT then
    ns.charDB.composerDraft = nil
    text = nil
  end
  local overflow = ns.charDB.draftOverflow
  if text and text ~= "" then
    settingHistory = true
    editBox:SetText(text)
    settingHistory = false
    UI.draftRestored = true
    ns.Print("Recovered this character's unsent draft. Check the message target before Send; /fam draft discard clears it. Nothing was sent.")
  end
  if overflow then ns.Print("The previous draft exceeded 64 KB. Only its last saved version, if any, could be recovered.") end
  updateDraftNotice()
end

function UI.DiscardDraft()
  UI.histIdx, UI.histDraft = nil, nil
  UI.draftRestored, UI.draftTooLong, UI.draftTargetChanged = nil, nil, nil
  if ns.charDB then ns.charDB.composerDraft, ns.charDB.draftOverflow = nil, nil end
  if editBox then editBox:SetText("") end
  updateDraftNotice()
  ns.Print("Discarded this character's unfinished composer draft.")
end

local function setHistoryText(text)
  settingHistory = true
  editBox:SetText(text)
  settingHistory = false
end

-- Send something the player typed (prompt, /fam ask, /fam <provider>) and remember it for Ctrl+Up.
-- Returns false, and says so, if it was too large for the Runestrip (~40 KB): nothing is sent.
function UI.SendTyped(msg, text)
  if not ns.SendTracked(msg) then
    ns.Print("|cffff5a4fThat message is too long to send (limit is about 40 KB). Nothing was sent.|r")
    return false
  end
  UI.Remember(text)
  return true
end

-- Send a prompt (escaped as typed in WoW) and echo it in the native view.
function UI.SendPrompt(text)
  if not UI.SendTyped({ t = "prompt", text = ns.Unescape(text), ctx = ns.GameContext() }, text) then return false end
  UI.Echo(text)
  return true
end

-- Ctrl+Up recalls anything sent: composer, /fam <text>, /fam claude|codex <text>.
function UI.Remember(text)
  local h = ns.db.history
  if h[#h] ~= text then h[#h + 1] = text end
  while #h > 30 do table.remove(h, 1) end
  -- A separate /fam send may arrive while browsing composer history. Return its draft
  -- before resetting navigation; a successful composer submission clears it below.
  if UI.histIdx and editBox then setHistoryText(UI.histDraft or "") end
  UI.histIdx = nil
  UI.histDraft = nil
end

function UI.Submit()
  local text = strtrim(editBox:GetText() or "")
  if text == "" then return end
  -- Sending a recalled history message: Remember has already put the unfinished draft back.
  local recalled = UI.histIdx ~= nil
  if not UI.SendPrompt(text) or recalled then return end
  UI.draftRestored = nil
  editBox:SetText("") -- SendTracked has already put this message in the existing saved outbox.
  -- Hand the keyboard back to the game so the next key is a keybind, not more text.
  if ns.db.sendFocus ~= "stay" then editBox:ClearFocus() end
end

local function buildComposer(parent)
  composer = CreateFrame("Frame", nil, parent, "BackdropTemplate")
  composer:SetBackdrop(BACKDROP_PANE)
  composer:SetBackdropColor(unpack(COMPOSER_BG))
  composer:SetBackdropBorderColor(0.6, 0.5, 0.3, 1)
  local sf = CreateFrame("ScrollFrame", "FamiliarComposerScroll", composer, "UIPanelScrollFrameTemplate")
  composerScroll = sf
  sf.scrollBarHideable = true
  sf:SetPoint("TOPLEFT", 6, -6)
  sf:SetPoint("BOTTOMRIGHT", -26, 6)
  editBox = CreateFrame("EditBox", "FamiliarComposer", sf)
  editBox:SetMultiLine(true)
  editBox:SetMaxLetters(0)
  editBox:SetAutoFocus(false)
  editBox:SetFontObject(ChatFontNormal)
  editBox:SetWidth(400)
  editBox:SetTextInsets(2, 2, 2, 2)
  -- Initialise cursorOffset/cursorHeight; ScrollingEdit_OnUpdate does arithmetic on them.
  ScrollingEdit_OnLoad(editBox)
  sf:SetScrollChild(editBox)
  sf:SetScript("OnSizeChanged", function(self, w) editBox:SetWidth(w) end)
  composer:EnableMouse(true)
  composer:SetScript("OnMouseDown", function() editBox:SetFocus() end)
  local hint = composer:CreateFontString(nil, "ARTWORK", "GameFontDisableSmall")
  hint:SetPoint("TOPLEFT", 10, -9)
  hint:SetText("Speak to your familiar...  Enter sends · Shift+Enter newline · Ctrl+Up history")
  editBox:SetScript("OnTextChanged", function(self, user)
    if not settingHistory then
      if user then UI.histIdx, UI.histDraft = nil, nil end
      -- Editing recovered text does not establish its destination. Keep the cue until the
      -- composer is cleared or successfully sent, even after partial edits.
      if self:GetText() == "" then UI.draftRestored, UI.draftTargetChanged = nil, nil end
      UI.SaveDraft()
    end
    hint:SetShown(self:GetText() == "" and not self:HasFocus())
    ScrollingEdit_OnTextChanged(self, sf)
  end)
  editBox:SetScript("OnCursorChanged", function(self, x, y, w, h) ScrollingEdit_OnCursorChanged(self, x, y, w, h) end)
  editBox:SetScript("OnUpdate", ns.Guard("composer scroll", function(self, elapsed) ScrollingEdit_OnUpdate(self, elapsed, sf) end))
  editBox:SetScript("OnEditFocusGained", function() hint:Hide() end)
  editBox:SetScript("OnEditFocusLost", function(self) hint:SetShown(self:GetText() == "") end)
  editBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
  editBox:SetScript("OnEnterPressed", function(self)
    if IsShiftKeyDown() or not ns.db.enterSends then
      -- Insert is programmatic (OnTextChanged user=false), but this is a real edit of
      -- recalled history. Stop browsing before the callback saves the edited text.
      UI.histIdx, UI.histDraft = nil, nil
      self:Insert("\n")
    else
      UI.Submit()
    end
  end)
  editBox:SetScript("OnKeyDown", function(self, key)
    if not IsControlKeyDown() then return end
    local h = ns.db.history
    if key == "UP" and #h > 0 then
      -- Browsing old messages must not erase the message the player was composing.
      if not UI.histIdx then UI.histDraft = self:GetText() end
      UI.histIdx = max(1, (UI.histIdx or (#h + 1)) - 1)
      setHistoryText(h[UI.histIdx])
    elseif key == "DOWN" and UI.histIdx then
      UI.histIdx = UI.histIdx + 1
      if UI.histIdx > #h then
        setHistoryText(UI.histDraft or "")
        UI.histIdx, UI.histDraft = nil, nil
      else
        setHistoryText(h[UI.histIdx])
      end
    end
  end)
  draftNotice = composer:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  draftNotice:SetPoint("TOPLEFT", 10, -5)
  draftNotice:SetPoint("TOPRIGHT", -78, -5)
  draftNotice:SetHeight(26)
  draftNotice:SetJustifyH("LEFT")
  UI.draftNotice = draftNotice
  draftDiscard = CreateFrame("Button", nil, composer, "UIPanelButtonTemplate")
  draftDiscard:SetSize(64, 22)
  draftDiscard:SetPoint("TOPRIGHT", -6, -5)
  draftDiscard:SetText("Discard")
  draftDiscard:SetScript("OnClick", UI.DiscardDraft)
  draftDiscard:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_TOP")
    GameTooltip:SetText("Discard this character's unfinished composer text. Sent messages and history are kept.", 1, 1, 1, 1, true)
    GameTooltip:Show()
  end)
  draftDiscard:SetScript("OnLeave", GameTooltip_Hide)
  UI.draftDiscard = draftDiscard
  UI.RestoreDraft()
  draftInitialized = true
  return composer
end

-- Window -----------------------------------------------------------------------------------------

-- Detail pane and composer start right of the quest log, or at the window's left edge when the
-- log is collapsed.
function anchorPanes() -- assigns the local declared at the top
  composer:ClearAllPoints()
  detailPane:ClearAllPoints()
  if UI.focusMode or UI.logCollapsed then
    composer:SetPoint("BOTTOMLEFT", frame, "BOTTOMLEFT", 14, 40)
  else
    composer:SetPoint("BOTTOMLEFT", listPane, "BOTTOMRIGHT", 6, 0)
  end
  composer:SetPoint("BOTTOMRIGHT", frame, "BOTTOMRIGHT", -14, 40)
  if UI.focusMode or UI.logCollapsed then
    detailPane:SetPoint("TOPLEFT", frame, "TOPLEFT", 14, UI.focusMode and -14 or -54)
  else
    detailPane:SetPoint("TOPLEFT", listPane, "TOPRIGHT", 6, 0)
  end
  detailPane:SetPoint("BOTTOMRIGHT", composer, "TOPRIGHT", 0, 6)
end

local function savePosition()
  if UI.focusMode then return end -- keep the exact full-view preference while focused
  local p, _, _, x, y = frame:GetPoint()
  local w = ns.db.window
  w.point, w.x, w.y = p, floor(x + 0.5), floor(y + 0.5)
  w.w, w.h = floor(frame:GetWidth() + 0.5), floor(frame:GetHeight() + 0.5)
end

-- Crop chrome around the current conversation. Full view is a native escape hatch even with no
-- companion. The edit box is never hidden/recreated/focused, so text, selection and focus survive.
function UI.SetFocusMode(on)
  on = on and true or false
  if not frame or on == (UI.focusMode and true or false) then return end
  local left, top = frame:GetLeft(), frame:GetTop()
  if on then
    local point, relative, relativePoint, x, y = frame:GetPoint()
    fullView = { point = point, relative = relative, relativePoint = relativePoint, x = x, y = y,
      w = frame:GetWidth(), h = frame:GetHeight(), log = UI.logCollapsed,
      tracker = ns.Tracker.IsShown() and true or false }
  end
  UI.focusMode = on
  if frame.SetResizeBounds then frame:SetResizeBounds(on and 324 or 560, on and 300 or 340, 1600, 1100)
  else frame:SetMinResize(on and 324 or 560, on and 300 or 340) end
  for _, item in ipairs(chrome) do item:SetShown(not on) end
  listPane:SetShown(not on and not UI.logCollapsed)
  UI.logBtn:SetShown(not on)
  UI.status:SetShown(not on)
  UI.focusBtn:ClearAllPoints()
  UI.focusBtn:SetPoint("BOTTOMLEFT", frame, "BOTTOMLEFT", on and 14 or 80, 14)
  UI.focusBtn:SetSize(on and 82 or 62, 22)
  UI.focusBtn:SetText(on and "Full view" or "Focus")
  frame:SetBackdrop(on and BACKDROP_PANE or BACKDROP_MAIN)
  UI.ApplyOpacity(ns.db.opacity) -- a new backdrop comes back opaque
  if on then
    local crop = UI.logCollapsed and 0 or LOG_W
    frame:SetSize(fullView.w - crop, fullView.h - 40)
    frame:ClearAllPoints()
    frame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", left + crop, top - 40 - UIParent:GetTop())
    if ns.Tracker.frame then ns.Tracker.frame:Hide() end
  else
    local saved = fullView
    UI.logCollapsed = saved.log
    frame:SetSize(saved.w, saved.h)
    frame:ClearAllPoints()
    frame:SetPoint(saved.point, saved.relative, saved.relativePoint, saved.x, saved.y)
    listPane:SetShown(not saved.log)
    if ns.Tracker.frame then ns.Tracker.frame:SetShown(saved.tracker) end
    fullView = nil
  end
  anchorPanes()
  UI.RefreshNative()
  -- Send now rather than waiting for the ordinary layout debounce; no new companion downlink.
  ns.Layout.Send()
end

function UI.ToggleFocusMode() UI.SetFocusMode(not UI.focusMode) end

-- Collapse: hide the quest log and take its width off the window's left side, so the current
-- quest stays where it is on screen. Expand: the reverse (within the window's size limits).
function UI.SetLogCollapsed(on, initial)
  if UI.focusMode then UI.SetFocusMode(false) end
  on = on and true or false
  if UI.logCollapsed == on and not initial then return end
  local was = UI.logCollapsed
  UI.logCollapsed = on
  ns.db.logCollapsed = on
  listPane:SetShown(not on)
  anchorPanes()
  -- The arrows point the way the window's left edge goes: right when the log collapses, left
  -- when it comes back.
  UI.logBtn:SetText(on and "<< Log" or "Log >>")
  if not initial and was ~= nil and frame:GetLeft() then
    local minW, _, maxW = 560, 340, 1600
    local w = frame:GetWidth()
    -- Expanding restores the width it had before collapsing (collapsing may stop at the minimum).
    if on then ns.db.logExpandedW = w end
    local nw = on and max(minW, w - LOG_W) or min(maxW, ns.db.logExpandedW or (w + LOG_W))
    local left, top = frame:GetLeft() + (w - nw), frame:GetTop()
    frame:SetWidth(nw)
    -- Anchored the way UI.Init restores it (the same point on both frames).
    frame:ClearAllPoints()
    frame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", left, top - UIParent:GetTop())
    savePosition()
    -- The companion reshapes the Glass from this right away; the full layout follows.
    ns.Send({ t = "logtoggle", collapsed = on, rect = ns.Layout.prect(frame) }, false, "logtoggle")
  end
  ns.Layout.Dirty()
end

function UI.ToggleLog()
  UI.SetFocusMode(false)
  UI.SetLogCollapsed(not UI.logCollapsed)
end


function UI.Init()
  local w = ns.db.window
  UI.focusMode = false -- safe full view at login/reload; close/reopen keeps the session choice
  frame = CreateFrame("Frame", "FamiliarFrame", UIParent, "BackdropTemplate")
  UI.frame = frame
  frame:SetBackdrop(BACKDROP_MAIN)
  frame:SetFrameStrata("HIGH")
  frame:SetToplevel(true)
  frame:SetSize(w.w, w.h)
  frame:SetPoint(w.point, UIParent, w.point, w.x, w.y)
  frame:SetMovable(true)
  frame:SetResizable(true)
  frame:SetClampedToScreen(true)
  if frame.SetResizeBounds then frame:SetResizeBounds(560, 340, 1600, 1100) else frame:SetMinResize(560, 340) end
  frame:EnableMouse(true)
  frame:EnableMouseWheel(true)
  frame:SetScript("OnMouseWheel", ns.Guard("window wheel", function(_, delta)
    if UI.native then return end
    if listPane and listPane:IsMouseOver() then UI.Wheel("list", delta)
    elseif detailPane and detailPane:IsMouseOver() then UI.Wheel("detail", delta) end
  end, true))
  frame:RegisterForDrag("LeftButton")
  frame:SetScript("OnDragStart", function(self)
    self:StartMoving()
    ns.Layout.StartDrag("move")
  end)
  frame:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    savePosition()
    ns.Layout.StopDrag()
  end)
  frame:Hide()
  table.insert(UISpecialFrames, "FamiliarFrame")

  -- Title banner
  local header = frame:CreateTexture(nil, "ARTWORK")
  header:SetTexture("Interface\\DialogFrame\\UI-DialogBox-Header")
  header:SetSize(300, 64)
  header:SetPoint("TOP", 0, 12)
  local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  title:SetPoint("TOP", header, "TOP", 0, -14)
  title:SetText("Familiar")
  local icon = frame:CreateTexture(nil, "OVERLAY")
  icon:SetTexture("Interface\\Icons\\Spell_Shadow_SummonImp")
  icon:SetSize(16, 16)
  icon:SetPoint("RIGHT", title, "LEFT", -4, 0)

  local close = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -4, -4)
  close:SetScript("OnClick", function() UI.Hide() end)

  -- Toolbar
  local newClaude = button(frame, "+ Claude", 80, "newClaude", "Start a new quest with Claude Code in a project you pick")
  newClaude:SetPoint("TOPLEFT", 16, -28)
  local newCodex = button(frame, "+ Codex", 80, "newCodex", "Start a new quest with Codex in a project you pick")
  newCodex:SetPoint("LEFT", newClaude, "RIGHT", 4, 0)
  local newChat = button(frame, "+ Chat", 64, "newChat", "Ask anything (no project): game questions, quick lookups. Web search only.")
  newChat:SetPoint("LEFT", newCodex, "RIGHT", 4, 0)
  local back = button(frame, "Back", 60, "back", "Back to the quest log")
  back:SetPoint("LEFT", newChat, "RIGHT", 4, 0)
  local nativeBtn = button(frame, "Text", 54, "native", "Toggle the native, copyable transcript (from the last /reload snapshot)")
  nativeBtn:SetPoint("TOPRIGHT", -34, -28)
  local mode = button(frame, "Mode", 64, "mode", "Permission mode for this quest: Ask first <-> Plan only. Accept edits and Auto are chosen in the desktop control panel.")
  mode:SetPoint("RIGHT", nativeBtn, "LEFT", -4, 0)
  local model = button(frame, "Model", 64, "model", "Switch to the next model for this quest (click again to cycle)")
  model:SetPoint("RIGHT", mode, "LEFT", -4, 0)

  -- Panes
  listPane = pane(frame)
  listPane:SetPoint("TOPLEFT", 14, -54)
  listPane:SetPoint("BOTTOMLEFT", 14, 40)
  listPane:SetWidth(230)
  UI.MakeSurface(listPane.content, "list")
  listPane.content:HookScript("OnUpdate", ns.Guard("row highlight", updateRowHover))
  listPane.content:SetScript("OnSizeChanged", function() layoutRows(); ns.Layout.Dirty() end)
  UI.listPane = listPane

  buildComposer(frame)
  composer:SetHeight(70)
  detailPane = pane(frame)
  anchorPanes()
  UI.MakeSurface(detailPane.content, "detail")
  detailPane.content:SetScript("OnSizeChanged", function() ns.Layout.Dirty() end)
  UI.detailPane = detailPane

  -- Native transcript (copyable). Sits under the overlay; visible when the overlay is absent or
  -- the user toggles "Text". Read-only: edits are reverted.
  nativeScroll = CreateFrame("ScrollFrame", "FamiliarNativeScroll", detailPane, "UIPanelScrollFrameTemplate")
  nativeScroll:SetPoint("TOPLEFT", detailPane.content, "TOPLEFT", 2, -2)
  nativeScroll:SetPoint("BOTTOMRIGHT", detailPane.content, "BOTTOMRIGHT", -22, 2)
  nativeBox = CreateFrame("EditBox", nil, nativeScroll)
  nativeBox:SetMultiLine(true)
  nativeBox:SetAutoFocus(false)
  nativeBox:SetFontObject(GameFontHighlightSmall)
  nativeBox:SetWidth(300)
  nativeScroll:SetScrollChild(nativeBox)
  nativeScroll:SetScript("OnSizeChanged", function(_, wdt) nativeBox:SetWidth(wdt) end)
  nativeBox:SetScript("OnTextChanged", function(self, user)
    if user and self.locked then self:SetText(self.locked) end
  end)
  nativeBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
  nativeScroll:SetFrameLevel(detailPane.content:GetFrameLevel() + 2)
  nativeScroll:EnableMouse(false)
  nativeScroll:EnableMouseWheel(false)
  nativeBox:EnableMouse(false)
  -- The native scrollbar only matters in "Text" view; otherwise it would eat wheel events
  -- meant for the Glass over the right edge of the pane.
  nativeScroll.scrollBarHideable = true
  if nativeScroll.ScrollBar then nativeScroll.ScrollBar:Hide() end
  -- The template re-shows the bar whenever the text overflows; keep it hidden outside Text view.
  nativeScroll:HookScript("OnScrollRangeChanged", function(self)
    if not UI.native and self.ScrollBar then self.ScrollBar:Hide() end
  end)
  UI.nativeBadge = detailPane:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  UI.nativeBadge:SetPoint("TOPRIGHT", -8, 12)
  UI.nativeBadge:SetText("native view")
  UI.nativeBadge:Hide()

  -- Bottom bar: status (overlay paints live link status here) + actions
  local send = button(frame, "Send", 64, "send", "Send (Enter)")
  send:SetPoint("BOTTOMRIGHT", -30, 14) -- leaves the corner to the resize grip
  local stop = button(frame, "Stop", 56, "stop", "Interrupt the running turn")
  stop:SetPoint("RIGHT", send, "LEFT", -4, 0)
  local always = button(frame, "Always", 64, "always", "Approve, and allow this kind of action for the rest of this quest (not other quests)")
  always:SetPoint("RIGHT", stop, "LEFT", -12, 0)
  local deny = button(frame, "Deny", 56, "deny", "Deny the pending request")
  deny:SetPoint("RIGHT", always, "LEFT", -4, 0)
  local approve = button(frame, "Approve", 72, "approve", "Approve the pending request")
  approve:SetPoint("RIGHT", deny, "LEFT", -4, 0)

  -- Collapse / expand the quest log (left pane): the window becomes just the current quest.
  local logBtn = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
  logBtn:SetSize(62, 22)
  logBtn:SetPoint("BOTTOMLEFT", 14, 14)
  logBtn:SetScript("OnClick", function() UI.ToggleLog() end)
  logBtn:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_TOP")
    GameTooltip:SetText(UI.logCollapsed and "Show the quest log" or "Hide the quest log: just the quest you're in", 1, 1, 1, 1, true)
    GameTooltip:Show()
  end)
  logBtn:SetScript("OnLeave", GameTooltip_Hide)
  UI.logBtn = logBtn
  local focusBtn = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
  focusBtn:SetSize(62, 22)
  focusBtn:SetText("Focus")
  focusBtn:SetPoint("BOTTOMLEFT", 80, 14)
  focusBtn:SetScript("OnClick", function() UI.ToggleFocusMode() end)
  focusBtn:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_TOP")
    GameTooltip:SetText("Conversation-only view. Full view restores this window; /fam view full also works without Glass. Escape keeps its normal behavior. This choice lasts until reload.", 1, 1, 1, 1, true)
    GameTooltip:Show()
  end)
  focusBtn:SetScript("OnLeave", GameTooltip_Hide)
  UI.focusBtn = focusBtn
  chrome = { header, title, icon, close, newClaude, newCodex, newChat, back, nativeBtn, mode, model, stop, always, deny, approve }

  local status = CreateFrame("Frame", nil, frame)
  status:SetPoint("LEFT", focusBtn, "RIGHT", 6, 0)
  status:SetPoint("BOTTOM", 0, 14)
  status:SetPoint("RIGHT", approve, "LEFT", -8, 0)
  status:SetHeight(22)
  statusText = status:CreateFontString(nil, "ARTWORK", "GameFontNormalSmall")
  statusText:SetAllPoints()
  statusText:SetJustifyH("LEFT")
  UI.MakeSurface(status, "status")
  UI.status = status

  -- Resize grip: its own corner, above everything else in the window.
  local grip = CreateFrame("Button", nil, frame)
  grip:SetSize(22, 22)
  grip:SetPoint("BOTTOMRIGHT", -3, 3)
  grip:SetFrameLevel(frame:GetFrameLevel() + 20)
  UI.grip = grip
  grip:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
  grip:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
  grip:SetPushedTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Down")
  grip:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_TOPLEFT")
    GameTooltip:SetText("Drag to resize")
    GameTooltip:Show()
  end)
  grip:SetScript("OnLeave", function() GameTooltip_Hide() end)
  grip:SetScript("OnMouseDown", function()
    frame:StartSizing("BOTTOMRIGHT")
    ns.Layout.StartDrag("size")
  end)
  grip:SetScript("OnMouseUp", function()
    frame:StopMovingOrSizing()
    savePosition()
    ns.Layout.StopDrag()
  end)

  if ns.db.logCollapsed then UI.SetLogCollapsed(true, true) else UI.SetLogCollapsed(false, true) end

  frame:SetScript("OnShow", function() ns.Layout.Dirty() end)
  frame:SetScript("OnHide", function()
    -- Escape (UISpecialFrames) closes us without UI.Hide; remember it, unless we were hidden for
    -- combat or only because UIParent hid (Alt+Z, cinematics) - then IsShown() is still true.
    if not UI.tempHidden and not frame:IsShown() then ns.db.shown = false end
    ns.Layout.Dirty()
  end)
  layoutRows()
end

function UI.Show()
  frame:Show()
  ns.db.shown = true
end

function UI.Hide(temporary)
  UI.tempHidden = temporary
  frame:Hide()
  UI.tempHidden = nil
  if not temporary then ns.db.shown = false end
end

function UI.Toggle()
  if frame:IsShown() then UI.Hide() else UI.Show() end
end

function UI.Focus()
  UI.Show()
  editBox:SetFocus()
end

function UI.IsShown() return frame and frame:IsShown() end

-- Window background opacity (percent): the window, its panes and the composer fade; text, borders
-- and buttons stay solid. The layout carries it so the Glass fades its pane backgrounds to match.
function UI.ApplyOpacity(pct)
  ns.db.opacity = max(0, min(100, floor(tonumber(pct) or 100)))
  local a = ns.db.opacity / 100
  frame:SetBackdropColor(1, 1, 1, a)
  for _, p in ipairs({ listPane, detailPane }) do p:SetBackdropColor(PANE_BG[1], PANE_BG[2], PANE_BG[3], PANE_BG[4] * a) end
  composer:SetBackdropColor(COMPOSER_BG[1], COMPOSER_BG[2], COMPOSER_BG[3], COMPOSER_BG[4] * a)
  ns.Layout.Dirty()
end

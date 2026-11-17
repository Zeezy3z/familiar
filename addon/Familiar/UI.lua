-- Familiar main window. Native chrome (frame, buttons, composer) + "touch surfaces" whose live
-- content is painted by the companion's Glass overlay. Clicks/wheel on a surface are sent as
-- region-relative coordinates; the overlay hit-tests what it drew there.
local _, ns = ...

local UI = {}
ns.UI = UI

local floor, max, min = math.floor, math.max, math.min
UI.BASE_ROW_H = 16
UI.ROW_H = UI.BASE_ROW_H -- scaled by ns.db.fontScale at login

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

local frame, listPane, detailPane, composer, editBox, statusText, savedNote, questMenu
local anchorPanes -- defined with the panes below
local fullView, chrome = nil, {} -- compact view is session-local; never saved across login/reload
local LOG_W = 236 -- quest list pane width + gap: what hiding it takes off the window
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

function UI.Wheel(region, delta)
  local first = wheelAcc[region] == nil
  wheelAcc[region] = (wheelAcc[region] or 0) + delta
  if first then C_Timer.After(0.03, function() flushWheel(region) end) end
end

-- Make `surface` report clicks and the wheel for overlay region `region`.
function UI.MakeSurface(surface, region)
  surface:EnableMouse(true)
  surface:EnableMouseWheel(true)
  surface:SetScript("OnMouseWheel", ns.Guard(region .. " wheel", function(_, delta) UI.Wheel(region, delta) end, true))
  surface:SetScript("OnMouseUp", ns.Guard(region .. " click", function(self, button)
    local rx, ry = relCursor(self)
    ns.Send({ t = "click", r = region, x = rx, y = ry, b = button == "RightButton" and "R" or "L" }, true)
  end, true))
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
-- Familiar checks approve against real input on the PC: the Approve key registered in the control
-- panel. Slash commands can't be checked and never approve (deny / stop still work). "send" and
-- "newQuest" stay here in the game.
function UI.Key(k, src)
  if k == "send" then return UI.Submit() end
  if k == "newQuest" then return UI.NewQuest() end
  if k == "newClaude" or k == "newCodex" or k == "newChat" or k == "back" then UI.SetFocusMode(false) end
  if (k == "next" or k == "prev") and editBox and editBox:GetText() ~= "" then UI.CheckDraftTarget() end
  -- Context travels with the decision itself; a queued layout may still describe the old view.
  ns.Send({ t = "key", k = k, src = src or "button", view = UI.focusMode and "focus" or "full" }, true)
end

-- "+ Quest": the familiars a new quest can start with (Familiar's new-quest keys), limited to the
-- ones switched on in the last saved status. One familiar: start at once; more: a small menu.
local NEW_QUEST = { { id = "claude", key = "newClaude", label = "Claude Code" }, { id = "codex", key = "newCodex", label = "Codex" } }
local function newQuestFamiliars()
  local on = type(FamiliarSyncData) == "table" and type(FamiliarSyncData.providers) == "table" and FamiliarSyncData.providers
  local list = {}
  for _, f in ipairs(NEW_QUEST) do
    local ok = not on
    for _, id in ipairs(on or {}) do if id == f.id then ok = true end end
    if ok then list[#list + 1] = f end
  end
  return #list > 0 and list or NEW_QUEST
end

function UI.NewQuest()
  local list = newQuestFamiliars()
  if #list == 1 or not questMenu then
    if questMenu then questMenu:Hide() end
    return UI.Key(list[1].key)
  end
  if questMenu:IsShown() then return questMenu:Hide() end
  local shown = {}
  for _, f in ipairs(list) do shown[f.key] = true end
  local n = 0
  for _, b in ipairs(questMenu.buttons) do
    b:SetShown(shown[b.key] == true)
    if shown[b.key] then
      b:ClearAllPoints()
      b:SetPoint("TOPLEFT", 6, -6 - n * 24)
      n = n + 1
    end
  end
  questMenu:SetHeight(12 + n * 24)
  questMenu:Show()
end

-- Row height follows the text size (0.8-1.6, the companion's font scale). The Glass sizes its row
-- text from layout.rowH, so the list and the pixels drawn on it stay aligned.
local function rowHeight(scale)
  return floor(UI.BASE_ROW_H * (tonumber(scale) or 1) + 0.5)
end

-- Rows (a hint line + hover highlight; clicks go through the list surface) ----------------------
local function layoutRows()
  local c = listPane.content
  local n = max(1, floor(c:GetHeight() / UI.ROW_H))
  for i = 1, max(n, #rows) do
    local r = rows[i]
    if i <= n then
      if not r then
        r = CreateFrame("Frame", nil, c)
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
      r:SetHeight(UI.ROW_H)
      r:ClearAllPoints()
      r:SetPoint("TOPLEFT", c, "TOPLEFT", 0, -(i - 1) * UI.ROW_H)
      r:SetPoint("TOPRIGHT", c, "TOPRIGHT", 0, -(i - 1) * UI.ROW_H)
      r:Show()
    elseif r then
      r:Hide()
    end
  end
  UI.rowCount = n
  UI.RefreshSaved()
end

-- Hover highlight follows the cursor without stealing mouse events from the surface.
local function updateRowHover()
  if not listPane:IsMouseOver() then
    for _, r in ipairs(rows) do r.hl:Hide() end
    return
  end
  for _, r in ipairs(rows) do r.hl:SetShown(r:IsShown() and r:IsMouseOver()) end
end

-- Saved status (FamiliarSync, loaded at login / reload) -----------------------------------------
-- The Glass covers the panes and the status bar while Familiar is drawing, so whoever can read
-- these is looking at the window without the live view. They say what the addon actually knows.
function UI.RefreshSaved()
  local state, short, long = ns.SavedState()
  for i, r in ipairs(rows) do
    r.text:SetText(i == 1 and "|cff9d9384Your quests show here on the Glass.|r" or "")
  end
  if savedNote then
    local notice = type(FamiliarSyncData) == "table" and type(FamiliarSyncData.notice) == "string" and FamiliarSyncData.notice
    savedNote:SetText(long .. "\n\n|cff9d9384This is a saved status, not the conversation: replies show only on the Glass."
      .. (state == "saved" and "" or " Messages you send meanwhile wait in the outbox; /fam resend sends them once Familiar runs.")
      .. "|r" .. (notice and ("\n\n|cffff9d2e" .. notice .. "|r") or ""))
  end
  if statusText then statusText:SetText("|cffff9d2e" .. short .. "|r") end
end

-- Composer ---------------------------------------------------------------------------------------
-- The addon cannot know the live Glass selection. This is one character-local unsent composer,
-- not a per-conversation draft; restoring it never sends or changes the selected conversation.
local function updateDraftNotice()
  if not draftNotice then return end
  local warning = UI.draftTooLong and "Draft over 64 KB: copy it before reload; latest edits aren't saved."
    or UI.sendTooLong and "Too long to send (limit is about 40 KB): shorten or split it before Send."
    or UI.draftTargetChanged and "Selected quest changed: check the message target before Send."
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
    ns.Print("Recovered this character's unsent draft. Check the message target before Send; the Discard button clears it. Nothing was sent.")
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

-- Send something the player typed (prompt, /fam ask, /fam <familiar>) and remember it for Ctrl+Up.
-- Returns false, and says so, if it was too large for the Runestrip (~40 KB): nothing is sent.
-- `note` ("summoning claude...") is printed only when Familiar may be listening; when it is known
-- closed, the player is told the message waits in the outbox instead.
function UI.SendTyped(msg, text, note)
  if not ns.SendTracked(msg) then
    ns.Print("|cffff5a4fThat message is too long to send (limit is about 40 KB). Nothing was sent.|r")
    return false
  end
  UI.Remember(text)
  if ns.AppClosed() then
    ns.Print("|cffff9d2ekept in the outbox - Familiar isn't running|r (as of your last login or /reload). /fam resend sends it once it runs.")
  elseif note then
    ns.Print(note)
  end
  return true
end

-- Send a prompt (escaped as typed in WoW) to the selected quest.
function UI.SendPrompt(text)
  return UI.SendTyped({ t = "prompt", text = ns.Unescape(text), ctx = ns.GameContext() }, text)
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
    if IsShiftKeyDown() then
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
    GameTooltip:SetText("Discard this character's unfinished message. Sent messages and history are kept.", 1, 1, 1, 1, true)
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

-- One view button cycles Full -> Quest only (quest list hidden, remembered) -> Compact (just the
-- conversation and the message box, this session only) -> Full. Its label is what a click does.
local VIEW_LABEL = { full = "Quest only", quest = "Compact", compact = "Full view" }
local VIEW_TIP = {
  full = "Quest only: hide the quest list so the window is just the quest you're in (remembered).",
  quest = "Compact: just the conversation and the message box, for this session.",
  compact = "Full view: the whole window again, quest list included.",
}
local function viewState() return UI.focusMode and "compact" or UI.logCollapsed and "quest" or "full" end
local function updateViewButton()
  if UI.viewBtn then UI.viewBtn:SetText(VIEW_LABEL[viewState()]) end
end

function UI.CycleView()
  local v = viewState()
  if v == "full" then UI.SetLogCollapsed(true)
  elseif v == "quest" then UI.SetFocusMode(true)
  else
    UI.SetFocusMode(false)
    UI.SetLogCollapsed(false)
  end
end

-- Compact view: crop chrome around the current conversation (internally "focus", the name the
-- Glass knows it by). The view button stays as the way back even with no Glass. The edit box is
-- never hidden/recreated/focused, so text, selection and keyboard focus survive.
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
  if questMenu then questMenu:Hide() end
  listPane:SetShown(not on and not UI.logCollapsed)
  UI.status:SetShown(not on)
  updateViewButton()
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
  -- Send now rather than waiting for the ordinary layout debounce.
  ns.Layout.Send()
end

-- Hide: take the quest list's width off the window's left side, so the current quest stays where
-- it is on screen. Show: the reverse (within the window's size limits).
function UI.SetLogCollapsed(on, initial)
  if UI.focusMode then UI.SetFocusMode(false) end
  on = on and true or false
  if UI.logCollapsed == on and not initial then return end
  local was = UI.logCollapsed
  UI.logCollapsed = on
  ns.db.logCollapsed = on
  listPane:SetShown(not on)
  anchorPanes()
  updateViewButton()
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
  UI.ROW_H = rowHeight(ns.db.fontScale)
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
  ns.SetIcon(icon)
  icon:SetSize(16, 16)
  icon:SetPoint("RIGHT", title, "LEFT", -4, 0)

  local close = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -4, -4)
  close:SetScript("OnClick", function() UI.Hide() end)

  -- Toolbar
  local newQuest = button(frame, "+ Quest", 80, "newQuest", "Start a new quest: pick a familiar, then a zone")
  newQuest:SetPoint("TOPLEFT", 16, -28)
  local newChat = button(frame, "+ Chat", 64, "newChat", "Ask anything (no zone): game questions, quick lookups. Web search only.")
  newChat:SetPoint("LEFT", newQuest, "RIGHT", 4, 0)
  local back = button(frame, "Back", 60, "back", "Back to the quest list")
  back:SetPoint("LEFT", newChat, "RIGHT", 4, 0)
  -- Modes are set in Familiar on your PC (Safety), never from the game.
  local model = button(frame, "Model", 64, "model", "Choose the model for this quest (opens the list in the quest pane)")
  model:SetPoint("TOPRIGHT", -34, -28)

  -- The "+ Quest" menu: one button per familiar. It opens over the quest list, where the Glass
  -- paints; Layout lists it as an occluder so the Glass leaves a hole for it.
  questMenu = CreateFrame("Frame", "FamiliarQuestMenu", frame, "BackdropTemplate")
  questMenu:SetBackdrop(BACKDROP_PANE)
  questMenu:SetBackdropColor(0.02, 0.02, 0.03, 0.95)
  questMenu:SetBackdropBorderColor(0.6, 0.5, 0.3, 1)
  questMenu:SetFrameStrata("DIALOG")
  questMenu:SetSize(124, 60)
  questMenu:SetPoint("TOPLEFT", newQuest, "BOTTOMLEFT", 0, -2)
  questMenu.buttons = {}
  for _, f in ipairs(NEW_QUEST) do
    local b = CreateFrame("Button", nil, questMenu, "UIPanelButtonTemplate")
    b:SetSize(112, 22)
    b:SetText(f.label)
    b.key = f.key
    b:SetScript("OnClick", function()
      questMenu:Hide()
      UI.Key(f.key)
    end)
    questMenu.buttons[#questMenu.buttons + 1] = b
  end
  questMenu:Hide()
  UI.questMenu = questMenu

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

  -- The saved status, under the Glass: visible only when the live view is not drawing. It says
  -- what the addon knows and never shows the conversation (FamiliarSync holds none).
  savedNote = detailPane.content:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
  savedNote:SetPoint("TOPLEFT", 6, -6)
  savedNote:SetPoint("TOPRIGHT", -6, -6)
  savedNote:SetJustifyH("LEFT")
  savedNote:SetJustifyV("TOP")
  savedNote:SetWordWrap(true)
  UI.savedNote = savedNote

  -- Bottom bar: status (the Glass paints the live link status here) + actions. Approving is done
  -- with the registered Approve key (or on the Glass card); "Always" only in the control panel.
  local send = button(frame, "Send", 64, "send", "Send (Enter)")
  send:SetPoint("BOTTOMRIGHT", -30, 14) -- leaves the corner to the resize grip
  local stop = button(frame, "Stop", 56, "stop", "Interrupt the running turn")
  stop:SetPoint("RIGHT", send, "LEFT", -4, 0)
  local deny = button(frame, "Deny", 56, "deny", "Deny the pending request")
  deny:SetPoint("RIGHT", stop, "LEFT", -4, 0)

  -- The view button: Full -> Quest only -> Compact -> Full (see UI.CycleView).
  local viewBtn = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
  viewBtn:SetSize(82, 22)
  viewBtn:SetPoint("BOTTOMLEFT", 14, 14)
  viewBtn:SetScript("OnClick", function() UI.CycleView() end)
  viewBtn:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_TOP")
    GameTooltip:SetText(VIEW_TIP[viewState()] .. " Click again for the next view.", 1, 1, 1, 1, true)
    GameTooltip:Show()
  end)
  viewBtn:SetScript("OnLeave", GameTooltip_Hide)
  UI.viewBtn = viewBtn
  chrome = { header, title, icon, close, newQuest, newChat, back, model, stop, deny }

  local status = CreateFrame("Frame", nil, frame)
  status:SetPoint("LEFT", viewBtn, "RIGHT", 6, 0)
  status:SetPoint("BOTTOM", 0, 14)
  status:SetPoint("RIGHT", deny, "LEFT", -8, 0)
  status:SetHeight(22)
  statusText = status:CreateFontString(nil, "ARTWORK", "GameFontNormalSmall")
  statusText:SetAllPoints()
  statusText:SetJustifyH("LEFT")
  statusText:SetWordWrap(true)
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
    questMenu:Hide()
    -- Escape (UISpecialFrames) closes us without UI.Hide; remember it, unless we were hidden only
    -- because UIParent hid (Alt+Z, cinematics) - then IsShown() is still true.
    if not frame:IsShown() then ns.db.shown = false end
    ns.Layout.Dirty()
  end)
  layoutRows()
end

function UI.Show()
  frame:Show()
  ns.db.shown = true
end

function UI.Hide()
  frame:Hide()
  ns.db.shown = false
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

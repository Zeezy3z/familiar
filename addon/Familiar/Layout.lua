-- Reports where the overlay may paint: every touch surface's rectangle in physical pixels of the
-- game's client area, plus state the overlay needs (visibility, dragging, combat, occluders).
local _, ns = ...

local Layout = {}
ns.Layout = Layout

local floor = math.floor
local dirty, lastSent = false, 0

-- Frames that can appear above our window; when shown and overlapping, the overlay cuts a hole.
-- Only plain FrameXML frames: secure-environment UIs (store, help) are forbidden to addons.
local OCCLUDERS = {
  "GameTooltip", "ItemRefTooltip", "GameMenuFrame", "StaticPopup1", "StaticPopup2", "StaticPopup3",
  "WorldMapFrame", "SettingsPanel", "DropDownList1", "DropDownList2", "AddonList",
  "FamiliarQuestMenu", -- our own "+ Quest" menu opens over the quest list
}

-- A frame we may touch: exists, isn't forbidden. Any failure (forbidden object, secret geometry)
-- just means "not an occluder".
local function usable(name)
  local ok, f = pcall(function()
    local f = _G[name]
    if type(f) ~= "table" then return nil end
    if f.IsForbidden and f:IsForbidden() then return nil end
    return f
  end)
  return ok and f or nil
end

local function physScale(f)
  local _, physH = GetPhysicalScreenSize()
  return f:GetEffectiveScale() * physH / 768
end

-- {x, y, w, h} in physical px, origin top-left of the client area.
local function prect(f)
  if not f or not f:IsVisible() then return nil end
  local l, b, w, h = f:GetRect()
  if not l then return nil end
  local k = physScale(f)
  local _, physH = GetPhysicalScreenSize()
  return { floor(l * k + 0.5), floor(physH - (b + h) * k + 0.5), floor(w * k + 0.5), floor(h * k + 0.5) }
end
Layout.prect = prect

local function overlaps(a, b)
  return a and b and a[1] < b[1] + b[3] and b[1] < a[1] + a[3] and a[2] < b[2] + b[4] and b[2] < a[2] + a[4]
end

-- The visible frames that cover any of `guards` (rects), and their signature.
local function occluders(guards)
  local occ, parts = {}, {}
  if #guards == 0 then return occ, "" end
  for _, name in ipairs(OCCLUDERS) do
    local f = usable(name)
    local ok, r = pcall(function() return f and f:IsVisible() and prect(f) or nil end)
    if ok and r then
      for _, g in ipairs(guards) do
        if overlaps(r, g) then
          occ[#occ + 1] = r
          parts[#parts + 1] = table.concat(r, ",")
          break
        end
      end
    end
  end
  return occ, table.concat(parts, ";")
end
local lastOccSig, builtSig = "", "" -- occluders in the last layout sent / built

function Layout.Build()
  local physW, physH = GetPhysicalScreenSize()
  local ui = ns.UI
  local shown = ui.IsShown() and true or false
  local msg = {
    t = "layout",
    scr = { physW, physH },
    px = floor(physScale(UIParent) * 1000 + 0.5) / 1000,
    fpx = ui.frame and floor(physScale(ui.frame) * 1000 + 0.5) / 1000 or nil,
    panel = shown,
    focus = ui.focusMode and true or false, -- compact view
    combat = ns.inCombat and true or false,
    ui = UIParent:IsShown() and true or false,
    op = ns.db.opacity ~= 100 and ns.db.opacity or nil, -- window background opacity, percent
  }
  if shown then
    msg.win = prect(ui.frame)
    msg.list = prect(ui.listPane.content)
    msg.rowH = floor(ui.ROW_H * physScale(ui.listPane.content) * 100 + 0.5) / 100
    msg.detail = prect(ui.detailPane.content)
    msg.status = prect(ui.status)
    -- The button the Glass glows while a turn runs (Stop); kept short to cross the strip fast.
    msg.keys = { stop = ui.keys.stop and prect(ui.keys.stop) }
  end
  msg.tracker = ns.Tracker.IsShown() and prect(ns.Tracker.content) or nil
  -- The minimap button's rect, window open or not; absent while the button is not visible. The
  -- Glass paints a mark on it only when it has a rect.
  msg.mini = prect(ns.Minimap.button)
  local guards = {}
  for _, r in ipairs({ msg.win or false, msg.tracker or false, msg.mini or false }) do
    if r then guards[#guards + 1] = r end
  end
  local occ
  occ, builtSig = occluders(guards)
  if #occ > 0 then msg.occ = occ end
  return msg
end

-- Tooltips show and hide constantly while you mouse over the world (in combat too). Each show or
-- hide only schedules one check a moment later; the check looks at the occluders alone (not the
-- whole layout), does nothing while none of our frames is visible, and sends the layout only when
-- the set of frames covering our window / tracker / minimap button actually changed.
local checkPending = false
function Layout.CheckOccluders()
  checkPending = false
  local guards = {}
  if ns.UI.IsShown() then guards[#guards + 1] = prect(ns.UI.frame) end
  if ns.Tracker.IsShown() then guards[#guards + 1] = prect(ns.Tracker.content) end
  guards[#guards + 1] = prect(ns.Minimap.button)
  local _, sig = occluders(guards)
  if sig ~= lastOccSig then
    lastOccSig = sig
    Layout.Send()
  end
end
local check = ns.Guard("occluders", Layout.CheckOccluders, true)
local function scheduleCheck()
  if checkPending then return end
  checkPending = true
  C_Timer.After(0.05, check)
end

local function send()
  dirty = false
  lastSent = GetTime()
  local m = Layout.Build()
  lastOccSig = builtSig
  ns.Send(m, false, "layout")
end
Layout.Send = ns.Guard("layout", send, true)

function Layout.Dirty()
  if dirty then return end
  dirty = true
  C_Timer.After(0.08, function()
    if dirty then Layout.Send() end
  end)
end

-- Dragging or resizing a Familiar frame: one "dragstart" with the frame's rect, the cursor and the
-- resize limits (physical px). The companion then follows the mouse itself (it reads the OS
-- cursor), so the overlay keeps up without per-frame updates through the Runestrip. "dragstop"
-- and the exact layout follow when the mouse is released.
local function cursorPx()
  local x, y = GetCursorPosition() -- UIParent-scaled screen units, origin bottom-left
  local _, physH = GetPhysicalScreenSize()
  local k = physH / 768
  return floor(x * k + 0.5), floor(physH - y * k + 0.5)
end

function Layout.StartDrag(kind, target) -- kind "move" | "size"; target "win" | "tracker"
  target = target or "win"
  local f = target == "tracker" and ns.Tracker.frame or ns.UI.frame
  if not f then return end
  local cx, cy = cursorPx()
  local msg = { t = "dragstart", kind = kind, target = target, rect = prect(f), cx = cx, cy = cy }
  local ok, minW, minH, maxW, maxH = pcall(function() return f:GetResizeBounds() end)
  if ok and minW then
    local k = physScale(f)
    msg.min = { floor(minW * k + 0.5), floor(minH * k + 0.5) }
    if maxW and maxW > 0 then msg.max = { floor(maxW * k + 0.5), floor(maxH * k + 0.5) } end
  end
  ns.Send(msg, true)
end

function Layout.StopDrag()
  ns.Send({ t = "dragstop" }, true)
  Layout.Send()
end

function Layout.Init()
  local f = CreateFrame("Frame")
  f:RegisterEvent("DISPLAY_SIZE_CHANGED")
  f:RegisterEvent("UI_SCALE_CHANGED")
  f:SetScript("OnEvent", function()
    C_Timer.After(0.2, Layout.Dirty)
  end)
  for _, name in ipairs(OCCLUDERS) do
    local occ = usable(name)
    if occ then
      pcall(occ.HookScript, occ, "OnShow", scheduleCheck)
      pcall(occ.HookScript, occ, "OnHide", scheduleCheck)
    end
  end
  UIParent:HookScript("OnShow", function() Layout.Send() end)
  UIParent:HookScript("OnHide", function() Layout.Send() end)
  -- Periodic refresh so Familiar started after login still learns the layout: every few seconds
  -- while the window is open, less often while it is closed (only the tracker and minimap mark).
  C_Timer.NewTicker(4, function()
    if GetTime() - lastSent > (ns.UI.IsShown() and 3.5 or 15) then Layout.Send() end
  end)
  Layout.Send()
end

-- Quest tracker: a small movable frame whose lines (active quests, what each familiar is doing,
-- pending approvals) are painted by the overlay. Clicks on a line open that quest.
local _, ns = ...

local Tracker = {}
ns.Tracker = Tracker

local frame

function Tracker.Init()
  local db = ns.db.tracker
  frame = CreateFrame("Frame", "FamiliarTracker", UIParent, "BackdropTemplate")
  Tracker.frame = frame
  frame:SetBackdrop(ns.BACKDROP_PANE)
  -- No native fill: the Glass paints the tracker's background, and a second one made a double box.
  frame:SetBackdropColor(0, 0, 0, 0)
  frame:SetBackdropBorderColor(0.5, 0.4, 0.2, 0.6)
  frame:SetSize(db.w, db.h)
  frame:SetPoint(db.point, UIParent, db.point, db.x, db.y)
  frame:SetFrameStrata("MEDIUM")
  frame:SetMovable(true)
  frame:SetResizable(true)
  frame:SetClampedToScreen(true)
  if frame.SetResizeBounds then frame:SetResizeBounds(160, 60, 600, 600) else frame:SetMinResize(160, 60) end

  local header = CreateFrame("Frame", nil, frame)
  header:SetPoint("TOPLEFT", 4, -3)
  header:SetPoint("TOPRIGHT", -4, -3)
  header:SetHeight(16)
  header:EnableMouse(true)
  header:RegisterForDrag("LeftButton")
  header:SetScript("OnDragStart", function()
    frame:StartMoving()
    ns.Layout.StartDrag("move", "tracker")
  end)
  header:SetScript("OnDragStop", function()
    frame:StopMovingOrSizing()
    local p, _, _, x, y = frame:GetPoint()
    db.point, db.x, db.y = p, math.floor(x + 0.5), math.floor(y + 0.5)
    ns.Layout.StopDrag()
  end)
  header:SetScript("OnMouseUp", function(_, button)
    if button == "RightButton" then Tracker.Toggle() end
  end)
  local title = header:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  title:SetPoint("LEFT", 2, 0)
  title:SetText("|TInterface\\Icons\\Ability_Hunter_Pet_Owl:12|t Familiars")

  frame.content = CreateFrame("Frame", nil, frame)
  frame.content:SetPoint("TOPLEFT", 6, -20)
  frame.content:SetPoint("BOTTOMRIGHT", -6, 6)
  ns.UI.MakeSurface(frame.content, "tracker")
  -- The Glass selects the clicked quest; open the window so its details are visible.
  frame.content:HookScript("OnMouseUp", function(_, button)
    if button == "LeftButton" then ns.UI.Show() end
  end)
  Tracker.content = frame.content

  local grip = CreateFrame("Button", nil, frame)
  grip:SetSize(12, 12)
  grip:SetPoint("BOTTOMRIGHT", -2, 2)
  grip:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
  grip:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
  grip:SetScript("OnMouseDown", function()
    frame:StartSizing("BOTTOMRIGHT")
    ns.Layout.StartDrag("size", "tracker")
  end)
  grip:SetScript("OnMouseUp", function()
    frame:StopMovingOrSizing()
    db.w, db.h = math.floor(frame:GetWidth() + 0.5), math.floor(frame:GetHeight() + 0.5)
    ns.Layout.StopDrag()
  end)

  frame:SetScript("OnShow", function() ns.Layout.Dirty() end)
  frame:SetScript("OnHide", function() ns.Layout.Dirty() end)
  frame:SetShown(db.shown)
end

function Tracker.IsShown() return frame and frame:IsShown() end

function Tracker.Toggle()
  ns.UI.SetFocusMode(false)
  ns.db.tracker.shown = not frame:IsShown()
  frame:SetShown(ns.db.tracker.shown)
end

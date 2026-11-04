-- Minimap button: left-click toggles the window, right-click toggles the tracker, drag to move.
local _, ns = ...

local Minimap_ = {}
ns.Minimap = Minimap_

local function place(btn, angle)
  local r = (Minimap:GetWidth() / 2) + 6
  btn:SetPoint("CENTER", Minimap, "CENTER", math.cos(math.rad(angle)) * r, math.sin(math.rad(angle)) * r)
end

function Minimap_.Init()
  local db = ns.db.minimap
  if db.hide then return end
  local btn = CreateFrame("Button", "FamiliarMinimapButton", Minimap)
  Minimap_.button = btn -- Layout reports its rect (layout.mini) so the Glass can mark it
  btn:SetSize(31, 31)
  btn:SetFrameStrata("MEDIUM")
  btn:SetFrameLevel(8)
  btn:RegisterForClicks("LeftButtonUp", "RightButtonUp")
  btn:RegisterForDrag("LeftButton")
  btn:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
  -- Mainline minimap-button geometry (same as LibDBIcon's retail branch): dark disc, trimmed icon, ring.
  local background = btn:CreateTexture(nil, "BACKGROUND")
  background:SetTexture("Interface\\Minimap\\UI-Minimap-Background")
  background:SetSize(24, 24)
  background:SetPoint("CENTER")
  local icon = btn:CreateTexture(nil, "ARTWORK")
  ns.SetIcon(icon) -- our own round face; the game's imp, trimmed of its square bevel, if the client refuses it
  icon:SetSize(18, 18)
  icon:SetPoint("CENTER")
  local border = btn:CreateTexture(nil, "OVERLAY")
  border:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
  border:SetSize(50, 50)
  border:SetPoint("TOPLEFT")
  place(btn, db.angle)

  btn:SetScript("OnClick", function(_, button)
    if button == "RightButton" then ns.Tracker.Toggle() else ns.UI.Toggle() end
  end)
  btn:SetScript("OnDragStart", function(self)
    self:SetScript("OnUpdate", function()
      local mx, my = Minimap:GetCenter()
      local cx, cy = GetCursorPosition()
      local s = Minimap:GetEffectiveScale()
      db.angle = math.deg(math.atan2(cy / s - my, cx / s - mx))
      self:ClearAllPoints()
      place(self, db.angle)
    end)
  end)
  btn:SetScript("OnDragStop", function(self)
    self:SetScript("OnUpdate", nil)
    ns.Layout.Dirty() -- the reported rect (layout.mini) follows the move
  end)
  btn:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_LEFT")
    GameTooltip:AddLine("Familiar", 1, 0.82, 0)
    GameTooltip:AddLine("Left-click: Quest Log", 1, 1, 1)
    GameTooltip:AddLine("Right-click: quest tracker", 1, 1, 1)
    GameTooltip:AddLine("Drag: move", 0.6, 0.6, 0.6)
    GameTooltip:Show()
  end)
  btn:SetScript("OnLeave", GameTooltip_Hide)
end

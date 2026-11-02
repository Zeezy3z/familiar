-- Options -> AddOns -> Familiar: window background opacity (also /fam opacity <0-100>).
local _, ns = ...

local Options = {}
ns.Options = Options

local category, setting

-- One way in for both the slider and the slash command: the setting writes FamiliarDB.opacity and
-- its callback repaints, so the slider always shows the current value.
function Options.SetOpacity(pct)
  pct = math.max(0, math.min(100, math.floor((tonumber(pct) or 100) + 0.5)))
  if setting then setting:SetValue(pct) else ns.UI.ApplyOpacity(pct) end
end

function Options.Open()
  if category then Settings.OpenToCategory(category:GetID()) end
end

function Options.Init()
  ns.UI.ApplyOpacity(ns.db.opacity)
  if not (Settings and Settings.RegisterVerticalLayoutCategory) then return end -- /fam opacity still works
  category = Settings.RegisterVerticalLayoutCategory("Familiar")
  setting = Settings.RegisterAddOnSetting(category, "FAMILIAR_OPACITY", "opacity", ns.db, Settings.VarType.Number, "Window opacity", 100)
  setting:SetValueChangedCallback(function(_, value) ns.UI.ApplyOpacity(value) end)
  local slider = Settings.CreateSliderOptions(0, 100, 5)
  slider:SetLabelFormatter(MinimalSliderWithSteppersMixin.Label.Right, function(v) return ("%d%%"):format(v) end)
  Settings.CreateSlider(category, setting, slider,
    "How solid the Familiar window's background is. Text, borders and buttons stay solid: lower it to see the game through the window.")
  Settings.RegisterAddOnCategory(category)
end

-- Options -> AddOns -> Familiar: window background opacity.
local _, ns = ...

local Options = {}
ns.Options = Options

-- The setting writes FamiliarDB.opacity and its callback repaints, so the slider always shows the
-- current value.
function Options.Init()
  ns.UI.ApplyOpacity(ns.db.opacity)
  if not (Settings and Settings.RegisterVerticalLayoutCategory) then return end
  local category = Settings.RegisterVerticalLayoutCategory("Familiar")
  local setting = Settings.RegisterAddOnSetting(category, "FAMILIAR_OPACITY", "opacity", ns.db, Settings.VarType.Number, "Window opacity", 100)
  setting:SetValueChangedCallback(function(_, value) ns.UI.ApplyOpacity(value) end)
  local slider = Settings.CreateSliderOptions(60, 100, 5)
  slider:SetLabelFormatter(MinimalSliderWithSteppersMixin.Label.Right, function(v) return ("%d%%"):format(v) end)
  Settings.CreateSlider(category, setting, slider,
    "How solid the Familiar window's background is. Text, borders and buttons stay solid: lower it to see the game through the window. Below 60% the text becomes hard to read, so the slider stops there.")
  Settings.RegisterAddOnCategory(category)
end

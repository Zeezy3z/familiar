-- Minimal World of Warcraft client mock for running the Familiar addon headlessly in fengari.
-- Records every widget method and global the addon touches so tests can check them against the
-- WoW: Forever API surface (test/fixtures/wow-api.json).

MOCK = {
  time = 100, cursor = { 700, 500 }, shift = false, ctrl = false,
  timers = {}, frames = {}, events = {}, chat = {},
  methodsCalled = {}, missingGlobals = {}, usedGlobals = {},
}

local Methods = {}
local FrameMT = {
  __index = function(t, k)
    if type(k) ~= "string" or k:sub(1, 2) == "__" then return nil end
    MOCK.methodsCalled[k] = true
    local impl = Methods[k]
    if impl then return impl end
    return function() end
  end,
}

local function fire(self, script, ...)
  local f = rawget(self, "__scripts")[script]
  if f then return f(self, ...) end
end
MOCK.fire = fire

local function newObj(kind, name, parent)
  local o = setmetatable({
    __kind = kind, __name = name, __parent = parent, __shown = true, __scripts = {},
    __w = 100, __h = 20, __scale = 1, __text = "", __x = 100, __y = 100, __level = 1,
  }, FrameMT)
  MOCK.frames[#MOCK.frames + 1] = o
  return o
end
MOCK.newObj = newObj

-- Geometry: every frame sits at (__x, __y) bottom-left with its size, in its own scale.
Methods.SetScript = function(self, s, f) self.__scripts[s] = f end
Methods.GetScript = function(self, s) return self.__scripts[s] end
Methods.HookScript = function(self, s, f)
  local prev = self.__scripts[s]
  self.__scripts[s] = prev and function(...) prev(...); f(...) end or f
end
Methods.RegisterEvent = function(self, e)
  MOCK.events[e] = MOCK.events[e] or {}
  table.insert(MOCK.events[e], self)
end
Methods.UnregisterEvent = function() end
Methods.Show = function(self) local was = self.__shown; self.__shown = true; if not was then fire(self, "OnShow") end end
Methods.Hide = function(self) local was = self.__shown; self.__shown = false; if was then fire(self, "OnHide") end end
Methods.SetShown = function(self, on) if on then Methods.Show(self) else Methods.Hide(self) end end
Methods.IsShown = function(self) return self.__shown end
Methods.IsVisible = function(self)
  local f = self
  while f do
    if not f.__shown then return false end
    f = f.__parent
  end
  return true
end
Methods.SetSize = function(self, w, h) self.__w, self.__h = w, h; fire(self, "OnSizeChanged", w, h) end
Methods.SetWidth = function(self, w) self.__w = w end
Methods.SetHeight = function(self, h) self.__h = h end
Methods.GetWidth = function(self) return self.__w end
Methods.GetHeight = function(self) return self.__h end
Methods.GetSize = function(self) return self.__w, self.__h end
Methods.SetPoint = function(self, point, rel, relPoint, x, y)
  if type(rel) == "number" then x, y, rel, relPoint = rel, relPoint, self.__parent, point end
  self.__point = { point, rel or self.__parent or UIParent, relPoint or point, x or 0, y or 0 }
end
Methods.ClearAllPoints = function() end
Methods.SetAllPoints = function() end
Methods.GetPoint = function(self)
  return unpack(self.__point or { "CENTER", UIParent, "CENTER", 0, 0 })
end
Methods.GetRect = function(self) return self.__x, self.__y, self.__w, self.__h end
Methods.GetLeft = function(self) return self.__x end
Methods.GetBottom = function(self) return self.__y end
Methods.GetRight = function(self) return self.__x + self.__w end
Methods.GetTop = function(self) return self.__y + self.__h end
Methods.GetCenter = function(self) return self.__x + self.__w / 2, self.__y + self.__h / 2 end
Methods.SetScale = function(self, s) self.__scale = s end
Methods.GetScale = function(self) return self.__scale end
Methods.GetEffectiveScale = function(self)
  if self.__ignoreParentScale or not self.__parent then return self.__scale end
  return self.__scale * self.__parent:GetEffectiveScale()
end
Methods.SetIgnoreParentScale = function(self, on) self.__ignoreParentScale = on end
Methods.CreateTexture = function(self) return newObj("Texture", nil, self) end
Methods.CreateFontString = function(self) return newObj("FontString", nil, self) end
Methods.SetText = function(self, t) self.__text = t or ""; fire(self, "OnTextChanged", false) end
Methods.GetText = function(self) return self.__text end
Methods.Insert = function(self, t) self.__text = self.__text .. t end
Methods.SetCursorPosition = function(self, value) self.__cursor = value end
Methods.GetCursorPosition = function(self) return self.__cursor or 0 end
Methods.HighlightText = function(self, first, last) self.__selection = { first, last } end
Methods.SetResizeBounds = function(self, ...) self.__bounds = { ... } end
Methods.GetResizeBounds = function(self) return unpack(self.__bounds or {}) end
Methods.HasFocus = function(self) return self.__focus or false end
Methods.SetFocus = function(self) self.__focus = true; fire(self, "OnEditFocusGained") end
Methods.ClearFocus = function(self) self.__focus = false; fire(self, "OnEditFocusLost") end
Methods.IsMouseOver = function(self) return MOCK.mouseOver == self end
Methods.GetFrameLevel = function(self) return self.__level end
Methods.SetFrameLevel = function(self, l) self.__level = l end
Methods.SetColorTexture = function(self, r, g, b, a) self.__color = { r, g, b, a or 1 } end
-- BackdropTemplateMixin: a different backdrop is re-applied with an opaque white colour.
Methods.SetBackdrop = function(self, info)
  if self.__backdrop == info then return end
  self.__backdrop, self.__bg = info, { 1, 1, 1, 1 }
end
Methods.SetBackdropColor = function(self, r, g, b, a) self.__bg = { r, g, b, a or 1 } end
Methods.SetBackdropBorderColor = function(self, r, g, b, a) self.__border = { r, g, b, a or 1 } end

-- Global API --------------------------------------------------------------------------------------
function CreateFrame(kind, name, parent, template)
  local f = newObj(kind, name, parent or UIParent)
  if name then _G[name] = f end
  if template and template:find("ScrollFrame") then f.ScrollBar = newObj("Slider", nil, f) end
  return f
end
UIParent = newObj("Frame", "UIParent")
UIParent.__w, UIParent.__h, UIParent.__x, UIParent.__y = 1364, 768, 0, 0
UIParent.__scale = 0.8
WorldFrame = newObj("Frame", "WorldFrame")
Minimap = newObj("Frame", "Minimap", UIParent)
Minimap.__w, Minimap.__h = 140, 140
GameTooltip = newObj("GameTooltip", "GameTooltip", UIParent)
GameTooltip.__shown = false
DEFAULT_CHAT_FRAME = newObj("ScrollingMessageFrame", "ChatFrame1", UIParent)
Methods.AddMessage = function(self, msg) if self == DEFAULT_CHAT_FRAME then MOCK.chat[#MOCK.chat + 1] = msg end end
ChatFontNormal, GameFontNormal, GameFontNormalSmall, GameFontHighlightSmall, GameFontDisableSmall = {}, {}, {}, {}, {}
SlashCmdList, UISpecialFrames = {}, {}

-- Options -> AddOns (Blizzard_Settings): records what the addon registers. An add-on setting
-- writes its saved variable and calls its value-changed callbacks with (setting, value).
MOCK.settings = {}
Settings = {
  VarType = { Boolean = "boolean", Number = "number", String = "string" },
  RegisterVerticalLayoutCategory = function(name)
    MOCK.settings.category, MOCK.settings.categoryId = name, 4242
    return { GetID = function() return 4242 end }, {}
  end,
  RegisterAddOnSetting = function(_, _, key, tbl, _, name, default)
    if tbl[key] == nil then tbl[key] = default end
    local s = { name = name, callbacks = {} }
    function s:GetValue() return tbl[key] end
    function s:SetValue(v)
      tbl[key] = v
      for _, cb in ipairs(self.callbacks) do cb(self, v) end
    end
    function s:SetValueChangedCallback(cb) table.insert(self.callbacks, cb) end
    MOCK.settings.setting = s
    return s
  end,
  CreateSliderOptions = function(min, max, step)
    local o = { min = min, max = max, step = step }
    function o:SetLabelFormatter(_, fn) self.format = fn end
    return o
  end,
  CreateSlider = function(_, setting, options, tooltip)
    MOCK.settings.slider = { name = setting.name, min = options.min, max = options.max, step = options.step, tooltip = tooltip }
  end,
  RegisterAddOnCategory = function() MOCK.settings.registered = true end,
  OpenToCategory = function(id) MOCK.settings.opened = id end,
}
MinimalSliderWithSteppersMixin = { Label = { Right = 3 } }

function GetPhysicalScreenSize() return 1739, 979 end
function GetTime() return MOCK.time end
function GetServerTime() return 1791300000 + math.floor(MOCK.time) end
function GetCursorPosition() return MOCK.cursor[1], MOCK.cursor[2] end
function GetMouseFoci() return { MOCK.mouseOver } end
function IsShiftKeyDown() return MOCK.shift end
function IsControlKeyDown() return MOCK.ctrl end
function GetBuildInfo() return "1.60.1", "70009", "Oct 1 2026", 16001 end
function UnitName() return "Grailz" end
function UnitLevel() return 20 end
function UnitClass() return "Rogue", "ROGUE", 4 end
function UnitRace() return "Night Elf", "NightElf", 4 end
function UnitFactionGroup() return "Alliance", "Alliance" end
function GetZoneText() return "Darkshore" end
function GetSubZoneText() return "Auberdine" end
function GetRealmName() return "Deathweaver" end
function GetLocale() return "enUS" end
function GameTooltip_Hide() GameTooltip:Hide() end
function ScrollingEdit_OnLoad(self) self.cursorOffset, self.cursorHeight = 0, 0 end
function ScrollingEdit_OnTextChanged() end
function ScrollingEdit_OnCursorChanged() end
function ScrollingEdit_OnUpdate() end
function strtrim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
date = os.date
C_AddOns = { GetAddOnMetadata = function(_, key) return key == "Version" and "0.1.0-test" or nil end }
C_UI = { Reload = function() MOCK.reloaded = true end }
-- Quest log: MOCK.quests = { {header = "Westfall"}, {id = 2359, title = "...", level = 20, complete = false, objectives = {{text = "...", finished = false}}} }
MOCK.quests = {}
C_QuestLog = {
  GetNumQuestLogEntries = function() return #MOCK.quests end,
  GetInfo = function(i)
    local q = MOCK.quests[i]
    if not q then return nil end
    if q.header then return { title = q.header, isHeader = true } end
    return { title = q.title, questID = q.id, level = q.level, isHeader = false, isHidden = false }
  end,
  GetQuestObjectives = function(id)
    for _, q in ipairs(MOCK.quests) do if q.id == id then return q.objectives end end
  end,
  IsComplete = function(id)
    for _, q in ipairs(MOCK.quests) do if q.id == id then return q.complete end end
    return false
  end,
  IsFailed = function() return false end,
}
C_Timer = {
  After = function(d, f) table.insert(MOCK.timers, { at = MOCK.time + d, f = f }) end,
  NewTicker = function(d, f)
    local t = { at = MOCK.time + d, f = f, every = d }
    table.insert(MOCK.timers, t)
    return { Cancel = function() t.cancel = true end }
  end,
}

function MOCK.event(name, ...)
  for _, f in ipairs(MOCK.events[name] or {}) do fire(f, "OnEvent", name, ...) end
end

-- Advance the clock, running OnUpdate for visible frames and due timers.
function MOCK.advance(seconds)
  local steps = math.floor(seconds / 0.016 + 0.5)
  for _ = 1, steps do
    MOCK.time = MOCK.time + 0.016
    for i = #MOCK.timers, 1, -1 do
      local t = MOCK.timers[i]
      if t.cancel then table.remove(MOCK.timers, i)
      elseif MOCK.time >= t.at then
        if t.every then t.at = t.at + t.every else table.remove(MOCK.timers, i) end
        t.f()
      end
    end
    for _, f in ipairs(MOCK.frames) do
      local u = rawget(f, "__scripts").OnUpdate
      if u and f:IsVisible() then u(f, 0.016) end
    end
  end
end

-- Record defined globals the addon reads, and flag undefined ones.
local defined = {}
for k in pairs(_G) do defined[k] = true end
MOCK.defined = defined
setmetatable(_G, {
  __index = function(_, k)
    MOCK.missingGlobals[k] = true
    return nil
  end,
})

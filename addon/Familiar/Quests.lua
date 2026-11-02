-- Quest log snapshot for chats: your quests and objective progress, read from the game's own API
-- (reading only — nothing here changes the quest log). Sent when it changes, so "how do I finish
-- my poison quest?" is answered about the quest and step you are actually on.
local _, ns = ...

local Quests = {}
ns.Quests = Quests

local lastSent

-- One line per quest: "Title [lvl 20, id 2359] (ready to turn in): [x] Obj 1; [ ] Obj 2 (3/8)".
function Quests.Snapshot()
  local lines = {}
  for i = 1, C_QuestLog.GetNumQuestLogEntries() do
    local info = C_QuestLog.GetInfo(i)
    if info and not info.isHeader and not info.isHidden and info.questID then
      local id = info.questID
      local objectives = {}
      for _, o in ipairs(C_QuestLog.GetQuestObjectives(id) or {}) do
        objectives[#objectives + 1] = (o.finished and "[x] " or "[ ] ") .. (o.text or "")
      end
      local state = C_QuestLog.IsComplete(id) and " (ready to turn in)" or (C_QuestLog.IsFailed(id) and " (failed)" or "")
      lines[#lines + 1] = ("%s [lvl %s, id %d]%s: %s"):format(info.title or "?", tostring(info.level or "?"), id, state,
        #objectives > 0 and table.concat(objectives, "; ") or "no objectives listed")
    end
  end
  return table.concat(lines, "\n")
end

-- force: send even if unchanged (the companion may have restarted and lost the last copy).
function Quests.Send(force)
  if not ns.db.chatContext then return end
  local ok, text = pcall(Quests.Snapshot)
  if not ok or (text == lastSent and not force) then return end
  lastSent = text
  ns.Send({ t = "quests", text = text }, false, "quests")
end

function Quests.Init()
  local f = CreateFrame("Frame")
  f:RegisterEvent("QUEST_LOG_UPDATE")
  local pending = false
  -- QUEST_LOG_UPDATE fires on every kill and loot: send at most once every few seconds.
  f:SetScript("OnEvent", ns.Guard("quest log", function()
    if pending then return end
    pending = true
    C_Timer.After(4, function()
      pending = false
      Quests.Send()
    end)
  end, true))
  Quests.Send(true)
  C_Timer.NewTicker(300, ns.Guard("quest log refresh", function() Quests.Send(true) end, true))
end

-- Runestrip uplink: encodes outgoing messages into a grid of solid-colour cells that the
-- Familiar companion reads from the screen. Byte protocol mirrors companion/src/link/codec.ts
-- (see docs/protocol.md). Nothing here reads input from outside the game; it only draws.
local _, ns = ...

local Link = {}
ns.Link = Link

local floor, min, max, random = math.floor, math.min, math.max, math.random
local byte, sub = string.byte, string.sub
local bxor = bit.bxor

Link.MAGIC = 0x46
Link.VERSION = 1
Link.HEADER = 13
Link.FINDER_CELLS = 8
Link.FLAG_IDLE = 1
Link.FLAG_REPEAT = 2
Link.FINDER = {
  { 255, 0, 255 }, { 0, 255, 0 }, { 0, 0, 0 }, { 85, 85, 85 },
  { 170, 170, 170 }, { 255, 255, 255 }, { 0, 255, 255 }, { 255, 255, 0 },
}
-- Channel levels per palette (must match companion/src/link/codec.ts PALETTES). "dim" keeps the
-- data cells near-black; the decoder calibrates from the ramp cells, which use the same levels.
Link.PALETTES = {
  vivid = { [0] = 0, 85 / 255, 170 / 255, 1 },
  dim = { [0] = 0, 28 / 255, 56 / 255, 84 / 255 },
}
local LEVEL = Link.PALETTES.vivid

function Link.SetPalette(name)
  LEVEL = Link.PALETTES[name] or Link.PALETTES.vivid
  Link.palette = Link.PALETTES[name] and name or "vivid"
end
Link.palette = "vivid"

-- RGB (0..1) of finder cell i (1..8): detection cells stay vivid, ramp cells follow the palette.
function Link.FinderColor(i)
  if i >= 3 and i <= 6 then
    local v = LEVEL[i - 3]
    return v, v, v
  end
  local f = Link.FINDER[i]
  return f[1] / 255, f[2] / 255, f[3] / 255
end

-- CRC-16/CCITT-FALSE ---------------------------------------------------------------------------
local CRC = {}
for i = 0, 255 do
  local c = i * 256
  for _ = 1, 8 do
    if c >= 32768 then c = bxor((c * 2) % 65536, 0x1021) else c = (c * 2) % 65536 end
  end
  CRC[i] = c
end

function Link.crc16(b, n)
  local crc = 0xFFFF
  for i = 1, n do
    crc = bxor((crc * 256) % 65536, CRC[bxor(floor(crc / 256), b[i]) % 256])
  end
  return crc
end

-- Capacity / packing ---------------------------------------------------------------------------
function Link.frameCapacity(cols, rows)
  return floor((cols * rows - Link.FINDER_CELLS) * 6 / 8)
end

function Link.payloadCapacity(cols, rows)
  return Link.frameCapacity(cols, rows) - Link.HEADER - 2
end

-- The largest message (encoded bytes) the strip can carry: 255 frames.
function Link.maxPayload()
  return Link.payloadCapacity(Link.cols, Link.rows) * 255
end

-- bytes (1-based array of 0..255) -> symbols (1-based array of 0..63), exactly `count` long
function Link.bytesToSymbols(b, count)
  local out, s, n = {}, 0, #b
  local i = 1
  while s < count do
    local v = (b[i] or 0) * 65536 + (b[i + 1] or 0) * 256 + (b[i + 2] or 0)
    if i > n then v = 0 end
    out[s + 1] = floor(v / 262144) % 64; s = s + 1
    if s < count then out[s + 1] = floor(v / 4096) % 64; s = s + 1 end
    if s < count then out[s + 1] = floor(v / 64) % 64; s = s + 1 end
    if s < count then out[s + 1] = v % 64; s = s + 1 end
    i = i + 3
  end
  return out
end

-- Build the full cell list (1-based, row-major) of symbols for one frame. Finder cells are
-- negative (-1..-8) so the renderer paints the fixed finder colours.
function Link.encodeFrame(cols, rows, seq, flags, msgId, chunkIdx, chunkCount, payload)
  local len = #payload
  local b = {
    Link.MAGIC, Link.VERSION, cols, rows,
    floor(seq / 256) % 256, seq % 256, flags % 256,
    floor(msgId / 256) % 256, msgId % 256,
    chunkIdx % 256, chunkCount % 256,
    floor(len / 256) % 256, len % 256,
  }
  for i = 1, len do b[Link.HEADER + i] = byte(payload, i) end
  local crc = Link.crc16(b, Link.HEADER + len)
  b[#b + 1] = floor(crc / 256)
  b[#b + 1] = crc % 256
  local total = cols * rows
  local syms = Link.bytesToSymbols(b, total - Link.FINDER_CELLS)
  local cells = {}
  for i = 1, Link.FINDER_CELLS do cells[i] = -i end
  for i = 1, #syms do cells[Link.FINDER_CELLS + i] = syms[i] end
  return cells
end

function Link.symbolColor(sym)
  return LEVEL[floor(sym / 16) % 4], LEVEL[floor(sym / 4) % 4], LEVEL[sym % 4]
end

-- Outbox / scheduler ---------------------------------------------------------------------------
-- A message is a string; it is split into frames that each stay on screen for at least
-- `hold` seconds and `minFrames` rendered frames so a 30 fps capture never misses one.

Link.cols = 64
Link.rows = 4
Link.cell = 4 -- physical pixels per cell
Link.hold = 0.07
Link.minFrames = 2
Link.idleCols = 32 -- idle beacon is a single thin row

local queue = {} -- pending frames: { cols, rows, flags, msgId, idx, count, payload, key, urgent }
local msgId = random(0, 65535)
local seq = random(0, 65535)
local current, shownAt, shownFrames = nil, 0, 0
local lastIdleBump = 0

function Link.Enqueue(payload, opts)
  opts = opts or {}
  local cols, rows = Link.cols, Link.rows
  local cap = Link.payloadCapacity(cols, rows)
  if #payload > Link.maxPayload() then return false end
  local count = max(1, floor((#payload + cap - 1) / cap))
  -- Coalesce: a keyed message (e.g. "layout") replaces queued frames with that key, except the
  -- rest of a message whose first chunks are already on screen (cutting it would lose it).
  if opts.key then
    local inFlight = current and not current.idle and current.key == opts.key and current.msgId or nil
    for i = #queue, 1, -1 do
      if queue[i].key == opts.key and queue[i].msgId ~= inFlight then table.remove(queue, i) end
    end
  end
  msgId = (msgId + 1) % 65536
  -- Urgent messages (moves, clicks, wheel, keys, layout) go ahead of background traffic (the quest
  -- log, hello), keeping their own order. The companion reassembles chunks per message id, so a
  -- background message may be interleaved.
  local at
  if opts.urgent then
    at = #queue + 1
    for i = 1, #queue do
      if not queue[i].urgent then at = i break end
    end
  end
  local function push(flags)
    for i = 0, count - 1 do
      local f = {
        cols = cols, rows = rows, flags = flags, msgId = msgId, idx = i, count = count,
        payload = sub(payload, i * cap + 1, (i + 1) * cap), key = opts.key, urgent = opts.urgent,
      }
      if at then
        table.insert(queue, at, f)
        at = at + 1
      else
        queue[#queue + 1] = f
      end
    end
  end
  push(0)
  if opts.reliable then push(Link.FLAG_REPEAT) end
  return true
end

function Link.QueueDepth() return #queue end

-- Returns the cells to show now, or nil if the current frame should stay.
function Link.Step(now)
  shownFrames = shownFrames + 1
  if current and (now - shownAt < Link.hold or shownFrames < Link.minFrames) then return nil end
  local nextF = table.remove(queue, 1)
  if nextF then
    seq = (seq + 1) % 65536
    current = nextF
    shownAt, shownFrames = now, 0
    return Link.encodeFrame(nextF.cols, nextF.rows, seq, nextF.flags, nextF.msgId, nextF.idx, nextF.count, nextF.payload),
      nextF.cols, nextF.rows
  end
  -- Idle beacon: a thin row whose seq ticks once a second (heartbeat).
  if not current or not current.idle or now - lastIdleBump >= 1 then
    lastIdleBump = now
    seq = (seq + 1) % 65536
    current = { idle = true }
    shownAt, shownFrames = now, 0
    return Link.encodeFrame(Link.idleCols, 1, seq, Link.FLAG_IDLE, 0, 0, 1, ""), Link.idleCols, 1
  end
  return nil
end

-- Rendering ------------------------------------------------------------------------------------
local strip, cellTex = nil, {}

-- 1 strip unit == 1 physical pixel: ignore UIParent's scale and use 768/physicalHeight.
local function pixelScale()
  local _, physH = GetPhysicalScreenSize()
  return 768 / physH
end

function Link.ApplyGeometry()
  if not strip then return end
  strip:SetIgnoreParentScale(true)
  strip:SetScale(pixelScale())
  strip:ClearAllPoints()
  local pos = ns.db and ns.db.stripPos or "TOPLEFT"
  local ox = (pos == "TOPLEFT" or pos == "BOTTOMLEFT") and 1 or -1
  local oy = (pos == "TOPLEFT" or pos == "TOPRIGHT") and -1 or 1
  strip:SetPoint(pos, UIParent, pos, ox * (ns.db and ns.db.stripInset or 0), oy * (ns.db and ns.db.stripInset or 0))
  strip:SetSize(Link.cols * Link.cell, Link.rows * Link.cell)
  for i, tex in ipairs(cellTex) do
    local c = (i - 1) % Link.cols
    local r = floor((i - 1) / Link.cols)
    tex:ClearAllPoints()
    tex:SetSize(Link.cell, Link.cell)
    tex:SetPoint("TOPLEFT", strip, "TOPLEFT", c * Link.cell, -r * Link.cell)
  end
end

local function paint(cells, cols, rows)
  local n = cols * rows
  for r = 0, Link.rows - 1 do
    for c = 0, Link.cols - 1 do
      local tex = cellTex[r * Link.cols + c + 1]
      if c < cols and r < rows then
        local sym = cells[r * cols + c + 1]
        if sym < 0 then
          local r, g, b = Link.FinderColor(-sym)
          tex:SetColorTexture(r, g, b, 1)
        else
          tex:SetColorTexture(Link.symbolColor(sym))
        end
        tex:Show()
      else
        tex:Hide()
      end
    end
  end
  return n
end

function Link.Init()
  -- Parented to WorldFrame (anchored to UIParent's corner) so it keeps running when the UI is
  -- hidden with Alt+Z; the addon then reports ui=false and the companion hides the Glass at once.
  strip = CreateFrame("Frame", "FamiliarRunestrip", WorldFrame)
  strip:SetFrameStrata("TOOLTIP")
  strip:SetFrameLevel(9000)
  strip:SetClampedToScreen(true)
  strip:EnableMouse(false)
  for i = 1, Link.cols * Link.rows do
    local tex = strip:CreateTexture(nil, "OVERLAY", nil, 7)
    if tex.SetSnapToPixelGrid then
      tex:SetSnapToPixelGrid(true)
      tex:SetTexelSnappingBias(0)
    end
    cellTex[i] = tex
  end
  Link.ApplyGeometry()
  strip:RegisterEvent("DISPLAY_SIZE_CHANGED")
  strip:RegisterEvent("UI_SCALE_CHANGED")
  strip:SetScript("OnEvent", ns.Guard("strip geometry", function() Link.ApplyGeometry() end, true))
  strip:SetScript("OnUpdate", ns.Guard("strip", function()
    local cells, cols, rows = Link.Step(GetTime())
    if cells then paint(cells, cols, rows) end
  end))
  Link.frame = strip
end

function Link.SetVisible(on)
  if strip then strip:SetShown(on) end
end

-- Minimal JSON encoder (encode only; the addon never receives JSON at runtime).
local _, ns = ...

local Json = {}
ns.Json = Json

local format, gsub, byte, type, pairs, ipairs, tostring = string.format, string.gsub, string.byte, type, pairs, ipairs, tostring
local floor, huge = math.floor, math.huge
local concat, sort = table.concat, table.sort

local ESC = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }

local function escapeChar(c)
  return ESC[c] or format("\\u%04x", byte(c))
end

local function encodeString(s)
  return '"' .. gsub(s, '[%c"\\]', escapeChar) .. '"'
end

local function isArray(t)
  local n = #t
  if n == 0 then return next(t) == nil end
  for k in pairs(t) do
    if type(k) ~= "number" or k < 1 or k > n or floor(k) ~= k then return false end
  end
  return true
end

local encode

local function encodeNumber(v)
  if v ~= v or v == huge or v == -huge then return "null" end
  if floor(v) == v and v > -1e15 and v < 1e15 then return format("%d", v) end
  return format("%.4f", v):gsub("0+$", ""):gsub("%.$", "")
end

encode = function(v)
  local t = type(v)
  if t == "string" then return encodeString(v) end
  if t == "number" then return (encodeNumber(v)) end
  if t == "boolean" then return v and "true" or "false" end
  if t == "table" then
    local parts = {}
    if isArray(v) then
      for i = 1, #v do parts[i] = encode(v[i]) end
      return "[" .. concat(parts, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    sort(keys)
    for i, k in ipairs(keys) do
      local val = v[k]
      if val == nil then val = v[tonumber(k)] end
      parts[i] = encodeString(k) .. ":" .. encode(val)
    end
    return "{" .. concat(parts, ",") .. "}"
  end
  return "null"
end

Json.encode = encode

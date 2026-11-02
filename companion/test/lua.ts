// Runs the real addon Lua files inside fengari (Lua 5.3 in JS) with a tiny WoW shim, so codec
// logic is tested exactly as shipped. WoW is Lua 5.1; we avoid 5.3-only syntax in the addon and
// shim `bit` here.
import * as fs from "node:fs";
import * as path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fengari = require("fengari");
const { lua, lauxlib, lualib, to_luastring } = fengari;

export const ADDON_DIR = path.resolve(__dirname, "../../addon/Familiar");

const PRELUDE = `
bit = {
  bxor = function(a, b) return math.tointeger(a) ~ math.tointeger(b) end,
  band = function(a, b) return math.tointeger(a) & math.tointeger(b) end,
  bor = function(a, b) return math.tointeger(a) | math.tointeger(b) end,
  lshift = function(a, n) return math.tointeger(a) << n end,
  rshift = function(a, n) return math.tointeger(a) >> n end,
}
unpack = table.unpack
NS = {}
function loadAddonFile(path)
  local f = assert(loadfile(path))
  return f("Familiar", NS)
end
`;

export class LuaVM {
  L: any;
  constructor() {
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);
    this.run(PRELUDE);
  }
  run(code: string): string {
    const L = this.L;
    const top = lua.lua_gettop(L);
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK || lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
      const err = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      throw new Error("Lua error: " + err);
    }
    const out = lua.lua_isnil(L, -1) ? "" : lua.lua_tojsstring(L, -1);
    lua.lua_settop(L, top);
    return out;
  }
  loadAddon(...files: string[]) {
    for (const f of files) {
      const p = path.join(ADDON_DIR, f).replace(/\\/g, "/");
      if (!fs.existsSync(p)) throw new Error("missing " + p);
      this.run(`loadAddonFile(${JSON.stringify(p)})`);
    }
  }
}

// Runs the real Familiar addon headlessly (fengari + test/wowmock.lua): boots it, drives the UI
// and slash commands, decodes everything it transmits over the Runestrip, and checks every widget
// method / global it touches against the WoW: Forever API surface.
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeFrameCells, Reassembler, symbolsToBytes, parseFrameBytes, FINDER_CELLS, frameCapacity } from "../src/link/codec";
import { ADDON_DIR, LuaVM } from "./lua";

const api = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/wow-api.json"), "utf8"));
const widget = new Set<string>([...api.widgetMethods, ...api.mixinMethods]);
const globalsApi = new Set<string>([...api.functions, ...api.luaGlobals]);

const tocFiles = fs
  .readFileSync(path.join(ADDON_DIR, "Familiar.toc"), "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.startsWith("#"));

let vm: LuaVM;
const messages: any[] = [];
const ra = new Reassembler((_, p) => messages.push(JSON.parse(new TextDecoder().decode(p))));

function drain() {
  const out = vm.run(`
    local t = MOCK.out or {}
    MOCK.out = {}
    local parts = {}
    for i, f in ipairs(t) do parts[i] = f.cols .. ";" .. f.rows .. ";" .. f.cells end
    return table.concat(parts, "|")`);
  if (!out) return;
  for (const rec of out.split("|")) {
    const [cols, rows, list] = rec.split(";");
    const cells = list.split(",").map(Number);
    const syms = cells.slice(FINDER_CELLS);
    const bytes = symbolsToBytes(syms, frameCapacity(Number(cols), Number(rows)));
    const r = parseFrameBytes(bytes);
    expect(r.ok).toBe(true);
    if (r.ok) ra.push(r.frame);
  }
}

function advance(s: number) {
  vm.run(`MOCK.advance(${s})`);
  drain();
}

const last = (t: string) => [...messages].reverse().find((m) => m.t === t);

beforeAll(() => {
  vm = new LuaVM();
  vm.run(fs.readFileSync(path.join(__dirname, "wowmock.lua"), "utf8"));
  vm.loadAddon(...tocFiles);
  vm.run(`
    local orig = NS.Link.Step
    NS.Link.Step = function(now)
      local cells, cols, rows = orig(now)
      if cells then
        MOCK.out = MOCK.out or {}
        table.insert(MOCK.out, { cols = cols, rows = rows, cells = table.concat(cells, ",") })
      end
      return cells, cols, rows
    end
    MOCK.event("ADDON_LOADED", "Familiar")
    MOCK.event("PLAYER_LOGIN")`);
  advance(3);
});

describe("Familiar addon (headless)", () => {
  it("boots, greets, and reports layout", () => {
    expect(last("hello")).toMatchObject({ t: "hello", char: "Grailz", realm: "Deathweaver", iface: 16001, addon: "0.1.0-test" });
    const l = last("layout");
    expect(l.scr).toEqual([1739, 979]);
    expect(l.panel).toBe(false);
    expect(vm.run(`return MOCK.chat[#MOCK.chat]`)).toContain("ready");
  });

  it("opens the window via /fam and reports touch-surface rects", () => {
    vm.run(`SlashCmdList.FAMILIAR("")`);
    advance(1);
    const l = last("layout");
    expect(l.panel).toBe(true);
    for (const k of ["list", "detail", "status", "win"]) expect(Array.isArray(l[k]), k).toBe(true);
    expect(l.rowH).toBeGreaterThan(0);
    expect(l.keys.approve).toBeTruthy();
    // The companion matches Always / Mode clicks to the real mouse on these rects before acting.
    expect(l.keys.always).toBeTruthy();
    expect(l.keys.mode).toBeTruthy();
  });

  it("sends a prompt from the composer (Enter) and keeps history", () => {
    vm.run(`
      FamiliarComposer:SetText("  Fix the failing tests in the parser  ")
      MOCK.fire(FamiliarComposer, "OnEnterPressed")`);
    advance(1.5);
    expect(last("prompt").text).toBe("Fix the failing tests in the parser");
    expect(vm.run(`return FamiliarComposer:GetText()`)).toBe("");
    expect(vm.run(`return FamiliarDB.history[#FamiliarDB.history]`)).toBe("Fix the failing tests in the parser");
  });

  it("Shift+Enter inserts a newline instead of sending", () => {
    const before = messages.filter((m) => m.t === "prompt").length;
    vm.run(`
      FamiliarComposer:SetText("line one")
      MOCK.shift = true
      MOCK.fire(FamiliarComposer, "OnEnterPressed")
      MOCK.shift = false`);
    advance(1);
    expect(messages.filter((m) => m.t === "prompt").length).toBe(before);
    expect(vm.run(`return FamiliarComposer:GetText()`)).toBe("line one\n");
  });

  it("Ctrl+Up / Down returns to the unfinished draft without sending or changing history", () => {
    const before = messages.filter((m) => m.t === "prompt").length;
    vm.run(`
      NS.db.history = { "older message", "latest message" }
      NS.UI.histIdx = nil
      FamiliarComposer:SetText("unfinished draft\\nwith a second line")
      MOCK.ctrl = true
      MOCK.fire(FamiliarComposer, "OnKeyDown", "UP")`);
    expect(vm.run(`return FamiliarComposer:GetText()`)).toBe("latest message");
    vm.run(`MOCK.fire(FamiliarComposer, "OnKeyDown", "UP") MOCK.fire(FamiliarComposer, "OnKeyDown", "UP")`);
    expect(vm.run(`return FamiliarComposer:GetText()`)).toBe("older message");
    vm.run(`MOCK.fire(FamiliarComposer, "OnKeyDown", "DOWN")`);
    expect(vm.run(`return FamiliarComposer:GetText()`)).toBe("latest message");
    vm.run(`MOCK.fire(FamiliarComposer, "OnKeyDown", "DOWN") MOCK.fire(FamiliarComposer, "OnKeyDown", "DOWN") MOCK.ctrl = false`);
    expect(vm.run(`return FamiliarComposer:GetText()`)).toBe("unfinished draft\nwith a second line");
    advance(1);
    expect(messages.filter((m) => m.t === "prompt").length).toBe(before);
    expect(vm.run(`return table.concat(NS.db.history, "|")`)).toBe("older message|latest message");
    vm.run(`FamiliarComposer:SetText("")`);
  });

  it("a separate slash send preserves the draft buffered during history navigation", () => {
    vm.run(`
      FamiliarComposer:SetText("unfinished draft")
      MOCK.ctrl = true
      MOCK.fire(FamiliarComposer, "OnKeyDown", "UP")
      SlashCmdList.FAMILIAR("separate slash prompt")
      MOCK.fire(FamiliarComposer, "OnKeyDown", "DOWN")
      MOCK.ctrl = false`);
    expect(vm.run(`return FamiliarComposer:GetText()`)).toBe("unfinished draft");
    advance(2);
    expect(last("prompt").text).toBe("separate slash prompt");
    vm.run(`FamiliarComposer:SetText("")`);
  });

  it("long pasted prompts are chunked and reassembled", () => {
    const long = "Refactor the ingest pipeline. ".repeat(80);
    vm.run(`FamiliarComposer:SetText(${JSON.stringify(long)}) MOCK.fire(FamiliarComposer, "OnEnterPressed")`);
    advance(6);
    expect(last("prompt").text).toBe(long.trim());
  });

  it("turns surface clicks and wheel into region-relative events", () => {
    vm.run(`
      local detail = NS.UI.detailPane.content
      detail.__x, detail.__y, detail.__w, detail.__h = 300, 200, 400, 300
      local s = detail:GetEffectiveScale()
      MOCK.cursor = { (300 + 100) * s, (200 + 225) * s }
      MOCK.fire(detail, "OnMouseUp", "LeftButton")
      MOCK.fire(detail, "OnMouseWheel", -1)
      MOCK.fire(detail, "OnMouseWheel", -1)`);
    advance(1);
    const c = last("click");
    expect(c).toMatchObject({ r: "detail", b: "L" });
    expect(c.x).toBeCloseTo(0.25, 3);
    expect(c.y).toBeCloseTo(0.25, 3);
    expect(last("wheel")).toMatchObject({ r: "detail", d: -2 });
    // Window-level fallback: if another frame wins the mouse, the window still routes the wheel.
    vm.run(`MOCK.mouseOver = NS.UI.listPane MOCK.fire(FamiliarFrame, "OnMouseWheel", 1) MOCK.mouseOver = nil`);
    advance(0.5);
    expect(last("wheel")).toMatchObject({ r: "list", d: 1 });
  });

  it("buttons and slash commands send keys and quick quests", () => {
    vm.run(`NS.UI.keys.approve:GetScript("OnClick")()`);
    vm.run(`SlashCmdList.FAMILIAR("deny")`);
    vm.run(`SlashCmdList.FAMILIAR("codex summarize the open PRs")`);
    vm.run(`SlashCmdList.FAMILIAR("what changed today?")`);
    advance(3);
    const keys = messages.filter((m) => m.t === "key").map((m) => m.k);
    expect(keys).toContain("approve");
    expect(keys).toContain("deny");
    expect(messages.filter((m) => m.t === "key" && m.k === "approve").at(-1)).toMatchObject({ src: "button" });
    expect(messages.filter((m) => m.t === "key" && m.k === "deny").at(-1)).toMatchObject({ src: "slash" });
    expect(last("quick")).toMatchObject({ agent: "codex", text: "summarize the open PRs" });
    expect(last("prompt").text).toBe("what changed today?");
  });

  it("/fam suggest sends the idea to the companion as a key, capped at 500 bytes", () => {
    vm.run(`SlashCmdList.FAMILIAR("suggest Add a || pipe Option")`);
    advance(3);
    expect(messages.filter((m) => m.t === "key" && m.k === "suggest").at(-1)).toMatchObject({ a: "Add a | pipe Option" });
    vm.run(`SlashCmdList.FAMILIAR("suggest ${"x".repeat(499)}é")`);
    advance(6);
    expect(messages.filter((m) => m.t === "key" && m.k === "suggest").at(-1)!.a).toBe("x".repeat(499));
  });

  it("un-escapes typed pipes, treats '/fam help me ...' as a prompt, refuses oversized text", () => {
    // WoW edit boxes hand us a typed "|" as "||".
    vm.run(`FamiliarComposer:SetText("grep x || wc -l") MOCK.fire(FamiliarComposer, "OnEnterPressed")`);
    advance(1.5);
    expect(last("prompt").text).toBe("grep x | wc -l");
    vm.run(`SlashCmdList.FAMILIAR("help me fix the build")`);
    vm.run(`SlashCmdList.FAMILIAR("strip the dead code")`);
    advance(2);
    const prompts = messages.filter((m) => m.t === "prompt").map((m) => m.text);
    expect(prompts).toContain("help me fix the build");
    expect(prompts).toContain("strip the dead code");
    const huge = "x".repeat(50_000);
    vm.run(`FamiliarComposer:SetText(string.rep("x", 50000)) MOCK.fire(FamiliarComposer, "OnEnterPressed")`);
    advance(0.5);
    expect(vm.run(`return tostring(#FamiliarComposer:GetText())`)).toBe(String(huge.length));
    expect(vm.run(`return MOCK.chat[#MOCK.chat]`)).toContain("too long");
    vm.run(`FamiliarComposer:SetText("")`);
  });

  it("a newer layout never cuts off a layout already on screen", () => {
    const before = messages.filter((m) => m.t === "layout").length;
    vm.run(`NS.Layout.Send()`);
    advance(0.1); // first chunks of that layout are now showing
    vm.run(`NS.Layout.Send() NS.Layout.Send()`);
    advance(2);
    expect(messages.filter((m) => m.t === "layout").length).toBeGreaterThanOrEqual(before + 2);
  });

  it("strip geometry is pixel-perfect (1 unit = 1 physical px)", () => {
    const eff = Number(vm.run(`return FamiliarRunestrip:GetEffectiveScale()`));
    expect(eff).toBeCloseTo(768 / 979, 6);
    vm.run(`SlashCmdList.FAMILIAR("strip br")`);
    expect(vm.run(`return FamiliarDB.stripPos`)).toBe("BOTTOMRIGHT");
    vm.run(`SlashCmdList.FAMILIAR("strip tl")`);
  });

  it("toggles tracker and native view without errors", () => {
    vm.run(`SlashCmdList.FAMILIAR("tracker") SlashCmdList.FAMILIAR("tracker") SlashCmdList.FAMILIAR("native") SlashCmdList.FAMILIAR("help") SlashCmdList.FAMILIAR("diag") SlashCmdList.FAMILIAR("strip dim") SlashCmdList.FAMILIAR("strip vivid")`);
    expect(vm.run(`return table.concat(MOCK.chat, " | ")`)).toContain("native JSON");
    advance(1);
    expect(last("layout").native).toBe(true);
    vm.run(`SlashCmdList.FAMILIAR("native")`);
    vm.run(`Familiar_OnCompartmentClick(nil, "LeftButton")`);
    advance(1);
  });

  it("reload command calls C_UI.Reload", () => {
    vm.run(`SlashCmdList.FAMILIAR("reload")`);
    expect(vm.run(`return tostring(MOCK.reloaded)`)).toBe("true");
  });

  it("window opacity: Options slider and /fam opacity fade the backgrounds and tell the Glass", () => {
    // Options -> AddOns -> Familiar has the slider, at the saved value (solid by default).
    expect(vm.run(`return MOCK.settings.category`)).toBe("Familiar");
    expect(vm.run(`local s = MOCK.settings.slider return s.name .. " " .. s.min .. "-" .. s.max .. " step " .. s.step`)).toBe("Window opacity 60-100 step 5");
    expect(vm.run(`return MOCK.settings.registered and "yes" or "no"`)).toBe("yes");
    expect(last("layout").op).toBeUndefined();

    vm.run(`SlashCmdList.FAMILIAR("opacity 40%")`);
    advance(1);
    expect(last("layout").op).toBe(40);
    expect(vm.run(`return FamiliarDB.opacity`)).toBe("40");
    expect(vm.run(`return MOCK.settings.setting:GetValue()`)).toBe("40"); // the slider shows it too
    expect(Number(vm.run(`return FamiliarFrame.__bg[4]`))).toBeCloseTo(0.4);
    expect(Number(vm.run(`return NS.UI.listPane.__bg[4]`))).toBeCloseTo(0.85 * 0.4);
    expect(Number(vm.run(`return NS.UI.detailPane.__bg[4]`))).toBeCloseTo(0.85 * 0.4);
    // Only the backgrounds fade: borders stay as they were.
    expect(Number(vm.run(`return NS.UI.listPane.__border[4]`))).toBeCloseTo(0.9);

    // Moving the slider does the same.
    vm.run(`MOCK.settings.setting:SetValue(100)`);
    advance(1);
    expect(last("layout").op).toBeUndefined();
    expect(Number(vm.run(`return FamiliarFrame.__bg[4]`))).toBeCloseTo(1);

    // No number opens the Options page; other words are a prompt, not a setting.
    vm.run(`MOCK.settings.opened = nil SlashCmdList.FAMILIAR("opacity")`);
    expect(vm.run(`return MOCK.settings.opened`)).toBe(vm.run(`return MOCK.settings.categoryId`));
    vm.run(`SlashCmdList.FAMILIAR("opacity seems off")`);
    expect(vm.run(`return FamiliarDB.opacity`)).toBe("100");
  });

  it("a saved window opacity applies at login and survives focus view and back", () => {
    const state = draftBoot(`FamiliarDB = { opacity = 40 }`);
    expect(Number(state.run(`return FamiliarFrame.__bg[4]`))).toBeCloseTo(0.4);
    state.run(`NS.UI.SetFocusMode(true)`);
    expect(Number(state.run(`return FamiliarFrame.__bg[4]`))).toBeCloseTo(0.4);
    state.run(`NS.UI.SetFocusMode(false)`);
    expect(Number(state.run(`return FamiliarFrame.__bg[4]`))).toBeCloseTo(0.4);
  });

  it("exports only the keybinding wrappers: no Send, Link or settings for other addons", () => {
    expect(vm.run(`return type(Familiar.Send) .. ":" .. type(Familiar.SendTracked) .. ":" .. type(Familiar.Link) .. ":" .. type(Familiar.db) .. ":" .. type(Familiar.UI)`)).toBe("nil:nil:nil:nil:nil");
    const xml = fs.readFileSync(path.join(ADDON_DIR, "Bindings.xml"), "utf8");
    const called = [...xml.matchAll(/Familiar\.(\w+)\(/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(5);
    for (const name of new Set(called)) expect(vm.run(`return type(Familiar.${name})`), name).toBe("function");
    const before = messages.length;
    vm.run(`Familiar.Key("approve") Familiar.Key("mode") Familiar.Key("always")`);
    advance(2);
    const sent = messages.slice(before).filter((m) => m.t === "key");
    expect(sent).toEqual([expect.objectContaining({ k: "approve", src: "bind" })]); // mode / always have no binding
  });

  it("only uses widget methods that exist in WoW: Forever", () => {
    const called = vm.run(`local t = {} for k in pairs(MOCK.methodsCalled) do t[#t+1] = k end return table.concat(t, ",")`).split(",");
    const unknown = called.filter((m) => !m.startsWith("__") && !widget.has(m));
    expect(unknown).toEqual([]);
  });

  it("only uses globals that exist in WoW: Forever (or its own)", () => {
    const missing = vm.run(`local t = {} for k in pairs(MOCK.missingGlobals) do t[#t+1] = k end return table.concat(t, ",")`).split(",").filter(Boolean);
    // Saved variables / optional data the addon checks for on purpose.
    const expected = new Set(["FamiliarDB", "FamiliarCharDB", "FamiliarSyncData", "C_EncodingUtil"]);
    expect(missing.filter((g) => !expected.has(g) && !globalsApi.has(g))).toEqual([]);
    const mocked = vm.run(`local t = {} for k in pairs(MOCK.defined) do t[#t+1] = k end return table.concat(t, ",")`).split(",");
    const luaStd = new Set(["_G", "_VERSION", "assert", "collectgarbage", "coroutine", "debug", "dofile", "error", "getmetatable", "io", "ipairs", "load", "loadfile", "math", "next", "os", "package", "pairs", "pcall", "print", "rawequal", "rawget", "rawlen", "rawset", "require", "select", "setmetatable", "string", "table", "tonumber", "tostring", "type", "utf8", "xpcall", "unpack", "bit", "NS", "MOCK", "loadAddonFile", "date", "fengari"]);
    // Core engine globals that the generated docs don't list as plain names.
    const core = new Set(["CreateFrame", "UIParent", "WorldFrame", "Minimap", "SlashCmdList", "DEFAULT_CHAT_FRAME", "UISpecialFrames"]);
    const isNamespace = (g: string) => api.functions.some((f: string) => f.startsWith(g + "."));
    const notInForever = mocked.filter(
      (g) => !luaStd.has(g) && !globalsApi.has(g) && !core.has(g) && !isNamespace(g) && !g.startsWith("Familiar") && !g.startsWith("SLASH_") && !g.startsWith("BINDING_"),
    );
    expect(notInForever).toEqual([]);
  });
});

// Recreate the Lua VM with only the SavedVariables carried across, just as WoW reloads the UI.
// Each boot uses its own mocked character SavedVariables; account-wide settings remain separate.
function draftBoot(saved = "", beforeLogin = "") {
  const state = new LuaVM();
  state.run(fs.readFileSync(path.join(__dirname, "wowmock.lua"), "utf8"));
  state.run(saved);
  state.loadAddon(...tocFiles);
  state.run(beforeLogin);
  state.run(`
    draftSent = {}
    local send = NS.Send
    NS.Send = function(msg, reliable, key)
      draftSent[#draftSent + 1] = msg.t
      return send(msg, reliable, key)
    end
    MOCK.event("ADDON_LOADED", "Familiar")
    MOCK.event("PLAYER_LOGIN")`);
  return state;
}

function savedDraftState(state: LuaVM) {
  return state.run(`
    local function literal(value)
      if type(value) == "string" then return string.format("%q", value) end
      if type(value) ~= "table" then return tostring(value) end
      local parts = {}
      for key, item in pairs(value) do parts[#parts + 1] = "[" .. literal(key) .. "]=" .. literal(item) end
      return "{" .. table.concat(parts, ",") .. "}"
    end
    return "FamiliarDB = " .. literal(FamiliarDB) .. "\\nFamiliarCharDB = " .. literal(FamiliarCharDB)`);
}

describe("character-local unfinished composer recovery", () => {
  it("persists ordinary reload/logout without sending or claiming a conversation", () => {
    const state = draftBoot(`FamiliarDB = { enterSends = false, history = { "earlier" } }`);
    state.run(`FamiliarComposer:SetText("Unsent || code\\nsecond line") MOCK.event("PLAYER_LOGOUT")`);
    const restored = draftBoot(savedDraftState(state) + `\nFamiliarSyncData = { selected = { id = "different-thread", title = "Other conversation" } }`);
    expect(restored.run(`return FamiliarComposer:GetText()`)).toBe("Unsent || code\nsecond line");
    expect(restored.run(`return tostring(NS.UI.draftNotice:IsShown())`)).toBe("true");
    expect(restored.run(`return tostring(NS.UI.draftDiscard:IsShown())`)).toBe("true");
    expect(restored.run(`return NS.UI.draftNotice:GetText()`)).toContain("check the message target");
    expect(restored.run(`return tostring(FamiliarComposer:HasFocus())`)).toBe("false");
    expect(restored.run(`return tostring(#NS.db.outbox)`)).toBe("0");
    expect(restored.run(`return table.concat(draftSent, ",")`)).not.toMatch(/prompt|quick|ask/);
    expect(restored.run(`return FamiliarSyncData.selected.id`)).toBe("different-thread");
    expect(restored.run(`return tostring(NS.db.enterSends) .. "/" .. NS.db.history[1]`)).toBe("false/earlier");
  });

  it("does not overwrite a saved draft when composer initialization fails before restore", () => {
    const state = draftBoot(`FamiliarCharDB = { composerDraft = "saved before UI failure" }`,
      `NS.UI.RestoreDraft = function() error("synthetic composer restore failure") end`);
    expect(state.run(`return table.concat(MOCK.chat, "|")`)).toContain("synthetic composer restore failure");
    state.run(`MOCK.event("PLAYER_LOGOUT")`);
    expect(state.run(`return NS.charDB.composerDraft`)).toBe("saved before UI failure");
    expect(draftBoot(savedDraftState(state)).run(`return FamiliarComposer:GetText()`)).toBe("saved before UI failure");
  });

  it("keeps the underlying draft across reload while browsing history, including slash sends", () => {
    const state = draftBoot(`FamiliarDB = { history = { "old message", "latest message" } }`);
    state.run(`FamiliarComposer:SetText("draft before history") MOCK.ctrl = true MOCK.fire(FamiliarComposer, "OnKeyDown", "UP") MOCK.event("PLAYER_LOGOUT")`);
    expect(state.run(`return FamiliarComposer:GetText()`)).toBe("latest message");
    expect(draftBoot(savedDraftState(state)).run(`return FamiliarComposer:GetText()`)).toBe("draft before history");
    state.run(`SlashCmdList.FAMILIAR("a separate prompt") MOCK.event("PLAYER_LOGOUT")`);
    expect(draftBoot(savedDraftState(state)).run(`return FamiliarComposer:GetText()`)).toBe("draft before history");
    expect(state.run(`return NS.db.history[#NS.db.history]`)).toBe("a separate prompt");
  });

  it("preserves newer typing and treats editing recalled history as a new draft", () => {
    const state = draftBoot(`FamiliarCharDB = { composerDraft = "recovered" } FamiliarDB = { history = { "history" } }`);
    state.run(`FamiliarComposer:SetText("newer typing") MOCK.fire(FamiliarComposer, "OnTextChanged", true) NS.UI.RestoreDraft()`);
    expect(state.run(`return FamiliarComposer:GetText()`)).toBe("newer typing");
    expect(state.run(`return tostring(NS.UI.draftNotice:IsShown())`)).toBe("true");
    expect(state.run(`return tostring(NS.UI.draftDiscard:IsShown())`)).toBe("true");
    expect(draftBoot(savedDraftState(state)).run(`return FamiliarComposer:GetText()`)).toBe("newer typing");
    state.run(`MOCK.ctrl = true MOCK.fire(FamiliarComposer, "OnKeyDown", "UP") FamiliarComposer:SetText("edited history") MOCK.fire(FamiliarComposer, "OnTextChanged", true) MOCK.event("PLAYER_LOGOUT")`);
    expect(draftBoot(savedDraftState(state)).run(`return FamiliarComposer:GetText()`)).toBe("edited history");
  });

  it("keeps Shift+Enter edits to recalled history rather than restoring the underlying draft", () => {
    const state = draftBoot(`FamiliarCharDB = { composerDraft = "underlying draft" } FamiliarDB = { history = { "recalled message" } }`);
    state.run(`
      MOCK.ctrl = true MOCK.fire(FamiliarComposer, "OnKeyDown", "UP") MOCK.ctrl = false
      MOCK.shift = true MOCK.fire(FamiliarComposer, "OnEnterPressed") MOCK.shift = false
      -- WoW Insert invokes this callback with user=false; the tiny mock only updates text.
      MOCK.fire(FamiliarComposer, "OnTextChanged", false)
      MOCK.event("PLAYER_LOGOUT")`);
    expect(state.run(`return tostring(NS.UI.histIdx)`)).toBe("nil");
    expect(state.run(`return tostring(NS.UI.draftNotice:IsShown())`)).toBe("true");
    expect(draftBoot(savedDraftState(state)).run(`return FamiliarComposer:GetText()`)).toBe("recalled message\n");
    expect(state.run(`return tostring(#NS.db.outbox)`)).toBe("0");
  });

  it("Enter on a recalled message sends it and gives back the unfinished or recovered draft", () => {
    for (const { saved, draft } of [
      { saved: `FamiliarDB = { history = { "old message" } }`, draft: "my long unfinished draft" },
      { saved: `FamiliarDB = { history = { "old message" } } FamiliarCharDB = { composerDraft = "recovered draft text" }`, draft: "recovered draft text" },
    ]) {
      const state = draftBoot(saved);
      if (state.run(`return FamiliarComposer:GetText()`) === "") state.run(`FamiliarComposer:SetText("${draft}")`);
      state.run(`MOCK.ctrl = true MOCK.fire(FamiliarComposer, "OnKeyDown", "UP") MOCK.ctrl = false`);
      expect(state.run(`return FamiliarComposer:GetText()`)).toBe("old message");
      state.run(`MOCK.fire(FamiliarComposer, "OnEnterPressed") MOCK.event("PLAYER_LOGOUT")`);
      expect(state.run(`return #NS.db.outbox .. " " .. NS.db.outbox[1].text`)).toBe("1 old message");
      expect(state.run(`return FamiliarComposer:GetText()`)).toBe(draft);
      expect(state.run(`return tostring(NS.charDB.composerDraft)`)).toBe(draft);
      expect(draftBoot(savedDraftState(state)).run(`return FamiliarComposer:GetText()`)).toBe(draft);
    }
  });

  it("keeps failed sends and clears only the successfully queued composer, never a newer draft via ack", () => {
    const state = draftBoot(`FamiliarCharDB = { composerDraft = "recover me" }`);
    state.run(`local send = NS.SendTracked NS.SendTracked = function() return false end NS.UI.Submit() NS.SendTracked = send`);
    expect(state.run(`return NS.charDB.composerDraft`)).toBe("recover me");
    expect(state.run(`return tostring(NS.UI.draftNotice:IsShown())`)).toBe("true");
    state.run(`NS.UI.Submit()`);
    expect(state.run(`return tostring(NS.charDB.composerDraft) .. "/" .. #NS.db.outbox`)).toBe("nil/1");
    expect(state.run(`return FamiliarComposer:GetText()`)).toBe("");
    state.run(`FamiliarComposer:SetText("a newer unfinished draft") FamiliarSyncData = { acked = { NS.db.outbox[1].id }, generatedAt = GetServerTime() } NS.ReconcileOutbox()`);
    expect(state.run(`return NS.charDB.composerDraft .. "/" .. #NS.db.outbox`)).toBe("a newer unfinished draft/0");
    expect(draftBoot(savedDraftState(state)).run(`return FamiliarComposer:GetText()`)).toBe("a newer unfinished draft");
  });

  it("discards the composer explicitly without touching submitted history or outbox", () => {
    const state = draftBoot(`FamiliarCharDB = { composerDraft = "discard me" }`);
    state.run(`SlashCmdList.FAMILIAR("a submitted prompt") MOCK.ctrl = true MOCK.fire(FamiliarComposer, "OnKeyDown", "UP") MOCK.fire(NS.UI.draftDiscard, "OnClick")`);
    expect(state.run(`return FamiliarComposer:GetText()`)).toBe("");
    expect(state.run(`return tostring(NS.UI.histIdx) .. "/" .. tostring(NS.charDB.composerDraft)`)).toBe("nil/nil");
    expect(state.run(`return tostring(#NS.db.outbox) .. "/" .. NS.db.history[#NS.db.history]`)).toBe("1/a submitted prompt");
    expect(state.run(`return tostring(NS.UI.draftNotice:IsShown())`)).toBe("false");
    expect(draftBoot(savedDraftState(state)).run(`return FamiliarComposer:GetText()`)).toBe("");
    expect(state.run(`return tostring(NS.UI.draftDiscard:IsShown())`)).toBe("false");
    state.run(`FamiliarComposer:SetText("shortcut discard") SlashCmdList.FAMILIAR("draft discard")`);
    expect(state.run(`return tostring(NS.charDB.composerDraft)`)).toBe("nil");
  });

  it("bounds storage without truncating text and handles missing or malformed older state", () => {
    const state = draftBoot();
    state.run(`FamiliarComposer:SetText("last bounded version") FamiliarComposer:SetText(string.rep("x", 65537)) MOCK.event("PLAYER_LOGOUT")`);
    expect(state.run(`return tostring(#FamiliarComposer:GetText())`)).toBe("65537");
    expect(state.run(`return NS.charDB.composerDraft`)).toBe("last bounded version");
    expect(state.run(`return NS.UI.draftNotice:GetText()`)).toContain("latest edits aren't saved");
    const restored = draftBoot(savedDraftState(state));
    expect(restored.run(`return FamiliarComposer:GetText()`)).toBe("last bounded version");
    expect(restored.run(`return table.concat(MOCK.chat, "|")`)).toContain("last saved version");
    for (const saved of ["", "FamiliarCharDB = false", "FamiliarCharDB = { composerDraft = {} }", 'FamiliarCharDB = { composerDraft = string.rep("x", 65537) }'])
      expect(draftBoot(saved).run(`return FamiliarComposer:GetText()`)).toBe("");
  });

  it("saves the complete 64 KB boundary and keeps an oversized rejected prompt recoverable", () => {
    const state = draftBoot();
    state.run(`FamiliarComposer:SetText(string.rep("x", 65536)) MOCK.event("PLAYER_LOGOUT")`);
    expect(state.run(`return tostring(#NS.charDB.composerDraft)`)).toBe("65536");
    expect(state.run(`return tostring(NS.charDB.draftOverflow)`)).toBe("nil");
    state.run(`NS.UI.Submit()`); // The actual transport rejects this oversized message.
    expect(state.run(`return tostring(#FamiliarComposer:GetText()) .. "/" .. #NS.charDB.composerDraft .. "/" .. #NS.db.outbox`)).toBe("65536/65536/0");
    const restored = draftBoot(savedDraftState(state));
    expect(restored.run(`return tostring(#FamiliarComposer:GetText())`)).toBe("65536");
    restored.run(`FamiliarComposer:SetText("") MOCK.fire(FamiliarComposer, "OnTextChanged", true)`);
    expect(restored.run(`return tostring(NS.charDB.composerDraft)`)).toBe("nil");
    expect(restored.run(`return tostring(NS.UI.draftNotice:IsShown())`)).toBe("false");
    expect(restored.run(`return tostring(NS.UI.draftDiscard:IsShown())`)).toBe("false");
  });

  it("uses per-character SavedVariables rather than leaking a draft through account settings", () => {
    expect(fs.readFileSync(path.join(ADDON_DIR, "Familiar.toc"), "utf8")).toContain("## SavedVariablesPerCharacter: FamiliarCharDB");
    const first = draftBoot(`FamiliarDB = { enterSends = false } FamiliarCharDB = { composerDraft = "character one" }`);
    const second = draftBoot(`FamiliarDB = { enterSends = false }`);
    expect(first.run(`return FamiliarComposer:GetText()`)).toBe("character one");
    expect(first.run(`return tostring(NS.db.composerDraft)`)).toBe("nil");
    expect(second.run(`return FamiliarComposer:GetText()`)).toBe("");
    expect(second.run(`return tostring(NS.db.enterSends)`)).toBe("false");
  });
});

describe("outbox (prompts the companion may not have received)", () => {
  const chatTail = () => vm.run(`return MOCK.chat[#MOCK.chat]`) as string;

  it("prompts carry ids and wait; login drops confirmed ones and reports the rest; resend reuses ids", () => {
    vm.run(`NS.db.outbox = {}`);
    vm.run(`SlashCmdList.FAMILIAR("first question")`);
    vm.run(`SlashCmdList.FAMILIAR("second question")`);
    advance(2);
    const sent = messages.filter((m) => m.t === "prompt" && /question$/.test(m.text));
    expect(sent.map((m) => m.text)).toEqual(["first question", "second question"]);
    expect(sent[0].id).toMatch(/^[0-9a-f]+$/);
    expect(sent[1].id).not.toBe(sent[0].id);
    expect(vm.run(`return tostring(#NS.db.outbox)`)).toBe("2");
    // A snapshot written a minute later confirms only the first one.
    vm.run(`FamiliarSyncData = { generatedAt = GetServerTime() + 60, acked = { "${sent[0].id}" }, list = {} }`);
    vm.run(`NS.ReconcileOutbox()`);
    expect(vm.run(`return NS.db.outbox[1].id .. "/" .. #NS.db.outbox`)).toBe(`${sent[1].id}/1`);
    expect(chatTail()).toContain("1 message did not reach Familiar");
    vm.run(`SlashCmdList.FAMILIAR("resend")`);
    advance(2);
    expect(last("prompt")).toMatchObject({ id: sent[1].id, text: "second question" });
    vm.run(`SlashCmdList.FAMILIAR("discard")`);
    expect(vm.run(`return tostring(#NS.db.outbox)`)).toBe("0");
    // Ctrl+Up history includes /fam <text> sends.
    expect(vm.run(`return NS.db.history[#NS.db.history]`)).toBe("second question");
  });

  it("not-yet-snapshotted prompts stay quiet; a closed companion is reported", () => {
    vm.run(`NS.db.outbox = {}`);
    vm.run(`SlashCmdList.FAMILIAR("third question")`);
    advance(1);
    const before = vm.run(`return tostring(#MOCK.chat)`);
    vm.run(`FamiliarSyncData = { generatedAt = GetServerTime() - 30, acked = {}, list = {} }`);
    vm.run(`NS.ReconcileOutbox()`);
    expect(vm.run(`return tostring(#MOCK.chat)`)).toBe(before); // snapshot predates it and the companion is alive
    expect(vm.run(`return tostring(#NS.db.outbox)`)).toBe("1");
    vm.run(`FamiliarSyncData = { generatedAt = GetServerTime() - 30, stoppedAt = GetServerTime() - 30, acked = {}, list = {} }`);
    vm.run(`NS.ReconcileOutbox()`);
    expect(vm.run(`return table.concat(MOCK.chat, " | ", ${Number(before) + 1})`)).toMatch(/did not reach[\s\S]*was closed at/);
  });

  it("says how many older messages it dropped: more than 20 waiting, or a day old", () => {
    const chat = (state: LuaVM) => state.run(`return table.concat(MOCK.chat, " || ")`) as string;
    const relog = (state: LuaVM, sync: string) => draftBoot(`${savedDraftState(state)}\n${sync}`);
    // Familiar is closed on the PC: 25 messages wait, and the outbox keeps the newest 20.
    let state = draftBoot();
    state.run(`for i = 1, 25 do SlashCmdList.FAMILIAR("question " .. i) end`);
    expect(state.run(`return #NS.db.outbox .. " " .. NS.db.outbox[1].text`)).toBe("20 question 6");
    let next = relog(state, `FamiliarSyncData = { generatedAt = GetServerTime() + 60, acked = {}, list = {} }`);
    expect(chat(next)).toContain("20 messages did not reach Familiar");
    expect(chat(next)).toContain("5 older messages were dropped");
    expect(chat(relog(next, `FamiliarSyncData = { generatedAt = GetServerTime() + 60, acked = {}, list = {} }`))).not.toContain("dropped");

    // Familiar was running and confirmed what the outbox still holds: nothing to report.
    state = draftBoot();
    state.run(`for i = 1, 25 do SlashCmdList.FAMILIAR("question " .. i) end`);
    const ids = state.run(`local t = {} for i, m in ipairs(NS.db.outbox) do t[i] = string.format("%q", m.id) end return table.concat(t, ",")`);
    next = relog(state, `FamiliarSyncData = { generatedAt = GetServerTime() + 60, acked = { ${ids} }, list = {} }`);
    expect(next.run(`return tostring(#NS.db.outbox)`)).toBe("0");
    expect(chat(next)).not.toMatch(/dropped|did not reach/);

    // A message older than a day that never arrived.
    next = draftBoot(`FamiliarDB = { outbox = { { id = "old1", t = "prompt", text = "sent while the PC was off", at = GetServerTime() - 90000 } } }
      FamiliarSyncData = { generatedAt = GetServerTime(), acked = {}, list = {} }`);
    expect(next.run(`return tostring(#NS.db.outbox)`)).toBe("0");
    expect(chat(next)).toContain("1 older message was dropped");
  });

  it("/fam autostart on|off goes to the companion", () => {
    vm.run(`SlashCmdList.FAMILIAR("autostart off")`);
    advance(1);
    expect(last("key")).toMatchObject({ k: "autostart", a: "off" });
    vm.run(`SlashCmdList.FAMILIAR("quiet on") SlashCmdList.FAMILIAR("caughtup")`);
    advance(2);
    expect(messages.filter(m => m.t === "key").slice(-2)).toMatchObject([{ k: "quiet", a: "on" }, { k: "caughtup" }]);
  });

  it("/fam font | sound | warnings go to the companion; other words are prompts", () => {
    vm.run(`SlashCmdList.FAMILIAR("sound off")`);
    advance(1);
    expect(last("key")).toMatchObject({ k: "sound", a: "off" });
    vm.run(`SlashCmdList.FAMILIAR("warnings")`);
    advance(1);
    expect(last("key")).toMatchObject({ k: "warnings", a: "" });
    vm.run(`SlashCmdList.FAMILIAR("font Bigger")`);
    advance(1);
    expect(last("key")).toMatchObject({ k: "font", a: "bigger" });
    vm.run(`SlashCmdList.FAMILIAR("font 120")`);
    advance(1);
    expect(last("key")).toMatchObject({ k: "font", a: "120" });
    vm.run(`SlashCmdList.FAMILIAR("font is too small in the log")`);
    advance(1);
    expect(last("key")).toMatchObject({ k: "font", a: "120" }); // not a setting
  });
});

describe("chat from the game", () => {
  it("+ Chat and /fam ask; prompts carry the character's context unless switched off", () => {
    vm.run(`NS.UI.keys.newChat:GetScript("OnClick")()`);
    vm.run(`SlashCmdList.FAMILIAR("ask where is the poison quest?")`);
    vm.run(`SlashCmdList.FAMILIAR("ask new best rogue talents at 20")`);
    advance(3);
    expect(messages.filter((m) => m.t === "key").map((m) => m.k)).toContain("newChat");
    const asks = messages.filter((m) => m.t === "ask");
    const ctx = "level 20 Night Elf Rogue (Alliance) in Darkshore - Auberdine";
    expect(asks.at(-2)).toMatchObject({ text: "where is the poison quest?", ctx });
    expect(asks.at(-2).new).toBeUndefined();
    expect(asks.at(-1)).toMatchObject({ text: "best rogue talents at 20", new: true, ctx });
    vm.run(`SlashCmdList.FAMILIAR("ask context off")`);
    vm.run(`SlashCmdList.FAMILIAR("anything new?")`);
    advance(2);
    expect(last("prompt").text).toBe("anything new?");
    expect(last("prompt").ctx).toBeUndefined();
    expect(last("quests").text).toBeUndefined(); // disabled is not an empty quest log
    vm.run(`MOCK.quests = {}; SlashCmdList.FAMILIAR("ask context on")`);
    advance(2);
    expect(last("quests").text).toBe(""); // explicitly enabled, genuinely empty
  });
});

describe("providers beyond Claude and Codex", () => {
  it("/fam <provider> and /fam show <provider> follow the companion's installed providers", () => {
    vm.run(`FamiliarSyncData = { generatedAt = GetServerTime(), acked = {}, list = {}, providers = { "claude", "codex", "hermes" } }`);
    vm.run(`SlashCmdList.FAMILIAR("hermes tidy the notes folder")`);
    vm.run(`SlashCmdList.FAMILIAR("show hermes, codex")`);
    vm.run(`SlashCmdList.FAMILIAR("grok is not installed here")`);
    advance(3);
    expect(last("quick")).toMatchObject({ agent: "hermes", text: "tidy the notes folder" });
    expect(last("key")).toMatchObject({ k: "show", a: "hermes, codex" });
    expect(last("prompt").text).toBe("grok is not installed here");
  });
});

describe("quest log for chats", () => {
  it("sends your quests and objective progress when the log changes (read-only)", () => {
    vm.run(`MOCK.quests = {
      { header = "Westfall" },
      { id = 2359, title = "Klaven's Tower", level = 20, complete = false,
        objectives = { { text = "Defias Tower Key: 0/1", finished = false }, { text = "Talk to Agent Kearnen", finished = true } } },
      { id = 2360, title = "Mathias and the Defias", level = 20, complete = true, objectives = {} },
    }`);
    vm.run(`MOCK.event("QUEST_LOG_UPDATE")`);
    vm.run(`MOCK.event("QUEST_LOG_UPDATE")`); // debounced: one send
    advance(6);
    const sent = messages.filter((m) => m.t === "quests");
    expect(sent.at(-1).text).toBe(
      "Klaven's Tower [lvl 20, id 2359]: [ ] Defias Tower Key: 0/1; [x] Talk to Agent Kearnen\n" +
        "Mathias and the Defias [lvl 20, id 2360] (ready to turn in): no objectives listed",
    );
    const n = sent.length;
    vm.run(`MOCK.event("QUEST_LOG_UPDATE")`);
    advance(6);
    expect(messages.filter((m) => m.t === "quests").length).toBe(n); // unchanged: not re-sent
  });
});

describe("responsiveness: priority, drag, resize grip", () => {
  it("urgent messages (wheel, keys, layout) jump ahead of a queued quest log", () => {
    advance(30); // drain
    vm.run(`MOCK.quests = {}
      for i = 1, 20 do MOCK.quests[i] = { id = 9000 + i, title = "Quest number " .. i .. " with a long name", level = 20, complete = false,
        objectives = { { text = "Kill 10 things in a faraway place", finished = false }, { text = "Collect 8 items", finished = false } } } end`);
    vm.run(`NS.Quests.Send(true)`); // ~2 KB: many frames
    vm.run(`NS.UI.Wheel("detail", -1)`);
    advance(0.05); // wheel flush (0.03 s)
    const order: string[] = [];
    const before = messages.length;
    advance(6);
    for (const m of messages.slice(before)) order.push(m.t);
    expect(order.indexOf("wheel")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("wheel")).toBeLessThan(order.indexOf("quests"));
  });

  it("dragging sends one dragstart (rect + cursor), then dragstop and the exact layout on release", () => {
    advance(30);
    vm.run(`NS.UI.Show()`);
    advance(1);
    const before = messages.length;
    vm.run(`MOCK.cursor = { 400, 300 }`);
    vm.run(`MOCK.fire(FamiliarFrame, "OnDragStart")`);
    for (let i = 1; i <= 3; i++) {
      vm.run(`FamiliarFrame.__x = FamiliarFrame.__x + 40`);
      advance(0.3);
    }
    vm.run(`MOCK.fire(FamiliarFrame, "OnDragStop")`);
    advance(1);
    const after = messages.slice(before);
    const start = after.find((m) => m.t === "dragstart");
    expect(start).toMatchObject({ kind: "move", target: "win" });
    expect(start.rect).toHaveLength(4);
    expect(typeof start.cx).toBe("number");
    expect(after.filter((m) => m.t === "move")).toHaveLength(0); // the companion follows the cursor itself
    const stop = after.findIndex((m) => m.t === "dragstop");
    expect(stop).toBeGreaterThan(after.indexOf(start));
    expect(after.slice(stop + 1).some((m) => m.t === "layout")).toBe(true);
  });

  it("collapsing the quest log leaves just the quest, keeps it in place, and remembers it", () => {
    vm.run(`NS.UI.Show()`);
    advance(1);
    const w0 = Number(vm.run(`return tostring(FamiliarFrame:GetWidth())`));
    vm.run(`SlashCmdList.FAMILIAR("log")`);
    advance(1);
    expect(vm.run(`return tostring(NS.UI.listPane:IsShown())`)).toBe("false");
    expect(vm.run(`return tostring(FamiliarDB.logCollapsed)`)).toBe("true");
    expect(Number(vm.run(`return tostring(FamiliarFrame:GetWidth())`))).toBeLessThan(w0);
    expect(last("layout").list).toBeUndefined(); // the overlay hides the quest log too
    vm.run(`NS.UI.ToggleLog()`);
    advance(1);
    expect(vm.run(`return tostring(NS.UI.listPane:IsShown())`)).toBe("true");
    expect(Number(vm.run(`return tostring(FamiliarFrame:GetWidth())`))).toBe(w0);
  });

  it("focus mode crops native chrome, preserves the composer, and restores full view without saving focus geometry", () => {
    vm.run(`
      NS.UI.SetLogCollapsed(false)
      FamiliarFrame:SetSize(720, 440)
      FamiliarFrame.__x, FamiliarFrame.__y = 100, 100
      FamiliarFrame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 100, -228)
      NS.Tracker.frame:Show()
      FamiliarComposer:SetText("unfinished\\nreply")
      FamiliarComposer:SetFocus()
      FamiliarComposer:SetCursorPosition(5)
      FamiliarComposer:HighlightText(2, 5)
      FOCUS_COMPOSER = FamiliarComposer
      FOCUS_SAVED = NS.Json.encode(NS.db.window)
      SlashCmdList.FAMILIAR("view focus")`);
    expect(vm.run(`return tostring(FamiliarFrame:GetWidth()) .. ":" .. tostring(FamiliarFrame:GetHeight())`)).toBe("484:400");
    expect(vm.run(`return tostring(NS.UI.focusMode) .. ":" .. tostring(NS.UI.focusBtn:IsShown()) .. ":" .. NS.UI.focusBtn:GetText()`)).toBe("true:true:Full view");
    expect(vm.run(`local p, _, _, x, y = FamiliarFrame:GetPoint() return p .. ":" .. x .. ":" .. y`)).toBe("TOPLEFT:336:-268");
    expect(vm.run(`local w, h = FamiliarFrame:GetResizeBounds() return w .. ":" .. h`)).toBe("324:300");
    expect(vm.run(`for _, f in ipairs(MOCK.frames) do if type(f.locked) == "string" and f.locked:find("queued messages are not provider receipts", 1, true) then return "fallback available" end end`)).toBe("fallback available");
    expect(vm.run(`return tostring(NS.UI.listPane:IsShown()) .. ":" .. tostring(NS.UI.status:IsShown()) .. ":" .. tostring(NS.Tracker.IsShown())`)).toBe("false:false:false");
    expect(vm.run(`return tostring(FOCUS_COMPOSER == FamiliarComposer) .. ":" .. tostring(FamiliarComposer:HasFocus()) .. ":" .. tostring(FamiliarComposer:GetCursorPosition())`)).toBe("true:true:5");
    expect(vm.run(`return tostring(FamiliarComposer.__selection[1]) .. ":" .. tostring(FamiliarComposer.__selection[2])`)).toBe("2:5");
    expect(vm.run(`return FamiliarComposer:GetText()`)).toBe("unfinished\nreply");
    advance(2);
    expect(last("layout")).toMatchObject({ focus: true, panel: true });
    for (const field of ["list", "status", "tracker"]) expect(last("layout")[field]).toBeUndefined();
    expect(last("layout").keys.approve).toBeUndefined();
    vm.run(`NS.UI.Hide() NS.UI.Show() FamiliarFrame:SetSize(600, 500) MOCK.fire(NS.UI.grip, "OnMouseUp")`);
    expect(vm.run(`return tostring(NS.UI.focusMode) .. ":" .. tostring(NS.Json.encode(NS.db.window) == FOCUS_SAVED)`)).toBe("true:true");
    vm.run(`MOCK.fire(FamiliarFrame, "OnDragStop") MOCK.fire(NS.UI.focusBtn, "OnClick")`);
    expect(vm.run(`local p, _, _, x, y = FamiliarFrame:GetPoint() return p .. ":" .. x .. ":" .. y`)).toBe("TOPLEFT:100:-228");
    expect(vm.run(`return tostring(FamiliarFrame:GetWidth()) .. ":" .. tostring(FamiliarFrame:GetHeight())`)).toBe("720:440");
    expect(vm.run(`return tostring(NS.UI.focusMode) .. ":" .. tostring(NS.UI.listPane:IsShown()) .. ":" .. tostring(NS.Tracker.IsShown())`)).toBe("false:true:true");
    for (const width of [560, 720, 1100]) {
      vm.run(`FamiliarFrame:SetSize(${width}, 440) NS.UI.SetFocusMode(true)`);
      expect(Number(vm.run(`return tostring(FamiliarFrame:GetWidth())`))).toBe(width - 236);
      vm.run(`NS.UI.SetFocusMode(true) NS.UI.SetFocusMode(false)`);
      expect(Number(vm.run(`return tostring(FamiliarFrame:GetWidth())`))).toBe(width);
    }
    vm.run(`FamiliarFrame:SetPoint("BOTTOMRIGHT", UIParent, "CENTER", 50, 75)`);
    for (let i = 0; i < 3; i++) {
      vm.run(`NS.UI.SetFocusMode(true) FamiliarFrame:SetSize(400, 360) MOCK.fire(FamiliarFrame, "OnDragStop") NS.UI.SetFocusMode(false)`);
      expect(vm.run(`local p, rel, rp, x, y = FamiliarFrame:GetPoint() return p .. ":" .. tostring(rel == UIParent) .. ":" .. rp .. ":" .. x .. ":" .. y`)).toBe("BOTTOMRIGHT:true:CENTER:50:75");
    }
    vm.run(`NS.UI.SetLogCollapsed(true) FOCUS_WIDTH = FamiliarFrame:GetWidth() NS.Tracker.frame:Hide() NS.UI.SetFocusMode(true) NS.UI.SetFocusMode(false)`);
    expect(vm.run(`return tostring(FamiliarFrame:GetWidth() == FOCUS_WIDTH) .. ":" .. tostring(NS.UI.logCollapsed) .. ":" .. tostring(NS.Tracker.IsShown())`)).toBe("true:true:false");
    vm.run(`NS.UI.SetLogCollapsed(false) FamiliarFrame:SetSize(720, 440) FamiliarComposer:SetText("") FamiliarComposer:ClearFocus()`);
  });

  it("focus keys and slash decisions carry immediate context; navigation restores full view and preserves draft", () => {
    vm.run(`NS.UI.SetFocusMode(true) FamiliarComposer:SetText("check target") NS.UI.Key("next") SlashCmdList.FAMILIAR("approve")`);
    expect(vm.run(`return NS.UI.draftNotice:GetText()`)).toContain("check the message target");
    advance(2);
    expect(messages.filter(m => m.t === "key" && m.k === "approve").at(-1)).toMatchObject({ view: "focus", src: "slash" });
    vm.run(`NS.UI.Key("back")`);
    expect(vm.run(`return tostring(NS.UI.focusMode)`)).toBe("false");
    expect(vm.run(`return FamiliarComposer:GetText()`)).toBe("check target");
    advance(2);
    expect(last("key")).toMatchObject({ k: "back", view: "full" });
    vm.run(`NS.UI.SetFocusMode(true) SlashCmdList.FAMILIAR("ask")`);
    expect(vm.run(`return tostring(NS.UI.focusMode)`)).toBe("false");
    vm.run(`NS.UI.SetFocusMode(true) MOCK.fire(FamiliarComposer, "OnEscapePressed")`);
    expect(vm.run(`return tostring(NS.UI.focusMode) .. ":" .. tostring(FamiliarComposer:HasFocus())`)).toBe("true:false");
    vm.run(`NS.UI.SetFocusMode(false) FamiliarComposer:SetText("")`);
    // A fresh addon instance reads full-size saved settings, never the session focus rectangle.
    const fresh = new LuaVM();
    fresh.run(fs.readFileSync(path.join(__dirname, "wowmock.lua"), "utf8"));
    fresh.loadAddon(...tocFiles);
    fresh.run(`MOCK.event("ADDON_LOADED", "Familiar") MOCK.event("PLAYER_LOGIN")`);
    expect(fresh.run(`return tostring(NS.UI.focusMode) .. ":" .. tostring(FamiliarFrame:GetWidth())`)).toBe("false:720");
  });

  it("the resize grip has its own corner, above everything in the window", () => {
    const lv = vm.run(`return NS.UI.grip:GetFrameLevel() - FamiliarFrame:GetFrameLevel()`);
    expect(Number(lv)).toBeGreaterThanOrEqual(20);
  });
});

describe("send feedback is the same for every way of sending", () => {
  const lastChat = () => vm.run(`return MOCK.chat[#MOCK.chat]`) as string;
  const history = () => vm.run(`return table.concat(NS.db.history, " || ")`) as string;

  it("/fam ask and /fam <provider> say when a message is too long, and only remember what was sent", () => {
    vm.run(`FamiliarSyncData = { generatedAt = GetServerTime(), acked = {}, list = {}, providers = { "claude", "codex", "hermes" } }`);
    const huge = `string.rep("x", 60000)`;
    for (const cmd of ["ask ", "hermes "]) {
      const outbox = vm.run(`return tostring(#NS.db.outbox)`);
      vm.run(`SlashCmdList.FAMILIAR("${cmd}" .. ${huge})`);
      expect(lastChat()).toContain("too long");
      expect(lastChat()).not.toMatch(/asking|summoning/);
      expect(vm.run(`return tostring(#NS.db.outbox)`)).toBe(outbox);
      expect(history()).not.toContain("xxxxxxxxxx");
    }
    vm.run(`SlashCmdList.FAMILIAR("hermes tidy the notes folder")`);
    expect(lastChat()).toContain("summoning hermes");
    expect(history().split(" || ").at(-1)).toBe("tidy the notes folder"); // Ctrl+Up recalls it like any other send
  });

  it("on/off words work in any case instead of going to the agent as a prompt", () => {
    const prompts = messages.filter((m) => m.t === "prompt").length;
    vm.run(`SlashCmdList.FAMILIAR("quiet ON")`);
    advance(1);
    expect(last("key")).toMatchObject({ k: "quiet", a: "on" });
    expect(messages.filter((m) => m.t === "prompt").length).toBe(prompts);
  });

  it("the composer warns once a message is longer than Familiar can send", () => {
    const cap = Number(vm.run(`return tostring(NS.Link.maxPayload())`));
    expect(cap).toBeGreaterThan(30_000);
    vm.run(`FamiliarComposer:SetText(string.rep("x", ${cap})) MOCK.fire(FamiliarComposer, "OnTextChanged", true)`);
    expect(vm.run(`return tostring(NS.UI.draftNotice:IsShown())`)).toBe("true");
    expect(vm.run(`return NS.UI.draftNotice:GetText()`)).toMatch(/too long to send/i);
    vm.run(`FamiliarComposer:SetText("short") MOCK.fire(FamiliarComposer, "OnTextChanged", true)`);
    expect(vm.run(`return tostring(NS.UI.draftNotice:IsShown())`)).toBe("false");
    vm.run(`FamiliarComposer:SetText("") MOCK.fire(FamiliarComposer, "OnTextChanged", true)`);
  });
});

describe("continue in the agent's own app", () => {
  it("/fam open asks the companion to hand the selected conversation to its app; with words it's a prompt", () => {
    vm.run(`SlashCmdList.FAMILIAR("open")`);
    advance(1);
    expect(last("key")).toMatchObject({ k: "open" });
    vm.run(`SlashCmdList.FAMILIAR("open the settings file")`);
    advance(1);
    expect(last("prompt").text).toBe("open the settings file");
  });
});

describe("UX round 3: keys, text size, combat, tracker", () => {
  it("Scroll keybindings send wheel messages on the detail pane; Latest is a huge step", () => {
    const xml = fs.readFileSync(path.join(ADDON_DIR, "Bindings.xml"), "utf8");
    for (const [name, call] of [["FAMILIAR_SCROLL_UP", 'Familiar.Scroll("up")'], ["FAMILIAR_SCROLL_DOWN", 'Familiar.Scroll("down")'], ["FAMILIAR_LATEST", 'Familiar.Scroll("latest")']]) {
      expect(xml).toContain(`<Binding name="${name}" category="ADDONS">${call}</Binding>`);
      expect(vm.run(`return tostring(_G.BINDING_NAME_${name})`)).not.toBe("nil");
    }
    const wheel = (call: string) => {
      const before = messages.length;
      vm.run(call);
      advance(0.5);
      return messages.slice(before).filter((m) => m.t === "wheel");
    };
    expect(wheel(`Familiar.Scroll("down")`)).toEqual([expect.objectContaining({ r: "detail", d: -4 })]);
    expect(wheel(`Familiar.Scroll("up")`)).toEqual([expect.objectContaining({ r: "detail", d: 4 })]);
    expect(wheel(`Familiar.Scroll("latest")`)).toEqual([expect.objectContaining({ r: "detail", d: -9999 })]);
    expect(wheel(`Familiar.Scroll("sideways") Familiar.Scroll()`)).toEqual([]);
  });

  it("/fam font sizes the quest list at once, still tells the companion, and follows its words", () => {
    vm.run(`NS.UI.Show()`);
    vm.run(`SlashCmdList.FAMILIAR("font reset")`);
    advance(1);
    const base = last("layout").rowH / 16; // physical pixels per row unit at 100%
    expect(base).toBeGreaterThan(0);
    const rowH = (cmd: string) => {
      const before = messages.length;
      vm.run(`SlashCmdList.FAMILIAR(${JSON.stringify(cmd)})`);
      advance(1);
      return { rowH: last("layout").rowH / base, keys: messages.slice(before).filter((m) => m.t === "key") };
    };
    let r = rowH("font 130");
    expect(r.rowH).toBeCloseTo(21, 1);
    expect(r.keys).toEqual([expect.objectContaining({ k: "font", a: "130" })]);
    expect(vm.run(`return NS.db.fontScale`)).toBe("1.3");
    expect(rowH("font bigger").rowH).toBeCloseTo(22, 1); // 1.4
    expect(rowH("font smaller").rowH).toBeCloseTo(21, 1); // back to 1.3
    expect(rowH("font 500").rowH).toBeCloseTo(26, 1); // clamped to 160%
    expect(rowH("font 10").rowH).toBeCloseTo(13, 1); // clamped to 80%
    r = rowH("font is too small in the log"); // a prompt, not a size
    expect(r.rowH).toBeCloseTo(13, 1);
    expect(r.keys.map((k: any) => k.k)).toEqual([]);
    expect(rowH("font reset").rowH).toBeCloseTo(16, 1);
  });

  it("login adopts the companion's text size from FamiliarSync; without it, the saved size stays", () => {
    const rowHAt = (saved: string) => {
      const s = draftBoot(saved);
      s.run(`NS.UI.Show()`);
      return { rowH: Number(s.run(`return NS.Layout.Build().rowH`)), rows: Number(s.run(`return NS.UI.ROW_H`)) };
    };
    const base = rowHAt(`FamiliarSyncData = { generatedAt = GetServerTime(), acked = {}, list = {} }`);
    expect(base.rows).toBe(16);
    const synced = rowHAt(`FamiliarSyncData = { generatedAt = GetServerTime(), acked = {}, list = {}, fontScale = 1.2 }`);
    expect(synced.rows).toBe(19);
    expect(synced.rowH / base.rowH).toBeCloseTo(19 / 16, 2);
    // The companion wins over a size set earlier with /fam font.
    expect(rowHAt(`FamiliarDB = { fontScale = 1.5 } FamiliarSyncData = { generatedAt = GetServerTime(), acked = {}, list = {}, fontScale = 1 }`).rows).toBe(16);
    // No snapshot (or none with a size): keep the saved size.
    expect(rowHAt(`FamiliarDB = { fontScale = 1.5 }`).rows).toBe(24);
    expect(rowHAt(`FamiliarDB = { fontScale = 1.5 } FamiliarSyncData = { generatedAt = GetServerTime(), acked = {}, list = {} }`).rows).toBe(24);
    // Out-of-range or unusable values never break the list.
    expect(rowHAt(`FamiliarSyncData = { fontScale = 9 }`).rows).toBe(26);
    expect(rowHAt(`FamiliarSyncData = { fontScale = 0.1 }`).rows).toBe(13);
    expect(rowHAt(`FamiliarSyncData = { fontScale = "big" }`).rows).toBe(16);
  });

  it("/fam stream and /fam tutorial go to the companion and are listed in /fam help", () => {
    const keysSince = (before: number) => messages.slice(before).filter((m) => m.t === "key");
    let before = messages.length;
    vm.run(`SlashCmdList.FAMILIAR("stream on") SlashCmdList.FAMILIAR("stream OFF") SlashCmdList.FAMILIAR("stream")`);
    advance(2);
    expect(keysSince(before)).toEqual([
      expect.objectContaining({ k: "stream", a: "on" }),
      expect.objectContaining({ k: "stream", a: "off" }),
      expect.objectContaining({ k: "stream", a: "" }),
    ]);
    before = messages.length;
    vm.run(`NS.UI.Hide() SlashCmdList.FAMILIAR("tutorial")`);
    advance(1);
    expect(keysSince(before)).toEqual([expect.objectContaining({ k: "tutorial", src: "slash", view: "full" })]);
    expect(vm.run(`return tostring(NS.UI.IsShown())`)).toBe("true");
    // With extra words these are prompts for the selected quest, as for every other command.
    before = messages.length;
    vm.run(`SlashCmdList.FAMILIAR("tutorial for dummies") SlashCmdList.FAMILIAR("stream is blurry")`);
    advance(2);
    expect(keysSince(before).filter((k) => k.k === "tutorial" || k.k === "stream")).toEqual([]);
    expect(messages.slice(before).filter((m) => m.t === "prompt").map((m) => m.text)).toEqual(["tutorial for dummies", "stream is blurry"]);
    vm.run(`MOCK.chat = {} SlashCmdList.FAMILIAR("help")`);
    const help = vm.run(`return table.concat(MOCK.chat, " || ")`);
    expect(help).toMatch(/\/fam stream \[on \| off\]/);
    expect(help).toMatch(/\/fam tutorial/);
    expect(help).toMatch(/jump to the latest reply/);
  });

  it("the combat flag keeps flowing: PLAYER_REGEN_DISABLED / ENABLED set layout.combat", () => {
    vm.run(`MOCK.event("PLAYER_REGEN_DISABLED")`);
    advance(1);
    expect(last("layout").combat).toBe(true);
    vm.run(`MOCK.event("PLAYER_REGEN_ENABLED")`);
    advance(1);
    expect(last("layout").combat).toBe(false);
  });

  it("the tracker has no native fill (the Glass paints it): clear background, border kept", () => {
    expect(Number(vm.run(`return NS.Tracker.frame.__bg[4]`))).toBe(0);
    expect(Number(vm.run(`return NS.Tracker.frame.__border[4]`))).toBeGreaterThan(0);
  });
});

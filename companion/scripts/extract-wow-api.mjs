// Extracts the WoW: Forever API surface (widget methods, namespaced + global functions, FrameXML
// Lua globals) from a checkout of Gethe/wow-ui-source (forever branch) into test/fixtures/wow-api.json.
// Usage: node scripts/extract-wow-api.mjs <path-to-wow-ui-source>
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const src = process.argv[2];
if (!src) throw new Error("usage: extract-wow-api.mjs <wow-ui-source>");
const docs = join(src, "Interface/AddOns/Blizzard_APIDocumentationGenerated");
const widget = new Set(), fns = new Set();
for (const f of readdirSync(docs)) {
  const text = readFileSync(join(docs, f), "utf8");
  const ns = text.match(/Namespace = "([A-Za-z_]+)"/)?.[1];
  const isWidget = /Type = "ScriptObject"/.test(text);
  for (const m of text.matchAll(/Name = "([A-Za-z_0-9]+)",\s*\n\s*Type = "Function"/g)) {
    if (isWidget) widget.add(m[1]);
    else fns.add(ns ? `${ns}.${m[1]}` : m[1]);
  }
}
// Lua-defined globals in FrameXML: `function Name(`, `Name = ` at column 0, and mixin methods.
const luaGlobals = new Set(), mixinMethods = new Set();
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".lua")) {
      const t = readFileSync(p, "utf8");
      for (const m of t.matchAll(/^function ([A-Za-z_][A-Za-z_0-9]*)\s*\(/gm)) luaGlobals.add(m[1]);
      for (const m of t.matchAll(/^([A-Za-z_][A-Za-z_0-9]*)\s*=/gm)) luaGlobals.add(m[1]);
      for (const m of t.matchAll(/^function [A-Za-z_0-9]+[:.]([A-Za-z_][A-Za-z_0-9]*)\s*\(/gm)) mixinMethods.add(m[1]);
    } else if (p.endsWith(".xml")) {
      const t = readFileSync(p, "utf8");
      for (const m of t.matchAll(/<(?:Frame|Button|EditBox|ScrollFrame|Font|FontString|Texture|CheckButton|Slider|StatusBar|GameTooltip)[^>]*\bname="([A-Za-z_][A-Za-z_0-9]*)"/g)) luaGlobals.add(m[1]);
    }
  }
};
walk(join(src, "Interface"));
const out = { widgetMethods: [...widget].sort(), functions: [...fns].sort(), luaGlobals: [...luaGlobals].sort(), mixinMethods: [...mixinMethods].sort() };
writeFileSync(new URL("../test/fixtures/wow-api.json", import.meta.url), JSON.stringify(out));
console.log(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));

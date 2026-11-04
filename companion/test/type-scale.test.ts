// Four sizes and the row: the Glass (overlay.css) and the control panel (control.html) each declare four type
// tokens, and every font size in either file is one of them, the list's --row-font, 1em, inherit, or the raid
// toast's max(…) (it scales with the screen, not the pane). Nothing else: no px, no ratios, no calc.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = { "overlay.css": join(src, "overlay", "overlay.css"), "control.html": join(src, "control", "control.html") };
type Name = keyof typeof files;
const read = (name: Name) => readFileSync(files[name], "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
const squash = (v: string) => v.replace(/\s+/g, "");

const ALLOWED = /^(?:var\(--fs-(?:sm|md|lg|xl)\)|var\(--row-font\)|1em|inherit|max\(.+\))$/;

// Every font-size, and the size inside every `font:` shorthand, in the whole file (style blocks, inline style
// attributes, @media and @keyframes alike). Custom properties such as --row-font are declarations of tokens, not uses.
function fontSizes(text: string) {
  const out: { decl: string; size: string }[] = [];
  for (const m of stripComments(text).matchAll(/(?<![\w-])(font-size|font)\s*:\s*([^;}"]+)/g)) {
    const value = m[2].trim();
    if (m[1] === "font-size") { out.push({ decl: `font-size: ${value}`, size: value }); continue; }
    if (value === "inherit") { out.push({ decl: `font: ${value}`, size: value }); continue; }
    // font: [style] [variant] [weight] <size>[/line-height] <family>: the size is the first part that is not a keyword.
    const parts = value.match(/(?:[\w-]+\([^()]*(?:\([^()]*\)[^()]*)*\)|[^\s/]+)/g) ?? [];
    const size = parts.find((p) => !/^(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00)$/.test(p)) ?? value;
    out.push({ decl: `font: ${value}`, size });
  }
  return out;
}

// TODO(r7-G): the overlay.css sizes lane G is replacing in its type sweep (round 7 §2.4), each with the number of
// times it occurs today. Delete this list when G merges; the test is otherwise as strict for overlay.css as for
// control.html. A new occurrence fails, and so does an entry that occurs fewer times than listed.
const TODO_R7_G: Record<string, number> = {
  "font-size: 0.9em": 3, // .catch-promise, .catch-meta, .tl-h .s
  "font-size: calc(var(--row-font) * 1.05)": 2, // .pane-title, .row.header
  "font-size: 1.25em": 3, // .row .st/.ti, .md h1, .welcome .hint.offer::before
  "font-size: 0.75em": 1, // .qtitle .ag
  "font-size: 1.15em": 1, // .md h2
  "font-size: 1.05em": 1, // .md h3, .md h4
  "font-size: 0.92em": 2, // .md code, .md table
  "font-size: 0.88em": 1, // .md pre.code
  "font-size: calc(var(--fs-sm) * 0.95)": 2, // .tout, .tl-a
  "font-size: .9em": 1, // .chip
  "font-size: calc(var(--mini) * .34)": 1, // the minimap badge glyph
  "font-size: 0.62em": 1, // .toast .sub
};
const allowList: Record<Name, Record<string, number>> = { "overlay.css": TODO_R7_G, "control.html": {} };

const TOKENS: Record<Name, Record<string, string>> = {
  "overlay.css": { "--fs-sm": "var(--small-font)", "--fs-md": "var(--body-font)", "--fs-lg": "calc(var(--body-font)*1.25)", "--fs-xl": "calc(var(--body-font)*1.7)" },
  "control.html": { "--fs-sm": "12px", "--fs-md": "14px", "--fs-lg": "16px", "--fs-xl": "22px" },
};

describe("type scale", () => {
  for (const name of Object.keys(files) as Name[]) {
    it(`${name} declares the four --fs-* tokens in :root`, () => {
      const root = stripComments(read(name)).match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
      expect(root, `${name} should have a :root block`).not.toBe("");
      for (const [token, value] of Object.entries(TOKENS[name])) {
        const m = root.match(new RegExp(`(?<![\\w-])${token}\\s*:\\s*([^;]+);`));
        expect(m && squash(m[1]), `${name} :root should declare ${token}: ${value}`).toBe(squash(value));
      }
      if (name === "overlay.css") expect(/(?<![\w-])--row-font\s*:/.test(root), "overlay.css :root should declare --row-font").toBe(true);
    });

    it(`${name} uses only the four sizes, the row, 1em, inherit or max(…)`, () => {
      const sizes = fontSizes(read(name));
      expect(sizes.length, `${name} should have font sizes to check`).toBeGreaterThan(0);
      const left = { ...allowList[name] };
      const bad = sizes.filter((s) => !ALLOWED.test(squash(s.size)) && !(left[s.decl]-- > 0)).map((s) => s.decl);
      expect(bad, `${name}: use var(--fs-sm|md|lg|xl), var(--row-font), 1em, inherit or max(…)`).toEqual([]);
    });

    it(`${name} has no stale entry in its allow-list`, () => {
      const used: Record<string, number> = {};
      for (const s of fontSizes(read(name))) used[s.decl] = (used[s.decl] ?? 0) + 1;
      expect(Object.entries(allowList[name]).filter(([d, n]) => (used[d] ?? 0) < n).map(([d]) => d)).toEqual([]);
    });
  }

  it("rejects what it should (the checker itself)", () => {
    const sizes = (css: string) => fontSizes(css).map((s) => ALLOWED.test(squash(s.size)));
    expect(sizes(".a { font-size: 13px } .b { font-size: .9em } .c { font: 600 15px var(--sans) } .d { font-size: calc(var(--fs-sm) * .95) }")).toEqual([false, false, false, false]);
    expect(sizes(".a { font-size: var(--fs-sm) } .b { font: italic var(--fs-md) var(--mono) } .c { font: inherit } .d { font-size: max(15px, 2.1vh) } .e { font-size: 1em }")).toEqual([true, true, true, true, true]);
    expect(fontSizes(":root { --row-font: 10px; --small-font: 11px }")).toEqual([]);
    expect(sizes('<span style="font-size:13px">x</span>')).toEqual([false]);
  });
});

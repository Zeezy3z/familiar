// One motion vocabulary: the Glass (overlay.css) and the control panel (control.html) declare the same three
// duration tokens, and every animation / transition in either file uses them. The caret's 1s blink is the one
// literal allowed (it is a caret, and the only thing that loops).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = { "overlay.css": join(src, "overlay", "overlay.css"), "control.html": join(src, "control", "control.html") };
const read = (name: keyof typeof files) => readFileSync(files[name], "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Every `animation*` / `transition*` declaration with its selector (flat rules, also those inside @media / @keyframes).
function motionDeclarations(css: string) {
  const out: { selector: string; prop: string; value: string }[] = [];
  for (const rule of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const decl of rule[2].split(";")) {
      const m = decl.match(/^\s*((?:animation|transition)[\w-]*)\s*:\s*([\s\S]+?)\s*$/);
      if (m) out.push({ selector: rule[1].trim(), prop: m[1], value: m[2] });
    }
  }
  return out;
}
const LITERAL = /(?<![\w-])\d*\.?\d+m?s(?![\w-])/;

describe("motion tokens", () => {
  for (const name of Object.keys(files) as (keyof typeof files)[]) {
    it(`${name} declares --m-fast, --m-arrive and --m-settle`, () => {
      const css = stripComments(read(name));
      for (const [token, value] of [["--m-fast", "150ms"], ["--m-arrive", "350ms"], ["--m-settle", "600ms"]])
        expect(new RegExp(`${token}:\\s*${value}\\s*;`).test(css), `${name} should declare ${token}: ${value}`).toBe(true);
    });

    it(`${name} has no literal duration in an animation or transition, except the caret's 1s blink`, () => {
      const decls = motionDeclarations(read(name));
      expect(decls.length, `${name} should have motion declarations to check`).toBeGreaterThan(0);
      const literal = decls.filter((d) => LITERAL.test(d.value));
      for (const d of literal) {
        expect(d.selector, `${d.selector} { ${d.prop}: ${d.value} } uses a literal duration; use a --m-* token`).toMatch(/\.caret\b/);
        expect(d.value.match(new RegExp(LITERAL, "g"))).toEqual(["1s"]);
      }
    });
  }

  it("keeps the reduced-motion block in overlay.css, and gives the control panel one too", () => {
    for (const name of Object.keys(files) as (keyof typeof files)[])
      expect(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(stripComments(read(name))), `${name} needs a reduced-motion block`).toBe(true);
  });

  it("the control panel's own motion is the token it declares", () => {
    const used = motionDeclarations(read("control.html")).map((d) => d.value).join(" ");
    expect(used).toContain("var(--m-fast)");
    expect(used).toContain("var(--m-arrive)");
  });
});

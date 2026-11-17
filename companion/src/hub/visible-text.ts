// "Copy reply" puts on the clipboard what the player could read on the Glass, not what the agent
// sent: HTML comments, the content of elements the Glass never shows, and HTML tags (their text
// kept) are taken out; everything else stays markdown source. Code (fenced blocks and `spans`)
// shows as typed, so it is left exactly as it is. Pure.
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: true }); // the Glass's own settings (overlay.ts)
// What the Glass's sanitiser (DOMPurify) drops with its content, or paints nothing of.
const HIDING = /<(script|style|template|noscript|noembed|noframes|iframe|title|xmp|svg|math|video|audio|head|plaintext)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?(?:<\/\1\s*>|$(?![\s\S]))/gi;
const COMMENT = /<!--[\s\S]*?(?:-->|$(?![\s\S]))/g;
// A tag: its name runs into a space, "/" or ">" (so <https://…> and <me@host> autolinks stay).
const TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>|<![A-Za-z][^>]*>|<\?[\s\S]*?(?:\?>|$(?![\s\S]))|<!\[CDATA\[[\s\S]*?(?:\]\]>|$(?![\s\S]))/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function visibleText(md: string): string {
  const src = md.replace(/\r\n?/g, "\n").replace(/\0/g, "");
  const code: string[] = [];
  marked.walkTokens(marked.lexer(src), (t) => {
    if (t.type === "code" || t.type === "codespan") code.push(t.raw);
  });
  // Set each piece of code aside (in order; one inside a list item is lexed without its indent).
  let rest = src, out = "";
  const kept: string[] = [];
  for (const raw of code) {
    let at = rest.indexOf(raw), len = raw.length;
    if (at < 0) {
      const m = new RegExp(raw.split("\n").map(escapeRe).join("\\n[ \\t]*")).exec(rest);
      if (!m) continue;
      [at, len] = [m.index, m[0].length];
    }
    out += rest.slice(0, at) + `\0${kept.length}\0`;
    kept.push(rest.slice(at, at + len));
    rest = rest.slice(at + len);
  }
  out += rest;
  return out
    .replace(COMMENT, "")
    .replace(HIDING, "")
    .replace(TAG, "")
    .replace(/\0(\d+)\0/g, (_m, i) => kept[Number(i)]);
}

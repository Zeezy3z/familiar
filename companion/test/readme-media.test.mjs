// The README's pictures: every docs/media file it points at exists, and every image says what it is
// (rendered from the real overlay or control panel with sample data, not live footage; the familiar's own
// portrait says it is original art).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = readFileSync(join(repo, "README.md"), "utf8");
const refs = [...new Set([...readme.matchAll(/docs\/media\/[\w.-]+/g)].map((m) => m[0]))];
const images = readme.match(/<img\b[^>]*>|!\[[^\]]*\]\([^)]*\)/g) ?? [];

describe("README media", () => {
  it("shows at least the hero image", () => {
    expect(refs).toContain("docs/media/approval.png");
  });
  it("points only at files that exist", () => {
    for (const ref of refs) expect(existsSync(join(repo, ref)), `${ref} is referenced by README.md but missing`).toBe(true);
  });
  it("gives every image alt text and the sample-data caption", () => {
    const captions = readme.match(/\*(?:Rendered from the real (?:overlay|control panel) with sample data|Original art for Familiar)\.\*/g) ?? [];
    expect(images.length).toBeGreaterThan(0);
    expect(captions.length).toBeGreaterThanOrEqual(images.length);
    for (const img of images) expect(img, "an image without alt text").toMatch(/alt="[^"]+"|!\[[^\]]+\]/);
  });
  it("shows the familiar's portrait with alt text and says it is original art", () => {
    expect(refs).toContain("docs/media/familiar.png");
    expect(readme).toMatch(/<img\b[^>]*src="docs\/media\/familiar\.png"[^>]*alt="[^"]+"/);
    expect(readme).toContain("*Original art for Familiar.*");
  });
  it("shows what viewers see in the Streaming section: stream-safe.png with alt text and the sample-data caption", () => {
    expect(refs).toContain("docs/media/stream-safe.png");
    const section = readme.slice(readme.indexOf("### Streaming"));
    expect(section).toMatch(/<img\b[^>]*src="docs\/media\/stream-safe\.png"[^>]*alt="[^"]+"[^>]*>\s*\n\s*\n\*Rendered from the real overlay with sample data\.\*/);
  });
  it("keeps docs/media small enough for a README (6 MB)", () => {
    const dir = join(repo, "docs", "media");
    if (!existsSync(dir)) return; // the missing-file test above is the one that fails
    const bytes = readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(bytes).toBeLessThanOrEqual(6 * 1024 * 1024);
  });
});

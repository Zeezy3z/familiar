// "Check for updates" (main/update.ts): one GET on the player's click, compared semver-style, and
// only this project's releases pages may be opened.
import { describe, expect, it } from "vitest";
import { checkUpdate, compareRelease, isReleasesUrl, RELEASES_API, RELEASES_URL } from "../src/main/update";

describe("compareRelease", () => {
  it("reads tags with or without v, and orders like semver", () => {
    expect(compareRelease("0.2.0", "v0.3.0")).toEqual({ latest: "0.3.0", newer: true, prerelease: false });
    expect(compareRelease("0.2.0", "0.2.0")).toEqual({ latest: "0.2.0", newer: false, prerelease: false });
    expect(compareRelease("0.2.1", "v0.2.0")).toMatchObject({ newer: false });
    expect(compareRelease("0.9.0", "v0.10.0")).toMatchObject({ newer: true }); // numbers, not text
    expect(compareRelease("1.0.0", "v0.99.9")).toMatchObject({ newer: false });
  });

  it("flags prereleases, which sort before their release", () => {
    expect(compareRelease("0.2.0", "v0.3.0-beta.1")).toEqual({ latest: "0.3.0-beta.1", newer: true, prerelease: true });
    expect(compareRelease("0.3.0", "v0.3.0-beta.1")).toMatchObject({ newer: false });
    expect(compareRelease("0.3.0-beta.1", "v0.3.0-beta.2")).toMatchObject({ newer: true });
    expect(compareRelease("0.3.0-beta.2", "v0.3.0-beta.10")).toMatchObject({ newer: true });
    expect(compareRelease("0.3.0-beta", "v0.3.0")).toMatchObject({ newer: true, prerelease: false });
  });

  it("is undefined for a tag that isn't a version", () => {
    for (const tag of ["latest", "", "release-2026", "v1"]) expect(compareRelease("0.2.0", tag), tag).toBeUndefined();
  });
});

/** One entry of GET /repos/{owner}/{repo}/releases, trimmed to the fields GitHub always sends. */
const release = (tag: string, { prerelease = false, draft = false, created = "2026-11-01T12:00:00Z" } = {}) => ({
  url: `https://api.github.com/repos/Zeezy3z/familiar/releases/${tag.length}`,
  html_url: `${RELEASES_URL}/tag/${tag}`,
  id: 100 + tag.length,
  tag_name: tag,
  target_commitish: "main",
  name: `Familiar ${tag.replace(/^v/, "")}${prerelease ? " beta" : ""}`,
  draft,
  prerelease,
  created_at: created,
  published_at: draft ? null : created,
  assets: [{ name: `FamiliarApp-${tag}-windows.zip`, browser_download_url: `${RELEASES_URL}/download/${tag}/FamiliarApp-${tag}-windows.zip` }],
  body: "<!-- release-body -->\n…",
});
/** Newest created first, as GitHub sends it: a 0.5.2 hotfix cut after the 0.6.0 beta. */
const RELEASES = [
  release("v0.5.2", { created: "2026-11-12T09:00:00Z" }),
  release("v0.6.0", { prerelease: true, created: "2026-11-10T12:00:00Z" }),
  release("v0.5.1", { prerelease: true, created: "2026-11-02T12:00:00Z" }),
];

describe("checkUpdate", () => {
  const answer = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  it("one GET to the releases list, no auth, a plain User-Agent; the highest version wins, prerelease or not", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const r = await checkUpdate("0.5.1", async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => RELEASES };
    });
    expect(calls).toEqual([{ url: RELEASES_API, headers: { "User-Agent": "familiar-wow", Accept: "application/vnd.github+json" } }]);
    expect(r).toEqual({ current: "0.5.1", latest: "0.6.0", newer: true, url: "https://github.com/Zeezy3z/familiar/releases/tag/v0.6.0", prerelease: true });
  });

  it("already the latest", async () => {
    expect(await checkUpdate("0.6.0", answer(200, RELEASES))).toMatchObject({ latest: "0.6.0", newer: false });
  });

  it("skips drafts and entries without a version", async () => {
    const list = [release("v0.7.0", { draft: true }), { ...release("v9.9.9"), tag_name: "nightly" }, null, ...RELEASES];
    expect(await checkUpdate("0.5.1", answer(200, list))).toMatchObject({ latest: "0.6.0", newer: true });
  });

  it("a page outside this project's releases is never offered", async () => {
    const r = await checkUpdate("0.2.0", answer(200, [{ ...release("v0.3.0"), html_url: "https://example.com/familiar-setup.exe" }]));
    expect(r).toMatchObject({ latest: "0.3.0", url: RELEASES_URL });
  });

  it("errors are an answer, not a throw", async () => {
    expect(await checkUpdate("0.2.0", async () => { throw new TypeError("fetch failed"); })).toEqual({ current: "0.2.0", error: "couldn't reach GitHub" });
    expect(await checkUpdate("0.2.0", async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); })).toEqual({ current: "0.2.0", error: "no answer from GitHub within 10 s" });
    expect(await checkUpdate("0.2.0", answer(404, {}))).toEqual({ current: "0.2.0", error: "no release is published yet" });
    expect(await checkUpdate("0.2.0", answer(200, []))).toEqual({ current: "0.2.0", error: "no release is published yet" });
    expect(await checkUpdate("0.2.0", answer(403, {}))).toEqual({ current: "0.2.0", error: "GitHub answered 403" });
    expect(await checkUpdate("0.2.0", answer(200, { tag_name: "v0.3.0" }))).toEqual({ current: "0.2.0", error: "GitHub's answer named no version" });
    expect(await checkUpdate("0.2.0", answer(200, [{ tag_name: 3 }, release("v0.9.0", { draft: true })]))).toEqual({ current: "0.2.0", error: "GitHub's answer named no version" });
  });

  it("gives up after the timeout", async () => {
    const r = await checkUpdate("0.2.0", (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))), 50);
    expect(r).toEqual({ current: "0.2.0", error: "no answer from GitHub within 1 s" });
  });
});

describe("isReleasesUrl", () => {
  it("only this project's releases pages", () => {
    for (const u of [RELEASES_URL, `${RELEASES_URL}/latest`, `${RELEASES_URL}/tag/v0.3.0`]) expect(isReleasesUrl(u), u).toBe(true);
    for (const u of ["https://github.com/Zeezy3z/familiar", "https://github.com/someone/familiar/releases", "http://github.com/Zeezy3z/familiar/releases",
      "https://github.com/Zeezy3z/familiar/releases/../../evil", "https://github.com.evil.io/Zeezy3z/familiar/releases", "https://github.com/Zeezy3z/familiar/releases?x=1"])
      expect(isReleasesUrl(u), u).toBe(false);
  });
});

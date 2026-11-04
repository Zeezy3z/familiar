// "Check for updates" (main/update.ts): one GET on the player's click, compared semver-style, and
// only this project's releases pages may be opened.
import { describe, expect, it } from "vitest";
import { checkUpdate, compareRelease, isReleasesUrl, LATEST_RELEASE_API, RELEASES_URL } from "../src/main/update";

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

describe("checkUpdate", () => {
  const answer = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  it("one GET to the latest-release API, no auth, a plain User-Agent", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const r = await checkUpdate("0.2.0", async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ tag_name: "v0.3.0", html_url: `${RELEASES_URL}/tag/v0.3.0`, prerelease: false }) };
    });
    expect(calls).toEqual([{ url: LATEST_RELEASE_API, headers: { "User-Agent": "familiar-wow", Accept: "application/vnd.github+json" } }]);
    expect(r).toEqual({ current: "0.2.0", latest: "0.3.0", newer: true, url: "https://github.com/Zeezy3z/familiar/releases/tag/v0.3.0", prerelease: false });
  });

  it("already the latest", async () => {
    expect(await checkUpdate("0.2.0", answer(200, { tag_name: "v0.2.0", html_url: `${RELEASES_URL}/tag/v0.2.0` }))).toMatchObject({ latest: "0.2.0", newer: false });
  });

  it("a page outside this project's releases is never offered", async () => {
    const r = await checkUpdate("0.2.0", answer(200, { tag_name: "v0.3.0", html_url: "https://example.com/familiar-setup.exe" }));
    expect(r.url).toBe(`${RELEASES_URL}/latest`);
  });

  it("errors are an answer, not a throw", async () => {
    expect(await checkUpdate("0.2.0", async () => { throw new TypeError("fetch failed"); })).toEqual({ current: "0.2.0", error: "couldn't reach GitHub" });
    expect(await checkUpdate("0.2.0", async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); })).toEqual({ current: "0.2.0", error: "no answer from GitHub within 10 s" });
    expect(await checkUpdate("0.2.0", answer(404, {}))).toEqual({ current: "0.2.0", error: "no release is published yet" });
    expect(await checkUpdate("0.2.0", answer(403, {}))).toEqual({ current: "0.2.0", error: "GitHub answered 403" });
    expect(await checkUpdate("0.2.0", answer(200, { tag_name: 3 }))).toEqual({ current: "0.2.0", error: "GitHub's answer named no version" });
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

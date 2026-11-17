// "Check for updates": one GET to GitHub's list of releases, only when the player clicks the button
// in the control panel. Never scheduled, never in the background, never downloads anything; the
// release page opens in the browser only on a second, explicit click (main's openUrl).
// The list, not /releases/latest: that endpoint leaves out prereleases, and every beta release is one.

/** The answer the control panel shows. */
export interface CheckUpdate {
  current: string;
  latest?: string;
  /** Newer than `current`: "<latest> is out · Open the download page". */
  newer?: boolean;
  /** The release page to open (only on the player's click; see isReleasesUrl). */
  url?: string;
  prerelease?: boolean;
  error?: string;
}

/** The project's releases page (the update path: the installer or the release zip). */
export const RELEASES_URL = "https://github.com/Zeezy3z/familiar/releases";
/** Newest first by creation date, prereleases included; drafts are never shown without auth. */
export const RELEASES_API = "https://api.github.com/repos/Zeezy3z/familiar/releases?per_page=20";

/** The only pages "Open the download page" may open: this project's releases. */
export const isReleasesUrl = (url: string) => /^https:\/\/github\.com\/Zeezy3z\/familiar\/releases(\/[\w.-]+)*\/?$/.test(url) && !url.includes("..");

const SEMVER = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
type Version = { nums: number[]; pre: string[] };
function parse(v: string): Version | undefined {
  const m = SEMVER.exec(v.trim());
  return m ? { nums: [+m[1], +m[2], +(m[3] ?? 0)], pre: m[4] ? m[4].split(".") : [] } : undefined;
}

/** Semver order: numbers first; a prerelease sorts before its release; prerelease parts compare
 * numerically when both are numbers, numbers before words, fewer parts first. */
function order(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return Math.sign(a.nums[i] - b.nums[i]);
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const [x, y] = [a.pre[i], b.pre[i]];
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) return Math.sign(+x - +y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.pre.length - b.pre.length);
}

/** A release tag ("v0.3.0", "0.3.0-beta.1") against the running version. Undefined: not a version. */
export function compareRelease(current: string, tag: string): { latest: string; newer: boolean; prerelease: boolean } | undefined {
  const latest = parse(tag);
  if (!latest) return undefined;
  const cur = parse(current);
  return { latest: tag.trim().replace(/^v/, ""), newer: !cur || order(latest, cur) > 0, prerelease: latest.pre.length > 0 };
}

type Get = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** The one request: no auth, no cookies, nothing about this PC beyond the User-Agent's name. */
export async function checkUpdate(current: string, get: Get = fetch, timeoutMs = 10_000): Promise<CheckUpdate> {
  try {
    const res = await get(RELEASES_API, { headers: { "User-Agent": "familiar-wow", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { current, error: res.status === 404 ? "no release is published yet" : `GitHub answered ${res.status}` };
    const list = await res.json();
    if (Array.isArray(list) && !list.length) return { current, error: "no release is published yet" };
    // The highest version among the published (non-draft) releases, whatever order GitHub sends.
    let best: { r: any; v: Version } | undefined;
    for (const r of Array.isArray(list) ? list : []) {
      const v = r && r.draft !== true && typeof r.tag_name === "string" ? parse(r.tag_name) : undefined;
      if (v && (!best || order(v, best.v) > 0)) best = { r, v };
    }
    const c = best && compareRelease(current, best.r.tag_name);
    if (!best || !c) return { current, error: "GitHub's answer named no version" };
    const url = typeof best.r.html_url === "string" && isReleasesUrl(best.r.html_url) ? best.r.html_url : RELEASES_URL;
    return { current, latest: c.latest, newer: c.newer, url, prerelease: c.prerelease || best.r.prerelease === true };
  } catch (e: any) {
    return { current, error: e?.name === "TimeoutError" ? `no answer from GitHub within ${Math.ceil(timeoutMs / 1000)} s` : "couldn't reach GitHub" };
  }
}

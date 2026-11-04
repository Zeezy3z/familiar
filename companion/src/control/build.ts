import type { BuildIdentity } from "../main/build";

export interface RestartActivity { working: number; approvals: number; confirmation: boolean }

export function buildPresentation(version: string, build?: Partial<BuildIdentity>) {
  const commit = typeof build?.commit === "string" && /^[a-f0-9]{40}$/.test(build.commit) ? build.commit : null;
  const source = !commit || typeof build?.dirty !== "boolean" ? "unavailable" : build.dirty ? "local changes" : "clean";
  const release = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ? ` v${version}` : "";
  const summary = !commit ? "Build identity unavailable; Git metadata was not readable when this app was built." :
    source === "clean" ? `Running build from ${commit.slice(0, 12)}.` :
    `Running build based on ${commit.slice(0, 12)}; ${source === "local changes" ? "built with local changes" : "local-change status unavailable"}.`;
  // Deliberately narrow: no source paths, project names, agent accounts or status/log dumps.
  return { summary, diagnostic: `Familiar${release} | Running commit: ${commit ?? "unavailable"} | Source: ${source}` };
}

export function restartGuidance(work?: Partial<RestartActivity> | null) {
  const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (!work || !count(work.working) || !count(work.approvals) || typeof work.confirmation !== "boolean")
    return { title: "Check your quests before restarting", text: "Activity is unavailable. Check for working quests, pending requests and unfinished conversation handoffs before choosing Quit.", level: "warn" };
  if (work.working || work.approvals || work.confirmation) {
    const items = [work.working ? `${work.working} working quest${work.working === 1 ? "" : "s"}` : "",
      work.approvals ? `${work.approvals} pending request${work.approvals === 1 ? "" : "s"}` : "",
      work.confirmation ? "an unfinished conversation handoff" : ""].filter(Boolean);
    return { title: "Wait before restarting", text: `${items.join("; ")}. Finish or explicitly stop the work and resolve requests first. Quitting interrupts active turns.`, level: "warn" };
  }
  return { title: "Restart between messages", text: "No working quests or pending requests are shown right now. Finish any message you are starting and check that the Quest Log has settled before choosing Quit.", level: "muted" };
}

// ---- versions: the addon/app mismatch line and the "Check for updates" result ---------------------------

const SEMVER = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const parseVersion = (v: unknown) => { const m = typeof v === "string" ? SEMVER.exec(v.trim()) : null; return m ? { core: [+m[1], +m[2], +(m[3] ?? 0)], pre: m[4]?.split(".") } : null; };
const shown = (v: string) => v.trim().replace(/^v/, "");

/** Semver order of two release strings (a "v" prefix is fine); undefined when either is not a version. Only used to
 * say which of the addon and the app is behind: main says whether they differ (status.update.mismatch) and whether a
 * release is newer (checkUpdate.newer). */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | undefined {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : x.pre ? -1 : 1; // a release outranks its own prerelease
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return +p < +q ? -1 : 1;
    return pn !== qn ? (pn ? -1 : 1) : p < q ? -1 : 1;
  }
  return 0;
}

/** The header's version beside the title: `v0.5.0` for the running app (status.version, the package version main
 * embeds), keeping a plain suffix such as the preview's "· synthetic preview"; nothing for anything that is not a
 * version. */
export function versionLabel(version: unknown): string {
  const m = typeof version === "string" ? /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)((?: · [\w .-]+)?)$/.exec(version.trim()) : null;
  return m ? `v${m[1]}${m[2]}` : "";
}

/** Header line when the addon and the app differ (status.update = { app, addon, mismatch, last }). Main decides
 * whether they differ; the addon's version comes from the game (any addon can draw that strip), so the line is only
 * built from two plain version strings and says nothing otherwise. */
export function versionMismatch(u: { app?: unknown; addon?: unknown; mismatch?: unknown } | null | undefined): { text: string } | null {
  if (!u || u.mismatch !== true || !parseVersion(u.app) || !parseVersion(u.addon)) return null;
  const [a, v] = [shown(String(u.addon)), shown(String(u.app))];
  const order = compareVersions(a, v);
  return { text: order === 1 ? `App ${v} is behind addon ${a}. Update the app from the Releases page.`
    : order === -1 ? `Addon ${a} is behind app ${v}. Update it with WowUp or the release zip.`
    : `Addon ${a} and app ${v} differ. Update the one that's behind.` };
}

/** The line under "Check for updates" (checkUpdate's answer, also status.update.last). `url` becomes a link only
 * when it is one of this project's release pages. */
export function updateLine(r: { current?: string; latest?: string; newer?: boolean; url?: string; prerelease?: boolean; error?: string } | null | undefined):
  { level: "ok" | "warn" | "muted"; text: string; open?: string } {
  if (!r || typeof r !== "object") return { level: "warn", text: "Couldn't reach GitHub (no network?)" };
  if (r.error) {
    const why = String(r.error).trim().slice(0, 160);
    return { level: "warn", text: /^couldn't reach github/i.test(why) ? "Couldn't reach GitHub (no network?)" : `Couldn't check for updates: ${why}.` };
  }
  if (typeof r.latest !== "string" || !r.latest.trim()) return { level: "warn", text: "GitHub didn't name a latest release." };
  const [current, latest] = [shown(String(r.current ?? "")), shown(r.latest)];
  const beta = r.prerelease ? " (beta)" : "";
  if (r.newer === true) {
    const ok = typeof r.url === "string" && /^https:\/\/github\.com\/Zeezy3z\/familiar\/releases(\/|$)/.test(r.url);
    return { level: "warn", text: `${latest} is out${beta}`, open: ok ? r.url : undefined };
  }
  return latest === current ? { level: "ok", text: `You're on ${current}, the latest${beta}.` }
    : { level: "muted", text: `You're on ${current}. The latest release is ${latest}${beta}.` };
}

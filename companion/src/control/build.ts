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

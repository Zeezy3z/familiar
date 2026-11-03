// "Suggest a change": a pre-filled GitHub issue form the user reviews and submits in their own
// browser. Only the text and versions go in; never paths, character names, transcripts or logs.

export const ISSUE_URL_PREFIX = "https://github.com/Zeezy3z/familiar/issues/new";
export const SUGGEST_MAX = 2000;
export const SUGGEST_TITLE_MAX = 80;
export const SUGGEST_TOAST = "Opened a pre-filled GitHub issue in your browser. Review it and submit there; nothing is sent until you do.";

export interface SuggestVersions {
  familiar?: string;
  /** WoW client version and interface, from the install probe. */
  wow?: string;
  iface?: number | string;
  /** os.release() */
  windows?: string;
}

/** The new-issue URL for `.github/ISSUE_TEMPLATE/suggestion.yml`: issue forms prefill fields by
 * their `id` (`suggestion`, `diagnostics`). undefined when the text is empty. */
export function suggestionUrl(text: string, v: SuggestVersions): string | undefined {
  const body = text.replace(/\r\n?/g, "\n").trim().slice(0, SUGGEST_MAX);
  if (!body) return undefined;
  const line = body.replace(/\s+/g, " ");
  const title = "[Suggest] " + line.slice(0, SUGGEST_TITLE_MAX).trimEnd();
  const diagnostics = [
    `Familiar ${v.familiar ?? "?"}`,
    `WoW client ${v.wow ?? "?"} (interface ${v.iface ?? "?"})`,
    `Windows ${v.windows ?? "?"}`,
  ].join("\n");
  const q = new URLSearchParams({ template: "suggestion.yml", title, suggestion: body, diagnostics });
  return `${ISSUE_URL_PREFIX}?${q.toString().replace(/\+/g, "%20")}`;
}

/** Only our own new-issue form may be opened (main's shell.openExternal gate). */
export const isIssueUrl = (url: string) => url.startsWith(ISSUE_URL_PREFIX + "?") || url === ISSUE_URL_PREFIX;

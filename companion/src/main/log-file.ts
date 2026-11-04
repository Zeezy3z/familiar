// familiar.log is for diagnosing Familiar, not a transcript: addon messages are described by type
// and size only, never what the player typed or which character they play, and the file is capped.
// Every line passes through redact() (main.ts log()) so paths, usernames and secrets that agents or
// providers print never reach the file, the control panel or a copied diagnostics block.
import * as fs from "node:fs";
import * as os from "node:os";

/** One log line with a full ISO timestamp (date included). */
export function logLine(s: string, now = new Date()): string {
  return `${now.toISOString()} ${s}`;
}

/** At startup: once the log passes maxBytes it becomes familiar.log.1 (replacing an older one), so
 * there is at most one current and one previous log. */
export function rotateLog(file: string, maxBytes = 2_000_000) {
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + ".1");
  } catch {
    /* no log yet */
  }
}

/** An addon message for the log: its type, key and text length, never the text itself. */
export function describeAddonMessage(m: Record<string, unknown>): string {
  if (m.t === "hello") return `[addon] hello build ${m.build} iface ${m.iface} addon ${m.addon}`;
  const size = typeof m.text === "string" ? ` (${m.text.length} chars)` : "";
  return `[addon] ${String(m.t)}${m.k ? " " + String(m.k) : ""}${size}`;
}

/** An overlay action for the log: its type, boolean flags and (for "decide") the decision, never
 * card ids, option labels or request text. Catch-up identity/outcome is traced by the Hub with
 * opaque tokens. */
export function describeOverlayAction(a: any): string {
  const out: Record<string, string | boolean> = { type: typeof a?.type === "string" ? a.type : "?" };
  if (a && typeof a === "object") for (const [k, v] of Object.entries(a)) if (typeof v === "boolean") out[k] = v;
  if (a?.type === "decide" && typeof a.decision === "string") out.decision = a.decision;
  return `[overlay] action ${JSON.stringify(out)}`;
}

// ---- redaction ----------------------------------------------------------------------------------
export const LOG_LINE_MAX = 400;
const MASK = "[redacted]";
const SECRET_PREFIXED = /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const BEARER = /\bBearer\s+\S+/gi;
// Keeps the key name (OPENAI_API_KEY=, "token":, Authorization:), masks the value.
const KEY_VALUE = /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[=:]\s*["']?)(?!Bearer\b)\S+/gi;
const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RUN = /\b[0-9a-f]{40,}\b/gi;
// Base64-ish runs (no "/" so URL and Unix paths survive); must mix letters and digits so a row of
// dashes or a long word is left alone.
const BASE64_RUN = /(?<![A-Za-z0-9+/=_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g;
// \Users\alice\ or /Users/alice/ (any user, either slash style) → \Users\<user>\.
const USERS_DIR = /([\\/])Users\1([^\\/\s"'<>|:*?]+)(?=[\\/])/gi;

const homeRegexCache = new Map<string, RegExp | null>();
function homeRegex(home: string): RegExp | null {
  let re = homeRegexCache.get(home);
  if (re === undefined) {
    const h = home.replace(/[\\/]+$/, "");
    re = h.length < 3 ? null : new RegExp(h.replace(/[.*+?^${}()|[\]]/g, "\\$&").replace(/[\\/]+/g, "[\\\\/]+"), "gi");
    homeRegexCache.set(home, re);
  }
  return re;
}

/** Pure: the home folder becomes "~", other users' folders "\Users\<user>", API keys, tokens,
 * bearer headers, key=value secrets and long hex/base64 runs are masked, UUIDs are shortened to
 * their first 8 chars, and the line is capped at LOG_LINE_MAX chars. */
export function redact(s: string, home: string = os.homedir()): string {
  let out = s.length > 4000 ? s.slice(0, 4000) : s; // bound the regex work; the cap below is final
  const h = homeRegex(home);
  if (h) out = out.replace(h, "~");
  out = out
    .replace(USERS_DIR, "$1Users$1<user>")
    .replace(UUID, "$1…")
    .replace(SECRET_PREFIXED, MASK)
    .replace(BEARER, "Bearer " + MASK)
    .replace(KEY_VALUE, "$1" + MASK)
    .replace(HEX_RUN, MASK)
    .replace(BASE64_RUN, MASK);
  return out.length > LOG_LINE_MAX ? out.slice(0, LOG_LINE_MAX - 1) + "…" : out;
}

// ---- diagnostics ("Copy diagnostics" in the control panel) --------------------------------------
/** Config keys whose value differs from the defaults (or that the defaults don't have): names
 * only, with the value shown for booleans. */
export function changedConfigKeys(cfg: Record<string, unknown>, defaults: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(cfg).sort()) {
    const v = cfg[k];
    if (JSON.stringify(v) === JSON.stringify(defaults[k])) continue;
    out.push(typeof v === "boolean" ? `${k}=${v}` : k);
  }
  return out;
}

export interface Diagnostics {
  version: string;
  build: string;
  electron: string;
  node: string;
  windows: string;
  wow: string;
  capture: string;
  /** The Link Doctor's line ("<step>: <sentence>"). */
  link?: string;
  providers: string[];
  configKeys: string[];
  /** Already-redacted log lines (the in-memory ring). */
  log: string[];
}

/** The text block for a bug report: versions and state only, redacted log tail, no paths beyond
 * what redact() lets through. */
export function diagnosticsText(d: Diagnostics): string {
  return [
    `Familiar diagnostics (redacted; review before posting)`,
    `Companion: ${d.version}`,
    `Build: ${d.build}`,
    `Electron: ${d.electron} · Node: ${d.node} · Windows: ${d.windows}`,
    `WoW: ${d.wow}`,
    `Capture: ${d.capture}`,
    ...(d.link ? [`Link doctor: ${d.link}`] : []),
    `Providers: ${d.providers.join("; ") || "none"}`,
    `Config (non-default keys): ${d.configKeys.join(", ") || "none"}`,
    ``,
    `--- log (last ${d.log.length} lines) ---`,
    ...d.log.map((l) => redact(l)),
  ].join("\n");
}

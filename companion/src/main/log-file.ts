// familiar.log is for diagnosing Familiar, not a transcript: addon messages are described by type
// and size only, never what the player typed or which character they play, and the file is capped.
import * as fs from "node:fs";

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

/** Catch-up identity/outcome is traced by the Hub with opaque tokens, rather than raw card IDs. */
export function describeOverlayAction(a: any): string {
  return `[overlay] action ${a?.type === "caughtUp" ? '{"type":"caughtUp"}' : JSON.stringify(a).slice(0, 160)}`;
}

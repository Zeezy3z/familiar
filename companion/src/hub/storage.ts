// Saved quests cross an untyped disk boundary. Recover independently, but never replace damaged
// bytes until an exact private recovery copy has been created and checked.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Entry, Thread } from "./hub";
import { MODES } from "../agents/types";
import { writeFileAtomic } from "./config";

export interface RecoveryNotice { backup: string; skipped: number; recovered: number; at: number }
export interface StoredQuests {
  [key: string]: unknown;
  threads: Thread[];
  view?: { selected?: string; collapsed?: string[]; pickAgent?: string; show?: string[] };
  pinned?: string[]; hidden?: string[]; archivedInSource?: string[]; acked?: string[];
  recovery?: RecoveryNotice;
}
export interface StorageWarning { level: "warn" | "error"; text: string }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string";
const id = (v: unknown) => string(v) && !!v.trim();
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const strings = (v: unknown) => Array.isArray(v) && v.every(string);
const optional = (v: Record<string, any>, key: string, valid: (x: any) => boolean) => v[key] === undefined || valid(v[key]);
const member = (values: readonly string[]) => (v: unknown) => string(v) && values.includes(v);
const statuses = ["new", "idle", "running", "approval", "error"];
const kinds = ["user", "assistant", "reasoning", "tool", "approval", "notice"];
const codes = new Set(["ENOENT", "EACCES", "EPERM", "ENOSPC", "EDQUOT", "EIO", "EBUSY", "EMFILE", "ENFILE", "EROFS", "EXDEV", "ESTALE"]);
export const storageCode = (e: unknown): string => codes.has((e as any)?.code) ? (e as any).code : "other";

function entry(v: unknown): v is Entry {
  return object(v) && id(v.id) && member(kinds)(v.kind) && string(v.text) && finite(v.at) &&
    ["title", "name", "output", "requestId"].every(key => optional(v, key, string)) &&
    optional(v, "streaming", x => typeof x === "boolean") && optional(v, "canAlways", x => typeof x === "boolean") && optional(v, "options", strings) &&
    optional(v, "status", member(["running", "ok", "error", "unknown"])) &&
    optional(v, "approval", member(["pending", "approved", "denied", "always", "expired"])) &&
    optional(v, "cut", x => typeof x === "boolean") && optional(v, "full", string) &&
    optional(v, "refused", x => object(x) && member(["proof", "fresh", "cut", "view"])(x.why) && finite(x.at)) &&
    optional(v, "level", member(["info", "error"]));
}

function thread(v: unknown): v is Thread {
  if (!object(v) || !id(v.id) || !id(v.agent) || !["cwd", "projectKey", "title"].every(key => string(v[key])) ||
      !member(statuses)(v.status) || !member(MODES)(v.mode) || !finite(v.createdAt) || !finite(v.updatedAt) ||
      typeof v.unread !== "boolean" || !member(["familiar", "external"])(v.origin) ||
      !Array.isArray(v.entries) || !v.entries.every(entry) || new Set(v.entries.map(e => e.id)).size !== v.entries.length ||
      !Array.isArray(v.todos) || !v.todos.every(t => object(t) && string(t.text) && member(["pending", "in_progress", "completed"])(t.status) && optional(t, "id", string))) return false;
  return ["nativeId", "model", "todoNote", "adoptedFrom", "lastError", "questsSent"].every(key => optional(v, key, string)) &&
    optional(v, "attentionSeen", x => x === null || string(x)) && optional(v, "kind", member(["chat", "tutorial"])) && optional(v, "fork", x => typeof x === "boolean") &&
    optional(v, "usage", x => object(x) && ["inputTokens", "outputTokens", "costUsd", "contextWindow"].every(key => optional(x, key, finite)));
}

function recovery(v: unknown): v is RecoveryNotice {
  return object(v) && string(v.backup) && /^threads\.json\.recovery(?:\.\d{1,2})?$/.test(v.backup) &&
    Number.isSafeInteger(v.skipped) && v.skipped >= 0 && Number.isSafeInteger(v.recovered) && v.recovered >= 0 && finite(v.at);
}

function decode(raw: unknown): { data: StoredQuests; damaged: boolean; skipped: number; unsupported?: boolean } {
  if (!object(raw)) return { data: { threads: [] }, damaged: true, skipped: 0 };
  if (raw.version !== undefined && raw.version !== 1) return { data: { threads: [] }, damaged: false, skipped: 0, unsupported: true };
  // Missing version, attentionSeen, optional provider fields and optional root collections are
  // supported legacy omissions. Unknown optional properties are retained, not reconstructed away.
  const data: StoredQuests = { ...raw, threads: [] };
  let damaged = false, skipped = 0;
  const rows: unknown[] = Array.isArray(raw.threads) ? raw.threads : [];
  if (raw.threads !== undefined && !Array.isArray(raw.threads)) damaged = true;
  const counts = new Map<string, number>();
  for (const row of rows) if (object(row) && id(row.id)) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  for (const row of rows) {
    if (thread(row) && counts.get(row.id) === 1) data.threads.push(row);
    else { damaged = true; skipped++; }
  }
  for (const key of ["pinned", "hidden", "archivedInSource", "acked"] as const)
    if (raw[key] !== undefined && !strings(raw[key])) { delete data[key]; damaged = true; }
  if (raw.view !== undefined && !(object(raw.view) && ["selected", "pickAgent"].every(key => optional(raw.view, key, string)) &&
      ["collapsed", "show"].every(key => optional(raw.view, key, strings)))) { delete data.view; damaged = true; }
  if (raw.recovery !== undefined && !recovery(raw.recovery)) { delete data.recovery; damaged = true; }
  return { data, damaged, skipped };
}

export class ThreadStore {
  private extras: Record<string, unknown> = {};
  private original?: Buffer;
  private blocked?: "read" | "unsupported" | "preserve" | "conflict";
  private writeError = false;
  private notice?: RecoveryNotice;
  code = "other";
  /** The last read found no saved-quest file at all: Familiar's first run on this profile. */
  firstRun = false;
  constructor(private file: string) {}

  get warning(): StorageWarning | undefined {
    if (this.blocked) return { level: "error", text: this.blocked === "unsupported"
      ? "Saved quests use an unsupported format. Saving is paused; the file has not been replaced."
      : this.blocked === "conflict" ? "The saved-quest file changed elsewhere during recovery. Saving is paused; the changed file has not been replaced."
      : "Saved quests could not be safely read or preserved. Saving is paused to protect the original file. Keep Familiar open and ask for recovery help." };
    if (this.writeError) return { level: "error", text: "Recent changes could not be saved. Keep Familiar open. New messages will not be sent until a save succeeds." };
    if (this.notice) return { level: "warn", text: `Saved quests could not be fully loaded: ${this.notice.recovered} valid records recovered; ${this.notice.skipped} invalid or ambiguous records skipped. Original bytes are preserved privately in Familiar's data folder.` };
  }

  read(): StoredQuests {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(this.file); }
    catch (e) {
      this.code = storageCode(e);
      if (this.code !== "ENOENT") this.blocked = "read";
      else this.firstRun = true;
      return { threads: [] };
    }
    let result: ReturnType<typeof decode>;
    try { result = decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
    catch { result = { data: { threads: [] }, damaged: true, skipped: 0 }; }
    if (result.unsupported) { this.blocked = "unsupported"; return { threads: [] }; }
    if (result.damaged) {
      try {
        const backup = this.preserve(bytes);
        this.original = bytes;
        result.data.recovery = { backup, skipped: result.skipped, recovered: result.data.threads.length, at: Date.now() };
      } catch (e) { this.blocked = "preserve"; this.code = storageCode(e); return { threads: [] }; }
    }
    this.notice = result.data.recovery;
    this.extras = Object.fromEntries(Object.entries(result.data).filter(([key]) => !["threads", "version", "view", "pinned", "hidden", "archivedInSource", "acked", "recovery"].includes(key)));
    return result.data;
  }

  blockUnexpectedLoad() { this.blocked = "read"; this.code = "other"; }

  private preserve(bytes: Buffer): string {
    for (let i = 0; i < 100; i++) {
      const file = this.file + ".recovery" + (i ? "." + i : "");
      try { fs.writeFileSync(file, bytes, { flag: "wx" }); }
      catch (e) {
        if ((e as any)?.code !== "EEXIST") throw e;
        // A repeated startup before replacement may reuse a verified exact-byte copy.
        try { if (fs.lstatSync(file).isFile() && fs.readFileSync(file).equals(bytes)) return path.basename(file); } catch { /* An unrelated collision is left untouched. */ }
        continue;
      }
      if (!fs.readFileSync(file).equals(bytes)) throw Object.assign(new Error("recovery verification failed"), { code: "EIO" });
      return path.basename(file);
    }
    throw Object.assign(new Error("recovery slots unavailable"), { code: "EIO" });
  }

  write(data: StoredQuests): boolean {
    if (this.blocked) return false;
    try {
      writeFileAtomic(this.file, JSON.stringify({ ...this.extras, ...data, version: 1, ...(this.notice ? { recovery: this.notice } : {}) }), this.original);
      this.original = undefined;
      this.writeError = false;
      return true;
    } catch (e) {
      this.code = storageCode(e);
      if (this.code === "ESTALE") this.blocked = "conflict";
      else this.writeError = true;
      return false;
    }
  }
}

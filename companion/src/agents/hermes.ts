// Hermes Agent's own session store (state.db), read-only: lists Hermes conversations — CLI, desktop
// app, ACP and, only with `hermesBotSessions` on, messaging-gateway ("Hermes bot") sessions from
// Telegram, Discord, Slack... — and reads their transcripts. Bot transcripts can hold other people's
// messages, so they are neither listed nor read by default. Hermes's ACP server only lists and resumes
// sessions created over ACP, so the others continue as a new session seeded with a digest (see
// AcpCatalog.canResume). Never reads who people are (display_name, chat ids, origin_json).
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { peekConfig } from "../hub/config";
import type { AcpCatalog } from "./acp";
import type { HistoryEntry, ThreadInfo } from "./types";

/** Sources Hermes itself keeps out of session lists, plus scheduled runs. */
const HIDDEN_SOURCES = ["cron", "kanban", "tool", "oneshot"];
/** Sessions started on this PC by the user (Hermes CLI/TUI, desktop app, web dashboard, ACP, and
 * Claude/Codex sessions imported into Hermes). Every other source is a messaging gateway (Telegram,
 * Discord, Slack, WhatsApp, email, API server, plugin platforms...), shown only when opted in. */
const LOCAL_SOURCES = ["cli", "tui", "desktop", "webui", "local", "acp", "claude", "codex"];

/** Whether a Hermes session from `source` may be listed and read. */
export function hermesSessionShown(source: string | null | undefined, botSessions: boolean): boolean {
  return botSessions || LOCAL_SOURCES.includes(String(source ?? "").toLowerCase());
}

interface Row {
  id: string;
  source: string;
  title: string | null;
  cwd: string | null;
  model_config: string | null;
  started_at: number | null;
  last_activity_at: number | null;
  archived: number | null;
  pinned: number | null;
  end_reason: string | null;
  parent_session_id: string | null;
  first_user: string | null;
}

/** Where Hermes is installed (its source checkout lives in hermes-agent/ under it). */
function hermesSource(): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "hermes");
}

export function hermesHome(): string {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const win = path.join(local, "hermes");
  return fs.existsSync(path.join(win, "state.db")) ? win : path.join(os.homedir(), ".hermes");
}

export function hermesCatalog(
  log: (s: string) => void,
  dbPath = path.join(hermesHome(), "state.db"),
  botSessions: () => boolean = () => peekConfig().hermesBotSessions === true,
): AcpCatalog {
  const sources = new Map<string, string>(); // session id -> source (from the last listing)
  let warned = false;

  const open = () => {
    if (!fs.existsSync(dbPath)) return null;
    try {
      return new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
      if (!warned) log(`[hermes] can't read ${dbPath}: ${e}`);
      warned = true;
      return null;
    }
  };

  return {
    async listThreads(q) {
      const db = open();
      if (!db) return [];
      const bots = botSessions();
      try {
        // Bot sessions are filtered in SQL so their first message is never even read.
        const rows = db
          .prepare(
            `SELECT s.id, s.source, s.title, s.cwd, s.model_config, s.started_at, s.last_activity_at, s.archived, s.pinned,
                    s.end_reason, s.parent_session_id,
                    (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS first_user
               FROM sessions s
              WHERE COALESCE(s.hidden, 0) = 0 AND s.message_count > 0
                AND s.source NOT IN (${HIDDEN_SOURCES.map(() => "?").join(",")})
                ${bots ? "" : `AND LOWER(s.source) IN (${LOCAL_SOURCES.map(() => "?").join(",")})`}
              ORDER BY COALESCE(s.last_activity_at, s.started_at) DESC
              LIMIT 400`,
          )
          .all(...HIDDEN_SOURCES, ...(bots ? [] : LOCAL_SOURCES)) as unknown as Row[];
        const byId = new Map(rows.map((r) => [r.id, r]));
        const out: ThreadInfo[] = [];
        for (const r of rows) {
          const mc = parseJson(r.model_config);
          if (mc?._delegate_from || !hermesSessionShown(r.source, bots)) continue; // a sub-agent run; a bot session
          const parent = r.parent_session_id ? byId.get(r.parent_session_id) : undefined;
          if (parent?.end_reason === "compression") continue; // shown as part of its root conversation
          sources.set(r.id, r.source);
          const last = Math.max(chainLast(r, rows), toMs(r.started_at));
          const cwd = r.cwd || (typeof mc?.cwd === "string" ? mc.cwd : "");
          if (q.cwd && cwd.toLowerCase() !== q.cwd.toLowerCase()) continue;
          const title = (r.title || textOf(r.first_user) || "(untitled)").split(/\r?\n/)[0].slice(0, 90);
          out.push({
            nativeId: r.id,
            agent: "hermes",
            cwd,
            title,
            createdAt: toMs(r.started_at),
            updatedAt: last,
            origin: r.source,
            archived: !!r.archived,
            starred: !!r.pinned,
          });
        }
        // A conversation's latest activity can be in a compression continuation: sort after folding.
        return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, q.limit ?? 200);
      } catch (e) {
        if (!warned) log(`[hermes] state.db: ${e}`);
        warned = true;
        return [];
      } finally {
        db.close();
      }
    },

    async readHistory(nativeId, limit = 80) {
      const db = open();
      if (!db) return [];
      try {
        const src = db.prepare("SELECT source FROM sessions WHERE id = ?").get(nativeId) as any;
        if (!hermesSessionShown(src?.source, botSessions())) return []; // a bot session, not opted in
        // Follow compression continuations so the whole conversation reads as one.
        const chain = [nativeId];
        for (let i = 0; i < 50; i++) {
          const cur = db.prepare("SELECT end_reason FROM sessions WHERE id = ?").get(chain[chain.length - 1]) as any;
          if (cur?.end_reason !== "compression") break;
          const next = db.prepare("SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY started_at LIMIT 1").get(chain[chain.length - 1]) as any;
          if (!next?.id) break;
          chain.push(next.id);
        }
        const out: HistoryEntry[] = [];
        for (const id of chain) {
          const msgs = db
            .prepare("SELECT role, content, tool_name FROM messages WHERE session_id = ? AND COALESCE(active, 1) = 1 ORDER BY id")
            .all(id) as any[];
          for (const m of msgs) {
            const text = textOf(m.content);
            if (m.role === "user" && text) out.push({ kind: "user", text });
            else if (m.role === "assistant" && text) out.push({ kind: "assistant", text });
            else if (m.role === "tool") out.push({ kind: "tool", name: m.tool_name || "tool", summary: text.split(/\r?\n/)[0].slice(0, 160), ok: true });
          }
        }
        return out.slice(-limit);
      } finally {
        db.close();
      }
    },

    canResume(nativeId) {
      return sources.get(nativeId) === "acp";
    },

    // Through Hermes's own code (the same call its dashboard makes), so its locking, WAL and
    // compression-lineage rules apply — Familiar never writes state.db itself.
    archive(nativeId, archived) {
      const src = path.join(hermesSource(), "hermes-agent");
      const py = path.join(src, "venv", "Scripts", "python.exe");
      if (!fs.existsSync(py)) return Promise.resolve(false);
      const code = "import sys\nfrom hermes_state import SessionDB\nwith SessionDB() as db:\n    sys.exit(0 if db.set_session_archived(sys.argv[1], sys.argv[2] == '1') else 3)";
      return new Promise((resolve) => {
        execFile(py, ["-c", code, nativeId, archived ? "1" : "0"], { cwd: src, windowsHide: true, timeout: 30_000 }, (err) => {
          if (err) log(`[hermes] archive ${nativeId}: ${String(err.message ?? err).slice(0, 300)}`);
          resolve(!err);
        });
      });
    },
  };
}

function chainLast(r: Row, rows: Row[]): number {
  let last = toMs(r.last_activity_at ?? r.started_at);
  let cur: Row | undefined = r;
  for (let i = 0; cur && cur.end_reason === "compression" && i < 50; i++) {
    cur = rows.find((x) => x.parent_session_id === cur!.id);
    if (cur) last = Math.max(last, toMs(cur.last_activity_at ?? cur.started_at));
  }
  return last;
}

function toMs(v: number | null | undefined): number {
  if (!v) return 0;
  return v < 1e12 ? Math.round(v * 1000) : v;
}

function parseJson(s: string | null): any {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Message content is text, or a JSON list of content parts. */
function textOf(content: unknown): string {
  if (typeof content !== "string") return "";
  const t = content.trim();
  if (t.startsWith("[")) {
    const parts = parseJson(t);
    if (Array.isArray(parts)) return parts.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("").trim();
  }
  return t;
}

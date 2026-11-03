// WoW install discovery, addon installation (junction to this repo) and the native snapshot
// (FamiliarSync) the addon loads at login / reload.
import * as fs from "node:fs";
import * as path from "node:path";
import { Config, writeFileAtomic } from "../hub/config";
import { Hub } from "../hub/hub";
import { buildModel } from "../hub/viewmodel";

export const DEFAULT_WOW_ROOT = "C:\\Program Files (x86)\\World of Warcraft";
const CONFIG_HINT = "Set wowRoot/wowFlavor in %APPDATA%\\Familiar\\config.json";

export interface WowInstall {
  root: string;
  flavor: string;
  dir: string;
  addons: string;
  /** Battle.net product from `.flavor.info` (e.g. `wow_classic_beta`). */
  product?: string;
  /** Client version from the root's `.build.info` (e.g. `1.60.2.70500`). */
  version?: string;
  /** Interface number the client expects, computed from `version`. */
  iface?: number;
  source: "running" | "config" | "build.info";
}

export interface FlavorInfo {
  root: string;
  flavor: string;
  dir: string;
  product?: string;
  version?: string;
}

export interface WowProbe {
  install: WowInstall | null;
  roots: string[];
  flavors: FlavorInfo[];
  error?: string;
}

/** `## Interface:` numbers of a toc (comma lists allowed). */
export function tocInterfaces(tocPath: string): number[] {
  let text = "";
  try {
    text = fs.readFileSync(tocPath, "utf8");
  } catch {
    return [];
  }
  const m = /^## Interface:\s*(.+?)\s*$/m.exec(text);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

/** `<root>\.build.info`: pipe-delimited with a header row (`Version!STRING:0`, `Product!STRING:0`, ...). */
export function readBuildInfo(root: string): Map<string, { version: string }> {
  const out = new Map<string, { version: string }>();
  let text = "";
  try {
    text = fs.readFileSync(path.join(root, ".build.info"), "utf8");
  } catch {
    return out;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return out;
  const header = lines[0].split("|").map((h) => h.split("!")[0].trim());
  const iv = header.indexOf("Version");
  const ip = header.indexOf("Product");
  if (iv < 0 || ip < 0) return out;
  for (const line of lines.slice(1)) {
    const cols = line.split("|");
    const product = cols[ip]?.trim();
    const version = cols[iv]?.trim();
    if (product && version && !out.has(product)) out.set(product, { version });
  }
  return out;
}

/** `<flavor dir>\.flavor.info`: line 2 is the product (`wow_classic_beta`). */
export function readFlavorInfo(dir: string): string | null {
  try {
    const line = fs.readFileSync(path.join(dir, ".flavor.info"), "utf8").split(/\r?\n/)[1]?.trim();
    return line || null;
  } catch {
    return null;
  }
}

/** `a.b.c[.build]` -> a*10000 + b*100 + c (1.60.2 -> 16002). */
export function ifaceOf(version: string | undefined): number | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return undefined;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

function hasInterface(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "Interface")).isDirectory();
  } catch {
    return false;
  }
}

function flavorInfo(root: string, flavor: string, build?: Map<string, { version: string }>): FlavorInfo {
  const dir = path.join(root, flavor);
  const product = readFlavorInfo(dir) ?? undefined;
  const version = product ? (build ?? readBuildInfo(root)).get(product)?.version : undefined;
  return { root, flavor, dir, product, version };
}

function toInstall(f: FlavorInfo, source: WowInstall["source"]): WowInstall {
  return { root: f.root, flavor: f.flavor, dir: f.dir, addons: path.join(f.dir, "Interface", "AddOns"), product: f.product, version: f.version, iface: ifaceOf(f.version), source };
}

function listFlavors(root: string): FlavorInfo[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((d) => /^_.+_$/.test(d) && hasInterface(path.join(root, d)));
  } catch {
    return [];
  }
  const build = readBuildInfo(root);
  return names.map((f) => flavorInfo(root, f, build));
}

const isForeverVersion = (v?: string) => {
  const m = /^(\d+)\.(\d+)\./.exec(v ?? "");
  return !!m && Number(m[1]) === 1 && Number(m[2]) >= 60;
};

/** The Forever client among `flavors`: folder name, then product, then version, then the old beta folder. */
function pickForever(flavors: FlavorInfo[]): FlavorInfo | undefined {
  return (
    flavors.find((f) => f.flavor.toLowerCase() === "_forever_") ??
    flavors.find((f) => /forever|camelot/i.test(f.product ?? "")) ??
    flavors.find((f) => isForeverVersion(f.version)) ??
    flavors.find((f) => f.flavor.toLowerCase() === "_classic_beta_")
  );
}

const found = (flavors: FlavorInfo[]) => (flavors.length ? `found: ${flavors.map((f) => f.flavor).join(", ")}` : "found no client folders");

/**
 * Find the WoW: Forever client. Order: the running game's folder, an explicit `wowRoot`+`wowFlavor`
 * (an error if that folder is missing, never a guess), then the Forever flavor under `wowRoot` and
 * the default install root. Other flavors (`_retail_`, `_anniversary_`) are never picked.
 */
export function findWowInstall(cfg: Config, runningExePath?: string, opts: { defaultRoot?: string } = {}): WowProbe {
  const defaultRoot = opts.defaultRoot ?? DEFAULT_WOW_ROOT;
  if (runningExePath) {
    const dir = path.dirname(runningExePath);
    if (hasInterface(dir)) {
      const root = path.dirname(dir);
      const fi = flavorInfo(root, path.basename(dir));
      // Only a Forever client counts: a retail or Anniversary window must never become the install.
      if (pickForever([fi])) return { install: toInstall(fi, "running"), roots: [root], flavors: [] };
    }
  }
  const roots = [...new Set([cfg.wowRoot, defaultRoot].filter((r) => !!r))];
  if (cfg.wowFlavor) {
    const root = cfg.wowRoot || defaultRoot;
    const dir = path.join(root, cfg.wowFlavor);
    const flavors = listFlavors(root);
    if (hasInterface(dir)) return { install: toInstall(flavorInfo(root, cfg.wowFlavor), "config"), roots: [root], flavors };
    return { install: null, roots: [root], flavors, error: `wowFlavor '${cfg.wowFlavor}' not found under ${root}; ${found(flavors)}. ${CONFIG_HINT}.` };
  }
  const flavors = roots.flatMap(listFlavors);
  if (!flavors.length) return { install: null, roots, flavors, error: `World of Warcraft not found under ${roots.join(" or ")}. ${CONFIG_HINT}.` };
  const best = pickForever(flavors);
  if (!best) return { install: null, roots, flavors, error: `No WoW: Forever client under ${roots.join(" or ")} (${found(flavors)}). Install Forever in Battle.net, or set wowRoot/wowFlavor in %APPDATA%\\Familiar\\config.json.` };
  return { install: toInstall(best, "build.info"), roots, flavors };
}

export interface InterfaceCheck {
  level: "ok" | "warn";
  text: string;
}

/** Does the addon's `## Interface:` list cover the detected client? */
export function interfaceCheck(install: WowInstall, tocIfaces: number[]): InterfaceCheck {
  const list = tocIfaces.join(", ");
  const ver = install.version?.split(".").slice(0, 3).join(".");
  if (!install.iface) return { level: "warn", text: `client version unknown (no .build.info row for ${install.flavor}); addon lists ${list}. If WoW marks Familiar out of date, tick "Load out of date AddOns".` };
  if (tocIfaces.includes(install.iface)) return { level: "ok", text: `client ${ver} = ${install.iface}, addon lists ${list} -> OK` };
  return { level: "warn", text: `This client is ${ver} (interface ${install.iface}); the Familiar addon lists ${list}. WoW will call it out of date: tick "Load out of date AddOns" in the AddOns list, or update Familiar.` };
}

export interface InstallResult {
  ok: boolean;
  changed: boolean;
  messages: string[];
}

/** Compare folders; either may be a junction target (`\??\C:\...`) or no longer exist. */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => {
    p = p.replace(/^\\\\\?\\|^\\\?\?\\/, "");
    try {
      p = fs.realpathSync.native(p);
    } catch {
      p = path.resolve(p);
    }
    return p.replace(/[\\/]+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
}

/** Junction Interface/AddOns/Familiar -> repo addon, and create the FamiliarSync data addon. */
export function installAddon(install: WowInstall, repoAddonDir: string): InstallResult {
  const messages: string[] = [];
  let changed = false;
  try {
    fs.mkdirSync(install.addons, { recursive: true });
    const link = path.join(install.addons, "Familiar");
    let needLink = true;
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(link); // never follows the link: a dangling junction still shows up
    } catch {
      /* nothing there */
    }
    if (st?.isSymbolicLink()) {
      let target = "";
      try {
        target = fs.readlinkSync(link);
      } catch {
        /* unreadable reparse point */
      }
      if (target && fs.existsSync(link) && sameDir(target, repoAddonDir)) needLink = false;
      else {
        fs.unlinkSync(link);
        messages.push(target && fs.existsSync(target) ? `Re-pointed Familiar link (was ${target}).` : "Removed a broken Familiar link.");
      }
    } else if (st) {
      needLink = false;
      messages.push("Interface/AddOns/Familiar is a real folder; leaving it alone (remove it to use the live repo copy).");
    }
    if (needLink) {
      fs.symlinkSync(repoAddonDir, link, "junction");
      changed = true;
      messages.push(`Linked ${link} -> ${repoAddonDir}`);
    }
    const sync = path.join(install.addons, "FamiliarSync");
    fs.mkdirSync(sync, { recursive: true });
    const toc = path.join(sync, "FamiliarSync.toc");
    // Same Interface list as the addon, so WoW treats both the same way (out of date or not).
    const ifaces = tocInterfaces(path.join(repoAddonDir, "Familiar.toc"));
    const tocText = [
      `## Interface: ${ifaces.join(", ")}`,
      "## Title: Familiar Sync",
      "## Notes: Snapshot written by the Familiar companion; loaded at login and /reload.",
      "## Group: Familiar",
      "",
      "FamiliarSync.lua",
      "",
    ].join("\n");
    if (!fs.existsSync(toc) || fs.readFileSync(toc, "utf8") !== tocText) {
      fs.writeFileSync(toc, tocText);
      changed = true;
    }
    const lua = path.join(sync, "FamiliarSync.lua");
    if (!fs.existsSync(lua)) {
      fs.writeFileSync(lua, "-- Written by the Familiar companion.\nFamiliarSyncData = nil\n");
      changed = true;
    }
    if (changed) messages.push("Addon files changed: restart WoW (new files are only seen at client start), or /reload if WoW was already restarted since install.");
    return { ok: true, changed, messages };
  } catch (e: any) {
    messages.push("Install failed: " + (e?.message ?? e));
    return { ok: false, changed, messages };
  }
}

/** Remove what installAddon created: the Familiar link (never a real folder) and FamiliarSync. */
export function uninstallAddon(install: WowInstall): string[] {
  const messages: string[] = [];
  const link = path.join(install.addons, "Familiar");
  try {
    if (fs.lstatSync(link).isSymbolicLink()) {
      fs.unlinkSync(link);
      messages.push(`Removed the Familiar link at ${link}.`);
    } else messages.push(`${link} is a real folder; left in place.`);
  } catch {
    /* no link */
  }
  const sync = path.join(install.addons, "FamiliarSync");
  if (fs.existsSync(sync)) {
    fs.rmSync(sync, { recursive: true, force: true });
    messages.push("Removed FamiliarSync.");
  }
  return messages;
}

// ---- native snapshot ---------------------------------------------------------------------------

/** WoW's fonts lack many Unicode glyphs; fold common punctuation to ASCII. */
const WOW_SAFE: Record<string, string> = { "…": "...", "—": "-", "–": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "→": "->", "←": "<-", "•": "*", "✓": "v", "✗": "x" };

export function luaString(s: string): string {
  let out = '"';
  for (const raw of s) {
    const ch = WOW_SAFE[raw] ?? raw;
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") continue;
    else if (ch === "|") out += "||"; // WoW escape sequences: show a literal pipe
    else if (c < 32) out += "\\" + c.toString().padStart(3, "0");
    else out += ch;
  }
  return out + '"';
}

export function buildSnapshot(hub: Hub, opts: { stopping?: boolean } = {}): string {
  const m = buildModel(hub, { linked: true, fps: 0 });
  const list = m.list.rows.slice(0, 80).map((r) => {
    const prefix = (r.kind === "thread" || r.kind === "ext") && r.agent ? `[${m.providers[r.agent]?.label ?? r.agent}] ` : "";
    return `{ kind = ${luaString(r.kind === "ext" ? "thread" : r.kind)}, text = ${luaString(prefix + r.text)} }`;
  });
  let selected = "nil";
  const d = m.detail;
  if (d.kind === "thread" && m.private) {
    // Private mode: generic header only and no transcript, so the native layer and screenshots don't leak.
    const text = `${d.project} - ${m.providers[d.agent]?.label ?? d.agent} - ${d.mode}\n\nHide names is on: the conversation shows on the Glass only.`;
    selected = `{ title = ${luaString(d.title)}, text = ${luaString(m.storage ? m.storage.text + "\n\n" + text : text)} }`;
  } else if (d.kind === "thread") {
    const lines: string[] = [];
    lines.push(`${d.project} - ${m.providers[d.agent]?.label ?? d.agent} - ${d.mode}`);
    if (d.todos.length) {
      lines.push("", "|cffffd100Objectives|r");
      for (const t of d.todos) lines.push(`  ${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]"} ${t.text}`);
    }
    for (const e of d.entries) {
      if (e.kind === "user") lines.push("", `|cffb9a3ffYou:|r ${e.text}`);
      else if (e.kind === "assistant") lines.push("", e.text);
      else if (e.kind === "tool") lines.push(`  |cff9d9384> ${e.name}: ${e.text} [${e.status}]|r`);
      else if (e.kind === "approval") lines.push(`  |cffff9d2e! ${e.title} (${e.approval})|r`);
      else if (e.kind === "notice") lines.push(`  |cff9d9384${e.text}|r`);
    }
    let text = lines.join("\n");
    if (text.length > 16000) text = "…" + text.slice(-16000);
    // Keep exceptional storage guidance visible even when the native transcript is tail-capped.
    if (m.storage) text = m.storage.text + "\n\n" + text.slice(-Math.max(0, 16000 - m.storage.text.length - 2));
    // Colour codes above are intentional; escape only pipes that came from agent text.
    selected = `{ title = ${luaString(d.title)}, text = ${luaStringKeepColors(text)} }`;
  } else if (m.storage) {
    selected = `{ title = "Saved quests need attention", text = ${luaString(m.storage.text)} }`;
  }
  return [
    "-- Written by the Familiar companion. Do not edit; it is replaced continuously.",
    "FamiliarSyncData = {",
    `  generatedAt = ${Math.floor(Date.now() / 1000)},`,
    // Companion clock (epoch seconds). The addon compares it with its own outbox timestamps.
    ...(opts.stopping ? [`  stoppedAt = ${Math.floor(Date.now() / 1000)},`] : []),
    `  acked = { ${hub.acked.slice(-60).map(luaString).join(", ")} },`,
    // Provider ids the addon accepts in /fam <provider> <text> and /fam show <provider>.
    `  providers = { ${Object.keys(hub.backends).filter((id) => hub.enabled(id)).map(luaString).join(", ")} },`,
    `  list = {\n    ${list.join(",\n    ")}\n  },`,
    `  selected = ${selected},`,
    "}",
    "",
  ].join("\n");
}

/** Like luaString, but keeps |cff......| / |r colour codes we inserted. */
function luaStringKeepColors(s: string): string {
  const parts = s.split(/(\|cff[0-9a-f]{6}|\|r)/i);
  return parts
    .map((p, i) => (i % 2 === 1 ? luaString(p).slice(1, -1).replace(/\|\|/g, "|") : luaString(p).slice(1, -1)))
    .reduce((acc, p) => acc + p, '"')
    .concat('"');
}

export class SnapshotWriter {
  private timer?: NodeJS.Timeout;
  private last = "";
  constructor(private hub: Hub, private file: () => string | null, private log: (s: string) => void) {}
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writeNow();
    }, 3000);
  }
  /** `force`: write even if nothing changed (heartbeat); `stopping`: mark the companion as closed. */
  writeNow(opts: { force?: boolean; stopping?: boolean } = {}) {
    const f = this.file();
    if (!f || !fs.existsSync(path.dirname(f))) return;
    const text = buildSnapshot(this.hub, opts);
    const body = text.replace(/generatedAt = \d+/, "");
    if (body === this.last && !opts.force && !opts.stopping) return;
    this.last = body;
    try {
      writeFileAtomic(f, text);
    } catch (e) {
      this.log("[sync] write failed: " + e);
    }
  }
}

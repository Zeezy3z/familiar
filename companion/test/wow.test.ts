// WoW install discovery and addon installation against throwaway install trees (no real WoW folder,
// no registry). Junctions need no admin on Windows.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../src/hub/config";
import { findWowInstall, ifaceOf, installAddon, interfaceCheck, readBuildInfo, readFlavorInfo, tocInterfaces, uninstallAddon, WowInstall } from "../src/main/wow";

const REPO_ADDON = path.resolve(__dirname, "..", "..", "addon", "Familiar");
const REPO_TOC = path.join(REPO_ADDON, "Familiar.toc");

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function dir(prefix = "fam-wow-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmp.push(d);
  return d;
}

const HEADER =
  "Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Install Key!HEX:16|IM Size!DEC:4|CDN Path!STRING:0|CDN Hosts!STRING:0|CDN Servers!STRING:0|Tags!STRING:0|Armadillo!STRING:0|Last Activated!STRING:0|Version!STRING:0|KeyRing!HEX:16|Product!STRING:0";

/** A WoW root with the given flavor folders, `.flavor.info` per flavor and one `.build.info`. */
function root(flavors: Record<string, { product: string; version: string; wtf?: number }>) {
  const r = dir();
  const rows: string[] = [];
  for (const [f, x] of Object.entries(flavors)) {
    fs.mkdirSync(path.join(r, f, "Interface"), { recursive: true });
    fs.writeFileSync(path.join(r, f, ".flavor.info"), `Product Flavor!STRING:0\n${x.product}\n`);
    if (x.wtf) {
      fs.mkdirSync(path.join(r, f, "WTF"));
      fs.utimesSync(path.join(r, f, "WTF"), x.wtf, x.wtf);
    }
    rows.push(`us|1|k|c|||tpr/wow|h|s|t|||${x.version}||${x.product}`);
  }
  fs.writeFileSync(path.join(r, ".build.info"), HEADER + "\n" + rows.join("\n") + "\n");
  return r;
}
const cfgAt = (wowRoot: string, wowFlavor = "") => ({ ...DEFAULT_CONFIG, wowRoot, wowFlavor });
// Never scan this machine's real install: the default root points at nothing.
const NO_DEFAULT = { defaultRoot: path.join(os.tmpdir(), "fam-wow-no-default-root") };
const probe = (cfg: ReturnType<typeof cfgAt>, exe?: string) => findWowInstall(cfg, exe, NO_DEFAULT);
const fakeInstall = (addons: string): WowInstall => ({ root: path.dirname(path.dirname(path.dirname(addons))), flavor: "_forever_", dir: path.dirname(path.dirname(addons)), addons, source: "config" });

describe("install files", () => {
  it("reads .build.info rows by product and .flavor.info's product line", () => {
    const r = root({ _classic_beta_: { product: "wow_classic_beta", version: "1.60.1.70450" }, _anniversary_: { product: "wow_anniversary", version: "2.5.6.70006" } });
    expect(readBuildInfo(r).get("wow_classic_beta")).toEqual({ version: "1.60.1.70450" });
    expect(readBuildInfo(r).get("wow_anniversary")).toEqual({ version: "2.5.6.70006" });
    expect(readFlavorInfo(path.join(r, "_anniversary_"))).toBe("wow_anniversary");
    expect(readFlavorInfo(path.join(r, "_none_"))).toBeNull();
    expect(readBuildInfo(path.join(r, "_none_")).size).toBe(0);
  });

  it("ifaceOf", () => {
    expect(ifaceOf("1.60.1.70450")).toBe(16001);
    expect(ifaceOf("1.60.2.1")).toBe(16002);
    expect(ifaceOf("12.0.1.70000")).toBe(120001);
    expect(ifaceOf("junk")).toBeUndefined();
    expect(ifaceOf(undefined)).toBeUndefined();
  });

  it("tocInterfaces parses comma lists", () => {
    const d = dir();
    const toc = path.join(d, "x.toc");
    fs.writeFileSync(toc, "## Interface: 16001, 16002\n## Title: x\n");
    expect(tocInterfaces(toc)).toEqual([16001, 16002]);
    fs.writeFileSync(toc, "## Title: x\n## Interface: 16003\n");
    expect(tocInterfaces(toc)).toEqual([16003]);
    expect(tocInterfaces(path.join(d, "missing.toc"))).toEqual([]);
  });

  it("the real Familiar.toc lists 16001 and carries the companion's package version", () => {
    expect(tocInterfaces(REPO_TOC)).toContain(16001);
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
    expect(/^## Version: (.+?)\s*$/m.exec(fs.readFileSync(REPO_TOC, "utf8"))![1]).toBe(pkg.version);
  });

  it("interfaceCheck warns when the client's number is not listed", () => {
    const base = fakeInstall(path.join("C:\\x", "_forever_", "Interface", "AddOns"));
    expect(interfaceCheck({ ...base, version: "1.60.2.70500", iface: 16002 }, [16001, 16002, 16003])).toEqual({ level: "ok", text: "client 1.60.2 = 16002, addon lists 16001, 16002, 16003 -> OK" });
    const warn = interfaceCheck({ ...base, version: "1.61.0.80000", iface: 16100 }, [16001, 16002, 16003]);
    expect(warn.level).toBe("warn");
    expect(warn.text).toMatch(/1\.61\.0 \(interface 16100\).*16001, 16002, 16003.*Load out of date AddOns/);
    expect(interfaceCheck(base, [16001]).level).toBe("warn");
  });
});

describe("findWowInstall", () => {
  it("picks _forever_ over _retail_ regardless of WTF mtime", () => {
    const r = root({ _retail_: { product: "wow", version: "12.0.1.70000", wtf: 2e9 }, _forever_: { product: "wow_classic_x", version: "1.60.2.70500", wtf: 1e9 } });
    const p = probe(cfgAt(r));
    expect(p.error).toBeUndefined();
    expect(p.install).toMatchObject({ root: r, flavor: "_forever_", dir: path.join(r, "_forever_"), addons: path.join(r, "_forever_", "Interface", "AddOns"), product: "wow_classic_x", version: "1.60.2.70500", iface: 16002, source: "build.info" });
  });

  it("recognises Forever by product name or 1.60.x version, then the old beta folder", () => {
    const byProduct = root({ _retail_: { product: "wow", version: "12.0.1.1" }, _camelot_: { product: "wow_forever", version: "9.9.9.9" } });
    expect(probe(cfgAt(byProduct)).install?.flavor).toBe("_camelot_");
    const byVersion = root({ _anniversary_: { product: "wow_anniversary", version: "2.5.6.70006", wtf: 2e9 }, _xx_: { product: "wow_classic_x", version: "1.60.3.1" } });
    expect(probe(cfgAt(byVersion)).install).toMatchObject({ flavor: "_xx_", iface: 16003 });
    const beta = root({ _classic_beta_: { product: "wow_classic_beta", version: "9.9.9.9" }, _retail_: { product: "wow", version: "12.0.1.1" } });
    expect(probe(cfgAt(beta)).install?.flavor).toBe("_classic_beta_");
  });

  it("errors naming the flavors found when no Forever client exists, and never picks another", () => {
    const r = root({ _anniversary_: { product: "wow_anniversary", version: "2.5.6.70006", wtf: 2e9 }, _retail_: { product: "wow", version: "12.0.1.70000" } });
    const p = probe(cfgAt(r));
    expect(p.install).toBeNull();
    expect(p.error).toMatch(/_anniversary_/);
    expect(p.error).toMatch(/_retail_/);
    expect(p.error).toMatch(/wowRoot\/wowFlavor/);
    expect(p.flavors.map((f) => f.flavor).sort()).toEqual(["_anniversary_", "_retail_"]);
  });

  it("ignores _*_ folders without Interface and reports a missing root", () => {
    const r = root({ _forever_: { product: "wow_forever", version: "1.60.2.1" } });
    fs.mkdirSync(path.join(r, "_leftover_"));
    expect(probe(cfgAt(r)).flavors.map((f) => f.flavor)).toEqual(["_forever_"]);
    const none = probe(cfgAt(path.join(r, "nope")));
    expect(none.install).toBeNull();
    expect(none.error).toMatch(/not found/);
  });

  it("wowFlavor override wins, and a missing override is an error naming the keys", () => {
    const r = root({ _a_: { product: "wow_a", version: "1.60.2.1" }, _b_: { product: "wow_b", version: "1.60.2.1" } });
    expect(probe(cfgAt(r, "_b_")).install).toMatchObject({ flavor: "_b_", source: "config", product: "wow_b", iface: 16002 });
    const p = probe(cfgAt(r, "_zz_"));
    expect(p.install).toBeNull();
    expect(p.error).toMatch(/wowFlavor '_zz_' not found under/);
    expect(p.error).toMatch(/found: _a_, _b_/);
    expect(p.error).toMatch(/wowRoot\/wowFlavor/);
  });

  it("uses the running exe's folder first", () => {
    const r = root({ _forever_: { product: "wow_classic_beta", version: "1.60.1.70450" } });
    const p = probe(cfgAt("C:\\nope"), path.join(r, "_forever_", "Wow.exe"));
    expect(p.install).toMatchObject({ root: r, flavor: "_forever_", source: "running", product: "wow_classic_beta", version: "1.60.1.70450", iface: 16001 });
    // An exe outside any client folder falls through to the roots.
    expect(probe(cfgAt(r), path.join(r, "World of Warcraft Launcher.exe")).install?.source).toBe("build.info");
  });

  it("never adopts a running retail or Anniversary client as the install", () => {
    const r = root({ _retail_: { product: "wow", version: "12.0.1.70000" }, _forever_: { product: "wow_classic_x", version: "1.60.2.70500" } });
    // Retail is running: the Forever folder next to it is still the install.
    expect(probe(cfgAt(r), path.join(r, "_retail_", "Wow.exe")).install).toMatchObject({ flavor: "_forever_", source: "build.info" });
    // Retail is running and there is no Forever client at all: an error, not _retail_.
    const only = root({ _retail_: { product: "wow", version: "12.0.1.70000" } });
    const p = probe(cfgAt(only), path.join(only, "_retail_", "Wow.exe"));
    expect(p.install).toBeNull();
    expect(p.error).toMatch(/No WoW: Forever client/);
  });
});

describe("installAddon", () => {
  it("links the addon and writes FamiliarSync.toc with the same Interface list as Familiar.toc", () => {
    const addons = path.join(dir(), "Interface", "AddOns");
    const r = installAddon(fakeInstall(addons), REPO_ADDON);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(fs.lstatSync(path.join(addons, "Familiar")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(addons, "Familiar", "Familiar.toc"))).toBe(true);
    const list = tocInterfaces(path.join(addons, "FamiliarSync", "FamiliarSync.toc"));
    expect(list).toEqual(tocInterfaces(REPO_TOC));
    expect(list.length).toBeGreaterThan(1);
    expect(fs.existsSync(path.join(addons, "FamiliarSync", "FamiliarSync.lua"))).toBe(true);
    // Second install is a no-op.
    const again = installAddon(fakeInstall(addons), REPO_ADDON);
    expect(again).toMatchObject({ ok: true, changed: false, messages: [] });
  });

  it("replaces a dangling junction instead of failing with EEXIST", () => {
    const d = dir();
    const addons = path.join(d, "Interface", "AddOns");
    fs.mkdirSync(addons, { recursive: true });
    const old = path.join(d, "old-copy");
    fs.mkdirSync(old);
    const link = path.join(addons, "Familiar");
    fs.symlinkSync(old, link, "junction");
    fs.rmSync(old, { recursive: true });
    expect(fs.existsSync(link)).toBe(false); // dangling: the old code's existsSync said "nothing here"
    const r = installAddon(fakeInstall(addons), REPO_ADDON);
    expect(r.ok).toBe(true);
    expect(r.messages).toContain("Removed a broken Familiar link.");
    expect(fs.realpathSync.native(link).toLowerCase()).toBe(fs.realpathSync.native(REPO_ADDON).toLowerCase());
  });

  it("re-points a junction that targets another existing folder", () => {
    const d = dir();
    const addons = path.join(d, "Interface", "AddOns");
    fs.mkdirSync(addons, { recursive: true });
    const other = path.join(d, "other");
    fs.mkdirSync(other);
    const link = path.join(addons, "Familiar");
    fs.symlinkSync(other, link, "junction");
    const r = installAddon(fakeInstall(addons), REPO_ADDON);
    expect(r.ok).toBe(true);
    expect(r.messages.some((m) => m.startsWith("Re-pointed Familiar link"))).toBe(true);
    expect(fs.realpathSync.native(link).toLowerCase()).toBe(fs.realpathSync.native(REPO_ADDON).toLowerCase());
    expect(fs.existsSync(other)).toBe(true); // only the link was touched
  });

  it("leaves a real Familiar folder alone (CurseForge / WowUp install)", () => {
    const addons = path.join(dir(), "Interface", "AddOns");
    const real = path.join(addons, "Familiar");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "Familiar.toc"), "## Interface: 16001\n");
    const r = installAddon(fakeInstall(addons), REPO_ADDON);
    expect(r.ok).toBe(true);
    expect(r.messages.some((m) => m.includes("real folder"))).toBe(true);
    expect(fs.lstatSync(real).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(real, "Familiar.toc"), "utf8")).toBe("## Interface: 16001\n");
  });

  it("uninstallAddon removes the link and FamiliarSync but never a real folder", () => {
    const addons = path.join(dir(), "Interface", "AddOns");
    const install = fakeInstall(addons);
    installAddon(install, REPO_ADDON);
    uninstallAddon(install);
    expect(fs.existsSync(path.join(addons, "Familiar"))).toBe(false);
    expect(fs.existsSync(path.join(addons, "FamiliarSync"))).toBe(false);
    expect(fs.existsSync(REPO_TOC)).toBe(true);
    const real = path.join(addons, "Familiar");
    fs.mkdirSync(real);
    expect(uninstallAddon(install).some((m) => m.includes("real folder"))).toBe(true);
    expect(fs.existsSync(real)).toBe(true);
  });
});

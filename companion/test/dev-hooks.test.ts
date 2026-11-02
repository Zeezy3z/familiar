// Dev/test hooks (companion :47810, FakeWoW :47811): only with FAMILIAR_DEV=1, and only for local
// scripts that hold this run's token. Browsers (Origin), DNS rebinding (foreign Host) and requests
// without the token are refused before any handler runs.
import * as fs from "node:fs";
import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_TOKEN_HEADER, devEnabled, devTokenFile, serveDevHooks } from "../src/main/dev-hooks";

function request(port: number, headers: Record<string, string>, body = "") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/action", method: "POST", headers }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

let close: (() => void) | undefined;
afterEach(() => close?.());

describe("dev hooks", () => {
  it("are on only when FAMILIAR_DEV is exactly 1", () => {
    expect(devEnabled({ FAMILIAR_DEV: "1" })).toBe(true);
    for (const v of ["0", "false", "true", "", " 1", undefined]) expect(devEnabled({ FAMILIAR_DEV: v }), String(v)).toBe(false);
  });

  it("run a request only from a local script with this run's token", async () => {
    const handled: { url: string; body: string }[] = [];
    const hooks = await serveDevHooks(0, async (url, body) => (handled.push({ url, body }), { ok: true }), () => {});
    close = () => hooks.close();
    const { port, token } = hooks;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(fs.readFileSync(devTokenFile(port), "utf8")).toBe(token); // where e2e.mjs / demo-events.mjs read it
    const host = `127.0.0.1:${port}`;
    const refused: Record<string, string>[] = [
      { host }, // no token
      { host, [DEV_TOKEN_HEADER]: "0".repeat(48) }, // wrong token
      { host, [DEV_TOKEN_HEADER]: token, origin: "https://evil.example" }, // a web page
      { host, [DEV_TOKEN_HEADER]: token, origin: "null" },
      { host: `evil.example:${port}`, [DEV_TOKEN_HEADER]: token }, // DNS rebinding
    ];
    for (const headers of refused) expect((await request(port, headers, '{"type":"decide"}')).status, JSON.stringify(headers)).toBe(403);
    expect(handled).toEqual([]);
    for (const h of [host, `localhost:${port}`]) {
      const ok = await request(port, { host: h, [DEV_TOKEN_HEADER]: token }, '{"type":"decide"}');
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toEqual({ ok: true });
    }
    expect(handled).toEqual([
      { url: "/action", body: '{"type":"decide"}' },
      { url: "/action", body: '{"type":"decide"}' },
    ]);
  });

  it("each run gets a new token", async () => {
    const a = await serveDevHooks(0, async () => true, () => {});
    const b = await serveDevHooks(0, async () => true, () => {});
    close = () => (a.close(), b.close());
    expect(a.token).not.toBe(b.token);
  });
});

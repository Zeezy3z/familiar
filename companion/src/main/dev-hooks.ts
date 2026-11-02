// Dev/test hooks (companion :47810, FakeWoW :47811) let local scripts approve requests and run JS,
// so they only exist with FAMILIAR_DEV=1 and only answer local scripts holding this run's token.
// A web page can reach 127.0.0.1 too: requests with an Origin header (browsers send one on
// cross-site POSTs) or another Host (DNS rebinding) are refused before any handler runs.
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

export const DEV_TOKEN_HEADER = "x-familiar-dev-token";

export function devEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FAMILIAR_DEV === "1";
}

/** Where a running hook server leaves its token for scripts/e2e.mjs and demo-events.mjs. */
export function devTokenFile(port: number): string {
  return path.join(os.tmpdir(), `familiar-dev-${port}.token`);
}

function refusal(req: http.IncomingMessage, port: number, token: string): string | undefined {
  if (req.headers.origin !== undefined) return "browser origin";
  const host = String(req.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return "foreign host";
  const got = Buffer.from(String(req.headers[DEV_TOKEN_HEADER] ?? ""));
  const want = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return "missing or wrong token";
  return undefined;
}

/** Serve `handle(url, body)` on 127.0.0.1:`port` (0 = any free port) with a fresh per-run token. */
export function serveDevHooks(
  port: number,
  handle: (url: string, body: string) => Promise<unknown>,
  log: (s: string) => void,
): Promise<{ port: number; token: string; close(): void }> {
  const token = randomBytes(24).toString("hex");
  let bound = port;
  const server = http.createServer((req, res) => {
    const no = refusal(req, bound, token);
    if (no) {
      log(`[dev] refused ${req.method} ${req.url}: ${no}`);
      req.resume();
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: `refused: ${no}` }));
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      let out: unknown;
      try {
        out = await handle(req.url ?? "", body);
      } catch (e: any) {
        out = { error: String(e?.stack ?? e) };
      }
      res.end(JSON.stringify(out, null, 1));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      bound = (server.address() as { port: number }).port;
      const file = devTokenFile(bound);
      fs.writeFileSync(file, token);
      log(`[dev] test hooks on 127.0.0.1:${bound} (token in ${file})`);
      resolve({
        port: bound,
        token,
        close() {
          server.close();
          fs.rmSync(file, { force: true });
        },
      });
    });
  });
}

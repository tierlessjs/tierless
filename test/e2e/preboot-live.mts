// LIVE ws-upgrade hello — the two boot fixes over a real socket, no editor build:
//   1. RESEAL FOLDED INTO THE UPGRADE: the gateway seals the upgrade's own cookie and
//      sends the blob in an unsolicited "hello" the instant the socket is up. The browser
//      auth wrapper takes its startup blob from there — the HTTP /__tierless/reseal round
//      trip never fires — and crossings still carry the sealed cookie to the backend.
//   2. PREBOOT JOIN: the gateway pre-fetches configured GET paths with that cookie at the
//      upgrade and ships the envelopes in the hello; the app's first GET to such a path
//      returns from the buffer with NO crossing (the backend is hit once, at preboot, not
//      again). A non-preboot GET crosses normally.
// Both are per-connection toggleable (auth/preboot) so a measured run isolates each lever.
//
// Run:  node test/e2e/preboot-live.mts
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { attachTierless } from "tierless/server";
import { cookieAuthority } from "tierless/session-auth";
import { configureTierless, sessionExec, sessionHello } from "tierless/browser";
import { cookieSessionAuth } from "tierless/adapt-session-auth";
import { makeCheck } from "../lib/check.mts";

const { WebSocket } = createRequire(import.meta.url)("ws");
const { check, ok } = makeCheck();
const COOKIE = "n8n-auth=SECRET";

// ---- mock backend: records each GET's cookie + a per-path hit count ---------------------
const backendHits: Record<string, number> = {};
const backendCookies: string[] = [];
const backend = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  backendHits[path] = (backendHits[path] ?? 0) + 1;
  backendCookies.push(String(req.headers.cookie ?? ""));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ path, hit: backendHits[path], sawCookie: String(req.headers.cookie ?? "") }));
});
await new Promise<void>((r) => backend.listen(0, r));
const backendUrl = "http://127.0.0.1:" + (backend.address() as { port: number }).port;

// ---- gateway: attachTierless + cookieAuthority, hello computed from the upgrade cookie --
const authority = cookieAuthority({ backendUrl, allowedOrigins: ["null", "http://localhost"], prebootPaths: ["/rest/settings"] });
const gwHttp = createServer((req, res) => { if (!authority.handleHttp(req, res)) { res.statusCode = 200; res.end("gw"); } });
let AUTH = true, PREBOOT = true;
attachTierless(gwHttp, {
  bundle: { PROGRAMS: {}, __unwind: () => false } as never,
  session: async (req) => {
    const cookie = String(req.headers.cookie ?? "");
    return { exec: authority.exec, hello: await authority.hello(cookie, { auth: AUTH, preboot: PREBOOT }) };
  },
});
await new Promise<void>((r) => gwHttp.listen(0, r));
const gwPort = (gwHttp.address() as { port: number }).port;
const gwWs = `ws://127.0.0.1:${gwPort}/__tierless`;
const gwHttpUrl = `http://127.0.0.1:${gwPort}`;

// ---- browser side: inject the cookie on the upgrade (connect() sets no headers itself) --
(globalThis as { WebSocket?: unknown }).WebSocket = class extends WebSocket {
  constructor(url: string, protocols?: string | string[]) { super(url, protocols, { headers: { cookie: COOKIE } }); }
};
let resealCalls = 0;
const countingFetch: typeof fetch = (input, init) => {
  if (String(input).includes("/__tierless/reseal")) resealCalls++;
  return fetch(input, init);
};

async function run(): Promise<void> {
  configureTierless({ url: gwWs, preconnect: true });
  const session = cookieSessionAuth({ gateway: gwHttpUrl, hello: sessionHello(), fetchImpl: countingFetch }).wrap(sessionExec());
  const get = (path: string) => session({ op: "resource", tier: "server", name: "api.get", args: [path] } as never) as Promise<{ status: number; body: { path: string; sawCookie: string } }>;

  const settings = await get("/rest/settings");   // a PREBOOT path -> should JOIN the buffer
  const other = await get("/rest/other");          // NOT preboot -> should CROSS to the backend

  check("preboot GET returned the pre-fetched value", settings?.body?.path === "/rest/settings", settings?.body);
  check("preboot GET JOINED — the backend was hit ONCE (preboot only), not again by a crossing", backendHits["/rest/settings"] === 1, backendHits);
  check("the preboot fetch carried the sealed cookie", backendCookies.includes(COOKIE));
  check("non-preboot GET crossed to the backend and returned its value", other?.body?.path === "/rest/other" && backendHits["/rest/other"] === 1, backendHits);
  check("the crossing carried the sealed cookie to the backend (blob decrypted server-side)", other?.body?.sawCookie === COOKIE, other?.body?.sawCookie);
  check("RESEAL FOLDED INTO UPGRADE — the HTTP reseal round trip never fired", resealCalls === 0, resealCalls);
}
await run();

gwHttp.close(); backend.close();
console.log(ok()
  ? "PASS — the ws-upgrade hello folded the reseal round trip into the handshake and pre-delivered a boot GET the first crossing joined (backend hit once, not twice)"
  : "FAIL");
process.exit(ok() ? 0 : 1);

// Sealed cookie authority (ROADMAP "gateway-mediated cookie authority, sealed";
// packages/tierless/src/session-auth.mts + adapt-session-auth.mts): the auth layer for
// cookie-authed SPAs at the session socket, proven against a real httpOnly-cookie
// backend. The ws transport is proven elsewhere (test/probes/host.mts) — this probe
// composes the browser wrapper directly over the gateway exec and asserts the
// AUTHORITY mechanics:
//
//   1. reseal trades the jar cookie for a blob; an empty jar yields none and an
//      unauthenticated crossing surfaces the backend's own 401 (stock behavior).
//   2. a crossing carries the blob; the backend sees the COOKIE and never the blob.
//   3. a set-cookie on any mediated response rotates in-band: new blob, and the claim
//      replays the raw Set-Cookie into the jar (the httpOnly path scripts can't take).
//   4. logout-shaped set-cookie (Max-Age=0) clears authority.
//   5. expired claim tickets are refused; sealed blobs from another boot are inert.
//   6. two "tabs" sharing a jar: A's authority dies when B rotates; A's next crossing
//      401s, reseals from the jar, retries once, and succeeds — the recovery path.
import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert";
import { cookieAuthority, mergeCookies } from "../../packages/tierless/src/session-auth.mjs";
import { cookieSessionAuth, SESSION_AUTH_HEADER } from "../../packages/tierless/src/adapt-session-auth.mjs";
import type { ResourceRequest } from "../../packages/tierless/src/types.mjs";

const PAGE_ORIGIN = "http://page.test";

// ---- a backend that authenticates with an httpOnly cookie ----------------------------
let token = "tok1";
const backend = createServer((req, res) => {
  const cookie = String(req.headers.cookie ?? "");
  assert(!(SESSION_AUTH_HEADER in req.headers), "the blob header must never reach the backend");
  const authed = cookie.includes(`auth=${token}`);
  const json = (code: number, body: unknown): void => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  if (req.url === "/api/login" && req.method === "POST") {
    res.setHeader("set-cookie", [`auth=${token}; HttpOnly; Path=/; SameSite=Lax`]);
    return json(200, { ok: true });
  }
  if (req.url === "/api/rotate" && req.method === "POST") {
    if (!authed) return json(401, { message: "Unauthorized" });
    token = "tok" + (Number(token.slice(3)) + 1);
    res.setHeader("set-cookie", [`auth=${token}; HttpOnly; Path=/; SameSite=Lax`]);
    return json(200, { rotated: true });
  }
  if (req.url === "/api/logout" && req.method === "POST") {
    if (!authed) return json(401, { message: "Unauthorized" });
    token = "tok" + (Number(token.slice(3)) + 1);   // n8n-style: logout bumps the token version, killing every issued cookie
    res.setHeader("set-cookie", ["auth=; HttpOnly; Path=/; Max-Age=0"]);
    return json(200, { bye: true });
  }
  if (req.url === "/api/me") return authed ? json(200, { user: "owner" }) : json(401, { message: "Unauthorized" });
  json(404, { message: "no route" });
});
backend.listen(0, "127.0.0.1");
await once(backend, "listening");
const backendUrl = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;

// ---- the gateway: authority exec + claim/reseal endpoints -----------------------------
const authority = cookieAuthority({ backendUrl, allowedOrigins: [PAGE_ORIGIN], claimTtlMs: 150 });
const gatewaySrv = createServer((req, res) => { if (!authority.handleHttp(req, res)) { res.statusCode = 404; res.end(); } });
gatewaySrv.listen(0, "127.0.0.1");
await once(gatewaySrv, "listening");
const gateway = `http://127.0.0.1:${(gatewaySrv.address() as { port: number }).port}`;

// ---- a browser-shaped fetch: one cookie jar per "browser", Origin attached, and
// Set-Cookie from responses applied to the jar — what the real jar does for claim ------
const makeBrowserFetch = (jar: Map<string, string>): typeof fetch => async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("origin", PAGE_ORIGIN);
  if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const r = await fetch(input, { ...init, headers });
  for (const line of (r.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []) {
    const [pair, ...attrs] = line.split(";");
    const i = pair.indexOf("=");
    const dead = /max-age=(-?\d+)/i.exec(attrs.join(";"));
    if (dead && Number(dead[1]) <= 0) jar.delete(pair.slice(0, i).trim());
    else if (i > 0 && pair.slice(i + 1).trim() !== "") jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    else jar.delete(pair.slice(0, i).trim());
  }
  return r;
};

const call = (exec: (r: ResourceRequest) => unknown, method: string, path: string, body?: unknown) =>
  exec({ op: "resource", tier: "server", name: "api." + method, args: [path, body, {}] }) as Promise<{ status: number; body: unknown }>;

// ---- 1+2: empty jar -> 401 passthrough; login -> rotation; cookie flows, blob doesn't --
const jar = new Map<string, string>();
const tabA = cookieSessionAuth({ gateway, fetchImpl: makeBrowserFetch(jar), channelName: "probe-a" }).wrap(authority.exec);
assert.equal((await call(tabA, "get", "/api/me")).status, 401, "empty jar: the backend's own 401 surfaces");
assert.equal((await call(tabA, "post", "/api/login")).status, 200, "login crosses");
await new Promise((r) => setTimeout(r, 50));   // claim is fired off the critical path
assert.equal(jar.get("auth"), "tok1", "the claim replayed Set-Cookie into the jar");
assert.equal((await call(tabA, "get", "/api/me")).status, 200, "the blob-carrying crossing authenticated");

// ---- 3: rotation on an arbitrary authenticated response --------------------------------
assert.equal((await call(tabA, "post", "/api/rotate")).status, 200, "rotate crosses");
assert.equal((await call(tabA, "get", "/api/me")).status, 200, "the rotated blob authenticates without any reseal");
await new Promise((r) => setTimeout(r, 50));
assert.equal(jar.get("auth"), token, "the claim kept the jar current through rotation");

// ---- 6: two tabs, one jar — out-of-band invalidation recovers through reseal+retry ----
const tabB = cookieSessionAuth({ gateway, fetchImpl: makeBrowserFetch(jar), channelName: "probe-b" }).wrap(authority.exec);
assert.equal((await call(tabB, "get", "/api/me")).status, 200, "tab B reseals from the shared jar");
assert.equal((await call(tabB, "post", "/api/rotate")).status, 200, "tab B rotates; tab A's blob is now dead");
await new Promise((r) => setTimeout(r, 50));
assert.equal((await call(tabA, "get", "/api/me")).status, 200, "tab A 401s, reseals from the jar, retries once, succeeds");

// ---- 4: logout clears authority everywhere --------------------------------------------
assert.equal((await call(tabA, "post", "/api/logout")).status, 200, "logout crosses");
await new Promise((r) => setTimeout(r, 50));
assert.equal(jar.has("auth"), false, "the claim's Max-Age=0 cleared the jar");
assert.equal((await call(tabB, "get", "/api/me")).status, 401, "tab B's dead blob 401s, reseal finds an empty jar, the 401 propagates — stock behavior");

// ---- 5: claim tickets expire; foreign blobs are inert ----------------------------------
assert.equal((await call(tabA, "post", "/api/login")).status, 200);
let heldClaim = "";
{ // capture a claim ticket without redeeming it, then outlive its ttl
  const hold: string[] = [];
  const capturingFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/__tierless/claim")) { hold.push(String(init?.body)); return new Response(null, { status: 204 }); }
    return makeBrowserFetch(jar)(input, init);
  };
  const tabC = cookieSessionAuth({ gateway, fetchImpl: capturingFetch, channelName: "probe-c" }).wrap(authority.exec);
  assert.equal((await call(tabC, "post", "/api/rotate")).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  heldClaim = hold[0];
  assert(heldClaim, "captured a live claim ticket");
}
await new Promise((r) => setTimeout(r, 200));   // past claimTtlMs=150
const expired = await fetch(gateway + "/__tierless/claim", { method: "POST", body: heldClaim, headers: { origin: PAGE_ORIGIN } });
assert.equal(expired.status, 403, "an expired claim ticket is refused");
const foreign = cookieAuthority({ backendUrl, allowedOrigins: [PAGE_ORIGIN] });   // another boot, another key
const liveBlob = ((await (await makeBrowserFetch(jar)(gateway + "/__tierless/reseal")).json()) as { blob: string }).blob;
assert(liveBlob, "reseal issued a live blob for the cross-boot check");
const env = await foreign.exec({ op: "resource", tier: "server", name: "api.get", args: ["/api/me", undefined, { headers: { [SESSION_AUTH_HEADER]: liveBlob } }] }) as { status: number };
assert.equal(env.status, 401, "a blob sealed under another boot's key is inert (unopenable -> no authority -> backend 401)");
const denied = await fetch(gateway + "/__tierless/reseal", { headers: { origin: "http://evil.test" } });
assert.equal(denied.status, 403, "reseal refuses origins outside the allowlist");

assert.equal(mergeCookies("a=1; b=2", ["b=3; Path=/", "c=4; HttpOnly", "a=; Max-Age=0"]), "b=3; c=4", "mergeCookies: update, insert, delete");

console.log("sealed cookie authority: blob crossings, in-band rotation, claim/reseal, expiry, and the two-tab 401 recovery all hold");
process.exit(0);   // keep-alive fetch sockets otherwise hold the loop open

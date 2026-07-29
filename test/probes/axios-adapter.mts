// PROBE: the tierless axios adapter translates faithfully in both directions.
// A fake exec records the ResourceRequest and returns canned envelopes; we drive the
// adapter with configs shaped like axios v1 hands its adapter (their fetcher.ts shape).
import { axiosAdapter } from "../../packages/tierless/src/adapt-axios.mts";
import type { ResourceRequest } from "../../packages/tierless/src/types.mts";

let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "ok" : "FAIL"}  ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

let seen: ResourceRequest | null = null;
let canned: unknown = { status: 200, headers: { "content-type": "application/json", "x-pagination-total-pages": "7" }, body: [{ id: 1 }] };
const adapter = axiosAdapter({ exec: async (req) => { seen = req; return canned; } });

// --- GET with params: axios default serialization (arrays as key[]) ---------------------
const res = await adapter({
  method: "get", baseURL: "http://127.0.0.1:3456/api/v1", url: "/projects/1/views/1/tasks",
  params: { "sort_by": ["position"], page: 1, filter: "", skip_me: undefined },
  headers: { Authorization: "Bearer tok123", "Content-Type": "application/json" },
}) as { status: number; data: unknown; headers: Record<string, string> };

check("resource name is api.get", seen!.name === "api.get");
const [url, body, opts] = seen!.args as [string, unknown, { headers: Record<string, string> }];
check("url joins base + path, ORIGIN-RELATIVE (the executing tier binds its own base)", url.startsWith("/api/v1/projects/1/views/1/tasks?"), url);
check("array params serialize as key[]", url.includes("sort_by%5B%5D=position"), url);

// nested objects serialize with bracketed keys and null array elements are skipped,
// axios's recursive visitor semantics — never JSON strings
const { serializeParams } = await import("../../packages/tierless/src/adapt-axios.mts");
check("nested object params serialize as bracketed keys", serializeParams({ filter: { status: "open", tags: ["a", null, "b"] } }) === "filter%5Bstatus%5D=open&filter%5Btags%5D%5B%5D=a&filter%5Btags%5D%5B%5D=b", serializeParams({ filter: { status: "open", tags: ["a", null, "b"] } }));
check("scalar + empty params kept, undefined dropped", url.includes("page=1") && url.includes("filter=") && !url.includes("skip_me"), url);
check("GET carries no body", body === undefined);
check("Authorization header rides the descriptor", opts.headers["authorization"] === "Bearer tok123");
check("status and data map back", res.status === 200 && Array.isArray(res.data));
check("pagination header readable exactly as their service reads it", res.headers["x-pagination-total-pages"] === "7");

// --- POST with body ----------------------------------------------------------------------
await adapter({ method: "post", baseURL: "http://x.test/api/v1", url: "/tasks", data: { title: "t" }, headers: {} });
check("POST resource + body", seen!.name === "api.post" && JSON.stringify((seen!.args as unknown[])[1]) === '{"title":"t"}');

// --- non-2xx honors validateStatus with an AxiosError-shaped rejection -------------------
canned = { status: 412, headers: { "content-type": "application/json" }, body: { message: "precondition" } };
type Caught = Error & { response?: { status: number; data: { message: string } }; isAxiosError?: boolean };
let caught: Caught | null = null;
try { await adapter({ method: "get", baseURL: "http://x.test/api/v1", url: "/nope", headers: {} }); } catch (e) { caught = e as Caught; }
check("non-2xx rejects", !!caught);
check("error carries .response like axios", caught?.isAxiosError === true && caught?.response?.status === 412 && caught?.response?.data.message === "precondition");

// --- browser-pinned configs fall through -------------------------------------------------
let fell = false;
const withFallback = axiosAdapter({ exec: async () => { throw new Error("must not reach exec"); }, fallback: async () => { fell = true; return "fallback-response"; } });
const fb = await withFallback({ method: "get", url: "/file", baseURL: "http://x.test", onUploadProgress: () => {}, headers: {} });
check("progress config uses fallback adapter", fell && fb === "fallback-response");

// --- protocol-relative URLs resolve, then get the same origin gate -----------------------
canned = { status: 200, headers: {}, body: null };
await adapter({ method: "get", baseURL: "http://x.test/api/v1", url: "//x.test/api/v1/self", headers: {} });
check("protocol-relative same-origin url crosses with a clean path", (seen!.args as [string])[0] === "/api/v1/self", (seen!.args as [string])[0]);
fell = false;
await withFallback({ method: "get", baseURL: "http://x.test/api/v1", url: "//elsewhere.test/x", headers: {} });
check("protocol-relative other-origin url falls back", fell);

// --- withCredentials is browser-pinned (cookie jar can't cross tiers) ---------------------
fell = false;
await withFallback({ method: "post", baseURL: "http://x.test/api/v1", url: "/auth/refresh", withCredentials: true, headers: {} });
check("withCredentials config uses fallback adapter", fell);

// --- abort/timeout semantics are browser-pinned (they can't cross the exec boundary) ------
fell = false;
await withFallback({ method: "get", baseURL: "http://x.test/api/v1", url: "/slow", timeout: 5000, headers: {} });
check("positive timeout uses fallback adapter", fell);
fell = false;
await withFallback({ method: "get", baseURL: "http://x.test/api/v1", url: "/s", signal: new AbortController().signal, headers: {} });
check("signal uses fallback adapter", fell);
fell = false;
await withFallback({ method: "get", baseURL: "http://x.test/api/v1", url: "/c", cancelToken: { promise: Promise.resolve() }, headers: {} });
check("cancelToken uses fallback adapter", fell);
await adapter({ method: "get", baseURL: "http://x.test/api/v1", url: "/t0", timeout: 0, headers: {} });
check("timeout 0 (axios default: none) still crosses", (seen!.args as [string])[0] === "/api/v1/t0", (seen!.args as [string])[0]);

// --- the two opt-in relaxations (AxiosAdapterOpts): credentials and timeouts -------------
// An app that sets either GLOBALLY on its api client (InvenTree: withCredentials = true,
// timeout = 5000) would otherwise pin 100% of its traffic and cross nothing.
canned = { status: 200, headers: {}, body: null };
const relaxed = axiosAdapter({ exec: async (req) => { seen = req; return canned; }, fallback: async () => { fell = true; return "fallback-response"; }, crossCredentialed: true, crossTimeouts: true });
fell = false;
await relaxed({ method: "post", baseURL: "http://x.test/api/v1", url: "/thing", withCredentials: true, timeout: 5000, headers: {} });
check("crossCredentialed + crossTimeouts: a credentialed, deadlined request crosses", !fell && (seen!.args as [string])[0] === "/api/v1/thing", String(fell) + " " + (seen!.args as [string])[0]);
// each opt-in relaxes only its own rule
fell = false;
await axiosAdapter({ exec: async () => canned, fallback: async () => { fell = true; return "f"; }, crossCredentialed: true })({ method: "get", baseURL: "http://x.test/api/v1", url: "/t", timeout: 5000, headers: {} });
check("crossCredentialed alone still pins on timeout", fell);
fell = false;
await axiosAdapter({ exec: async () => canned, fallback: async () => { fell = true; return "f"; }, crossTimeouts: true })({ method: "get", baseURL: "http://x.test/api/v1", url: "/t", withCredentials: true, headers: {} });
check("crossTimeouts alone still pins on withCredentials", fell);
// the deadline is really enforced, with axios's own ECONNABORTED shape
const slow = axiosAdapter({ exec: () => new Promise(() => { /* never settles */ }), crossTimeouts: true });
type Timed = Error & { code?: string; isAxiosError?: boolean };
let timedOut: Timed | null = null;
try { await slow({ method: "get", baseURL: "http://x.test/api/v1", url: "/slow", timeout: 30, headers: {} }); } catch (e) { timedOut = e as Timed; }
check("a crossing past its deadline rejects with axios's ECONNABORTED", timedOut?.code === "ECONNABORTED" && timedOut?.isAxiosError === true && /timeout of 30ms/.test(timedOut?.message || ""), String(timedOut?.message));
// and a crossing that beats the deadline is NOT held open by the timer
const t0 = Date.now();
await relaxed({ method: "get", baseURL: "http://x.test/api/v1", url: "/fast", timeout: 60_000, headers: {} });
check("a crossing inside its deadline returns immediately (timer cleared)", Date.now() - t0 < 1000);

// --- responseType text/document are browser-pinned (crossing parses by content-type) ------
fell = false;
await withFallback({ method: "get", baseURL: "http://x.test/api/v1", url: "/raw", responseType: "text", headers: {} });
check("responseType text uses fallback adapter", fell);

// --- binary bodies are browser-pinned (they'd JSON-serialize to {} on the crossing) -------
fell = false;
await withFallback({ method: "put", baseURL: "http://x.test/api/v1", url: "/bin", data: new Uint8Array([1, 2, 3]), headers: {} });
check("typed-array body uses fallback adapter", fell);
fell = false;
await withFallback({ method: "put", baseURL: "http://x.test/api/v1", url: "/bin2", data: new ArrayBuffer(8), headers: {} });
check("ArrayBuffer body uses fallback adapter", fell);

// --- axios Basic auth crosses as the Authorization header axios would set ----------------
canned = { status: 200, headers: {}, body: null };
await adapter({ method: "get", baseURL: "http://x.test/api/v1", url: "/b", auth: { username: "u", password: "p w" }, headers: { authorization: "Bearer stale" } });
check("auth {username,password} overwrites Authorization with Basic, like axios", ((seen!.args as unknown[])[2] as { headers: Record<string, string> }).headers.authorization === "Basic " + Buffer.from("u:p w").toString("base64"), JSON.stringify((seen!.args as unknown[])[2]));

// --- URLSearchParams params serialize like axios (Object.keys sees nothing in one) -------
canned = { status: 200, headers: {}, body: null };
await adapter({ method: "get", baseURL: "http://x.test/api/v1", url: "/u", params: new URLSearchParams([["a", "1"], ["a", "2"], ["b", "x y"]]), headers: {} });
check("URLSearchParams params serialize via toString", (seen!.args as [string])[0] === "/api/v1/u?a=1&a=2&b=x+y", (seen!.args as [string])[0]);

// --- per-request paramsSerializer is honored ---------------------------------------------
canned = { status: 200, headers: {}, body: null };
await adapter({ method: "get", baseURL: "http://x.test/api/v1", url: "/f", params: { a: 1 }, paramsSerializer: { serialize: () => "custom=1" }, headers: {} });
check("config paramsSerializer wins", (seen!.args as [string])[0].endsWith("/f?custom=1"));

// --- XSRF: axios sets it INSIDE its adapters, so ours has to (Django/Laravel CSRF) -------
// Stubbed browser globals, matching the api's origin so nothing else in the adapter shifts.
const env = globalThis as Record<string, unknown>;
env.document = { cookie: "other=1; csrftoken=tok%20en; more=2" };
env.location = { href: "http://x.test/app/", origin: "http://x.test" };
canned = { status: 200, headers: {}, body: null };
const xsrfCfg = { xsrfCookieName: "csrftoken", xsrfHeaderName: "X-CSRFToken" };
const crossedHeaders = async (c: Record<string, unknown>): Promise<Record<string, string>> => {
  await adapter({ method: "post", baseURL: "http://x.test/api/v1", url: "/p", data: {}, headers: {}, ...c });
  return ((seen!.args as unknown[])[2] as { headers: Record<string, string> }).headers;
};
check("withXSRFToken true: the cookie rides as the configured header, url-decoded", (await crossedHeaders({ ...xsrfCfg, withXSRFToken: true }))["x-csrftoken"] === "tok en");
check("withXSRFToken false: no header, like axios", (await crossedHeaders({ ...xsrfCfg, withXSRFToken: false }))["x-csrftoken"] === undefined);
check("unset withXSRFToken: same-origin api still gets it (axios's default rule)", (await crossedHeaders(xsrfCfg))["x-csrftoken"] === "tok en");
env.location = { href: "http://page.test/app/", origin: "http://page.test" };
check("unset withXSRFToken: cross-origin api does NOT get it (axios's default rule)", (await crossedHeaders(xsrfCfg))["x-csrftoken"] === undefined);
check("withXSRFToken true overrides the origin rule, like axios", (await crossedHeaders({ ...xsrfCfg, withXSRFToken: true }))["x-csrftoken"] === "tok en");
env.document = { cookie: "other=1" };
check("no csrf cookie: no header", (await crossedHeaders({ ...xsrfCfg, withXSRFToken: true }))["x-csrftoken"] === undefined);
delete env.document; delete env.location;

// --- crossHttpRequest: an ASYNC interceptor chain is awaited exactly once ----------------
const { crossHttpRequest, httpPins } = await import("../../packages/tierless/src/adapt.mts");
let asyncRuns = 0;
const inst = (fulfilled: (c: any) => unknown) => ({
  defaults: { baseURL: "http://x.test/api/v1", headers: { common: { accept: "application/json" } } },
  interceptors: { request: { forEach: (fn: (h: { fulfilled?: (c: unknown) => unknown }) => void) => [{ fulfilled }].forEach(fn) } },
});
const crossed = await crossHttpRequest(
  inst(async (c: any) => { asyncRuns++; c.headers.authorization = "Bearer t9"; return c; }) as never,
  { op: "resource", tier: "server", name: "http.get", args: ["/z"] },
) as { args: unknown[] } | null;
check("async interceptor: chain awaited ONCE, crossing carries its header", asyncRuns === 1 && !!crossed && (crossed.args[1] as { headers: Record<string, string> }).headers.authorization === "Bearer t9", JSON.stringify(crossed?.args));
const chainErr = await Promise.resolve(crossHttpRequest(
  inst(async () => { throw new Error("chain-fail"); }) as never,
  { op: "resource", tier: "server", name: "http.get", args: ["/z"] },
)).then(() => null, (e: Error) => e);
check("async interceptor: a chain error rejects like the request failing", chainErr?.message === "chain-fail", String(chainErr));

// --- httpPins: cookie-jar + abort semantics pin on the compiled-method path too ----------
check("httpPins pins withCredentials", httpPins({ op: "resource", tier: "server", name: "http.get", args: ["/x", { withCredentials: true }] }));
check("httpPins pins signal", httpPins({ op: "resource", tier: "server", name: "http.get", args: ["/x", { signal: new AbortController().signal }] }));
check("httpPins pins positive timeout, not timeout 0", httpPins({ op: "resource", tier: "server", name: "http.get", args: ["/x", { timeout: 3000, responseType: "json" }] }) && !httpPins({ op: "resource", tier: "server", name: "http.get", args: ["/x", { timeout: 0, responseType: "json" }] }));

// --- twinHttp: the server-side twin speaks the axios surface over fetch ------------------
const { twinHttp } = await import("../../packages/tierless/src/adapt.mts");
const { createServer } = await import("node:http");
const srv = createServer((req, res) => {
  if (req.url?.startsWith("/api/v1/miss")) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"message":"nope"}'); return; }
  res.writeHead(200, { "content-type": "application/json", "x-echo-auth": req.headers.authorization || "", "x-echo-url": req.url || "" });
  res.end(JSON.stringify({ m: req.method }));
});
await new Promise<void>((r) => srv.listen(0, r));
const port = (srv.address() as { port: number }).port;
const twin = twinHttp(`http://127.0.0.1:${port}/api/v1`, { token: "tok9" }) as Record<string, (...a: unknown[]) => Promise<{ data: { m: string }; status: number; headers: Record<string, string> }>>;

const g = await twin.get("/tasks/all", { params: { "sort_by": ["position"], page: 2 } });
check("twin GET hits base+path with axios-style params", g.status === 200 && g.headers["x-echo-url"] === "/api/v1/tasks/all?sort_by%5B%5D=position&page=2", g.headers["x-echo-url"]);
check("twin carries the session token as Bearer", g.headers["x-echo-auth"] === "Bearer tok9");
const p = await twin.put("/tasks/1", { title: "t" });
check("twin PUT sends body", p.data.m === "PUT");
let terr: Caught | null = null;
try { await twin.get("/miss"); } catch (e) { terr = e as Caught; }
check("twin non-2xx rejects AxiosError-shaped", terr?.isAxiosError === true && terr?.response?.status === 404 && terr?.response?.data.message === "nope");
srv.close();

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall adapter translations hold");

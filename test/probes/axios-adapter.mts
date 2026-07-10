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

// --- per-request paramsSerializer is honored ---------------------------------------------
canned = { status: 200, headers: {}, body: null };
await adapter({ method: "get", baseURL: "http://x.test/api/v1", url: "/f", params: { a: 1 }, paramsSerializer: { serialize: () => "custom=1" }, headers: {} });
check("config paramsSerializer wins", (seen!.args as [string])[0].endsWith("/f?custom=1"));

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

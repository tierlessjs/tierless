// Probe: conditional crossings (adapt-cache.mts) — the browser cache's HTTP
// revalidation semantics, on the session socket. A miss crosses clean and stores the
// ETag'd envelope; a hit attaches If-None-Match; a 304 replays the stored envelope
// (server-validated THIS crossing, never a staleness heuristic); a changed ETag
// restores; un-ETag'd and non-GET traffic is untouched. This is the fix for n8n's +8%
// byte regression (one 12.4 MB payload re-crossed per page session that stock
// browsers revalidate to a 0-byte 304 — ports/n8n/README.md byte anatomy).
//
// Run:  node test/probes/adapt-cache.mts
import { conditionalCrossings, memoryStore } from "tierless/adapt-cache";
import type { ResourceRequest } from "../../packages/tierless/src/types.mjs";
import { makeCounter } from "../lib/check.mts";

const { check, counts } = makeCounter();

// a fake backend-of-envelopes: versioned bodies per path, 304 on a matching validator
const versions = new Map<string, { etag: string; body: unknown }>();
versions.set("/big", { etag: 'W/"v1"', body: { nodes: Array.from({ length: 50 }, (_, i) => ({ i })) } });
versions.set("/plain", { etag: "", body: { ok: 1 } });
const seen: Array<{ name: string; path: string; inm?: string }> = [];
const inner = async (req: ResourceRequest): Promise<unknown> => {
  const [path, , opts] = req.args as [string, unknown?, { headers?: Record<string, string> }?];
  const inm = opts?.headers?.["if-none-match"];
  seen.push({ name: req.name, path, ...(inm ? { inm } : {}) });
  if (req.name !== "api.get") return { status: 200, headers: {}, body: "posted" };
  const v = versions.get(path)!;
  if (inm && inm === v.etag) return { status: 304, headers: { ...(v.etag ? { etag: v.etag } : {}) }, body: "" };
  return { status: 200, headers: { "content-type": "application/json", ...(v.etag ? { etag: v.etag } : {}) }, body: v.body };
};

const wrap = conditionalCrossings({ store: memoryStore() }).wrap(inner as never);
const get = (path: string): Promise<{ status?: number; body?: unknown }> =>
  wrap({ op: "res", tier: "server", name: "api.get", args: [path] } as never) as never;

console.log("Probe: conditional crossings — HTTP revalidation on the session socket\n");

// the store is DEFERRED to idle (never on the reply path — a page's boot window is
// contended); a tick between calls is part of the contract under test
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const first = await get("/big");
check("cold cache: crosses clean (no validator) and returns the 200", seen[0].inm === undefined && first.status === 200 && Array.isArray((first.body as { nodes: unknown[] }).nodes));

await settle();
const second = await get("/big");
check("warm cache: the crossing carries If-None-Match", seen[1].inm === 'W/"v1"');
check("304 replays the stored envelope — full body, status 200, no re-ship", second.status === 200 && (second.body as { nodes: unknown[] }).nodes.length === 50);

versions.set("/big", { etag: 'W/"v2"', body: { nodes: [{ i: -1 }] } });
await settle();
const third = await get("/big");
check("changed content: validator misses, the new 200 comes through", third.status === 200 && (third.body as { nodes: unknown[] }).nodes.length === 1);
await settle();
const fourth = await get("/big");
check("…and the NEW etag revalidates next time", seen[3].inm === 'W/"v2"' && fourth.status === 200 && (fourth.body as { nodes: unknown[] }).nodes.length === 1);

await get("/plain"); await settle(); await get("/plain");
check("un-ETag'd GETs never attach a validator", seen[4].inm === undefined && seen[5].inm === undefined);

const posted = await wrap({ op: "res", tier: "server", name: "api.post", args: ["/big", { x: 1 }] } as never) as { body?: unknown };
check("non-GET traffic passes through untouched", posted.body === "posted" && seen[6].name === "api.post" && seen[6].inm === undefined);

// a 304 with NO cached entry (another tab primed the server-side validator path, or a
// cold wrap behind a shared proxy): surfaced as-is — never invent a body
const bare = await (conditionalCrossings({ store: memoryStore() }).wrap((async () => ({ status: 304, headers: {}, body: "" })) as never))({ op: "res", tier: "server", name: "api.get", args: ["/big"] } as never) as { status?: number };
check("a 304 without a cache entry surfaces as-is", bare.status === 304);

// INDEX DRIFT: the path->etag index says hit, but the body entry was evicted. The 304
// must fall back to ONE unconditional re-crossing (never a replayed undefined), and
// the dead index entry stops attaching validators.
const driftSeen: Array<string | undefined> = [];
const driftInner = async (req: ResourceRequest): Promise<unknown> => {
  const inm = (req.args as [string, unknown?, { headers?: Record<string, string> }?])[2]?.headers?.["if-none-match"];
  driftSeen.push(inm);
  return inm ? { status: 304, headers: {}, body: "" } : { status: 200, headers: { etag: 'W/"v9"' }, body: { real: true } };
};
const drift = conditionalCrossings({ store: { index: () => new Map([["/big", 'W/"v1"']]), body: async () => undefined, set: async () => {} } }).wrap(driftInner as never);
const recovered = await drift({ op: "res", tier: "server", name: "api.get", args: ["/big"] } as never) as { status?: number; body?: { real?: boolean } };
check("evicted body behind a live index: 304 falls back to one unconditional re-crossing", recovered.status === 200 && recovered.body?.real === true && driftSeen[0] === 'W/"v1"' && driftSeen[1] === undefined, JSON.stringify(driftSeen));
const again = await drift({ op: "res", tier: "server", name: "api.get", args: ["/big"] } as never) as { status?: number };
check("…and the dead index entry stops attaching validators", again.status === 200 && driftSeen[2] === undefined);

// THE WIRE SHAPE of a forwarded validator (regression for the n8n gateway finding):
// undici's fetch stamps `cache-control: no-cache` onto conditional requests, and
// Express fresh() then refuses the 304 — restResources must preempt with max-age=0
// (a browser reload's own shape) or revalidation silently never works through a
// gateway. Assert against a real HTTP round trip, not a mock.
{
  const { createServer } = await import("node:http");
  const { restResources } = await import("tierless/adapt");
  let got: Record<string, unknown> = {};
  const srv = createServer((req, res) => { got = { ...req.headers }; res.setHeader("etag", 'W/"e1"'); res.statusCode = 304; res.end(); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const exec = restResources("http://127.0.0.1:" + (srv.address() as { port: number }).port, { envelopeErrors: true });
  const env = await exec({ op: "res", tier: "server", name: "api.get", args: ["/big", undefined, { headers: { "if-none-match": 'W/"e1"' } }] } as never) as { status: number };
  srv.close();
  check("a forwarded If-None-Match rides with cache-control max-age=0, never undici's no-cache", got["if-none-match"] === 'W/"e1"' && got["cache-control"] === "max-age=0", JSON.stringify({ inm: got["if-none-match"], cc: got["cache-control"] }));
  check("the 304 comes back as a tiny envelope (envelopeErrors mode)", env.status === 304);
}

const { pass, fail } = counts();
console.log(fail === 0
  ? `\nOK — conditional crossings give session GETs the browser cache's own revalidation: validated replay on 304, full fetch on change, untouched otherwise (${pass} checks)`
  : `\nFAIL (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

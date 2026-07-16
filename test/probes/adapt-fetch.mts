// adapt-fetch — the fetch twin of adapt-axios, with the crossability policy the Strapi
// port hand-wrote now FRAMEWORK-owned. This probe pins the whole decision matrix:
// what crosses (same-origin JSON negotiation, string/absent bodies), what stays on the
// host fetch byte-for-byte (FormData, non-JSON accepts, external origins, app pins,
// Request-object inputs, SSR), the override hook, abort semantics (immediate
// AbortError, crossing discarded), and envelope→Response reconstruction (status,
// headers, 204 null body, non-2xx passthrough).
//
// Run:  node test/probes/adapt-fetch.mts
import { fetchAdapter } from "tierless/adapt-fetch";
import type { ResourceRequest } from "tierless/server";
import { makeCounter } from "../lib/check.mts";

const { check, counts } = makeCounter();

// a browser, as far as the adapter's gate is concerned
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { location?: unknown }).location = new URL("http://app.local:3000/page");

const crossed: ResourceRequest[] = [];
const fell: { input: unknown; init?: RequestInit }[] = [];
let nextEnvelope: { status: number; headers?: Record<string, string>; body?: unknown } = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
const tfetch = fetchAdapter({
  exec: async (req) => { crossed.push(req as ResourceRequest); return nextEnvelope; },
  pins: (url) => url.pathname.startsWith("/api/pinned"),
  fetchImpl: (async (input: unknown, init?: RequestInit) => { fell.push({ input, init }); return new Response(JSON.stringify({ via: "host" }), { status: 200 }); }) as typeof fetch,
});

const JSON_HDRS = { accept: "application/json" };

// ---- what crosses ------------------------------------------------------------------
{
  const res = await tfetch("/api/items?q=1", { headers: JSON_HDRS });
  const req = crossed.at(-1)!;
  check("same-origin JSON GET crosses as api.get with the origin-relative path", req?.name === "api.get" && req.args[0] === "/api/items?q=1");
  check("the client's own headers ride the crossing", (req.args[2] as { headers: Record<string, string> }).headers.accept === "application/json");
  check("the envelope rebuilds into a real Response", res.status === 200 && ((await res.json()) as { ok: boolean }).ok === true && res.headers.get("content-type") === "application/json");
}
{
  await tfetch("/api/items", { method: "POST", body: JSON.stringify({ title: "x" }), headers: JSON_HDRS });
  const req = crossed.at(-1)!;
  check("string-body POST crosses with the body as sent", req.name === "api.post" && req.args[1] === JSON.stringify({ title: "x" }));
}
{
  nextEnvelope = { status: 404, headers: {}, body: { error: "nope" } };
  const res = await tfetch("/api/missing", { headers: JSON_HDRS });
  check("a non-2xx envelope passes through as that Response (the app's own error handling runs)", res.status === 404 && ((await res.json()) as { error: string }).error === "nope");
  nextEnvelope = { status: 204 };
  const res204 = await tfetch("/api/void", { method: "DELETE", headers: JSON_HDRS });
  check("204 rebuilds with a null body (Response forbids bodies on no-body statuses)", res204.status === 204 && (await res204.text()) === "");
  nextEnvelope = { status: 200, headers: {}, body: { ok: true } };
}

// ---- what stays on the host fetch --------------------------------------------------
const fallsThrough = async (label: string, run: () => Promise<unknown>): Promise<void> => {
  const before = { c: crossed.length, f: fell.length };
  await run();
  check(label, crossed.length === before.c && fell.length === before.f + 1);
};
await fallsThrough("no JSON accept → host fetch (binary/blob responses can't cross a JSON envelope)", () => tfetch("/api/items", {}));
await fallsThrough("FormData body → host fetch (the browser owns multipart framing)", () => { const fd = new FormData(); fd.append("f", "v"); return tfetch("/api/upload", { method: "POST", body: fd, headers: JSON_HDRS }); });
await fallsThrough("external origin → host fetch (external I/O is never a crossing)", () => tfetch("http://elsewhere.example/api/items", { headers: JSON_HDRS }));
await fallsThrough("app pin → host fetch (paths whose responses act on the browser)", () => tfetch("/api/pinned/login", { headers: JSON_HDRS }));
await fallsThrough("Request-object input → host fetch (consumed-once body streams)", () => tfetch(new Request("http://app.local:3000/api/items", { headers: JSON_HDRS }) as never));

// ---- the override hook --------------------------------------------------------------
{
  const forced = fetchAdapter({ exec: async (req) => { crossed.push(req as ResourceRequest); return nextEnvelope; }, crossable: (url) => (url.pathname === "/weird" ? true : undefined), fetchImpl: (async () => new Response("host")) as typeof fetch });
  await forced("/weird", {});                                        // no accept — default policy would fall through
  check("crossable() override forces a crossing past the default policy", crossed.at(-1)!.args[0] === "/weird");
}

// ---- abort semantics ----------------------------------------------------------------
{
  const pre = new AbortController();
  pre.abort();
  const err = await tfetch("/api/items", { headers: JSON_HDRS, signal: pre.signal }).then(() => null, (e: Error) => e);
  check("a pre-aborted signal throws AbortError without crossing", err?.name === "AbortError");
}
{
  let settle!: (v: unknown) => void;
  const hanging = fetchAdapter({ exec: () => new Promise((r) => (settle = r)), fetchImpl: (async () => new Response("host")) as typeof fetch });
  const ctl = new AbortController();
  const p = hanging("/api/slow", { headers: JSON_HDRS, signal: ctl.signal });
  ctl.abort();
  const err = await p.then(() => null, (e: Error) => e);
  check("abort races the crossing: immediate AbortError, the late reply is discarded", err?.name === "AbortError");
  settle({ status: 200, body: {} });                                 // the crossing settles after — no unhandled rejection
}

// ---- SSR / twin bundles -------------------------------------------------------------
{
  const w = (globalThis as { window?: unknown }).window;
  delete (globalThis as { window?: unknown }).window;
  const before = fell.length;
  await tfetch("/api/items", { headers: JSON_HDRS });
  check("no window → host fetch (SSR and twin bundles keep their local fetch)", fell.length === before + 1);
  (globalThis as { window?: unknown }).window = w;
}

const { pass, fail } = counts();
console.log(fail === 0
  ? `OK — the fetch adapter's crossability policy is framework-owned: JSON negotiation crosses, FormData/non-JSON/external/pins/Request-inputs/SSR stay stock, overrides and abort semantics hold, envelopes rebuild faithfully (${pass} checks)`
  : `FAIL (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

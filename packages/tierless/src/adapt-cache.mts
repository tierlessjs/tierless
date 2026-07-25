// Conditional crossings — HTTP caching semantics for session GETs.
//
// A browser pays for a large ETag'd GET once per context: later page loads send
// If-None-Match and get a 0-byte 304. An exec crossing paid full price every time —
// on n8n that one gap was the whole byte regression (a 12.4 MB node-types payload
// re-crossed per page session; ports/n8n/README.md byte anatomy). This wrap restores
// stock semantics on the socket:
//
//   - api.get with a cached {etag, envelope} for its path attaches If-None-Match;
//   - a 304 reply replays the cached envelope (the server validated it this instant —
//     never a staleness heuristic, every use revalidates);
//   - a 200 reply whose envelope carries an etag is cached for next time.
//
// The COST DISCIPLINE is load-bearing (measured on n8n, whose canvas boot already
// runs 2-5x contended): a cold GET must add NO async work — an awaited
// caches.open/match per crossing queues behind the render storm and flipped that
// suite's marginal waits. So validator lookups are SYNCHRONOUS against a small
// path->etag index (one localStorage getItem at construction — an ASYNC hydration
// loses the race to a contended page's first crossings), and the body read for a hit
// runs CONCURRENT with the crossing (its latency hides under the RTT).
//
// The WRITE is synchronous — awaited before the crossing resolves — because its reader
// is the next page load, a realm that cannot wait on anything this one is still doing.
// It is affordable because it no longer serializes: the body arrives as text (the frame
// carries it in the binary slot) and is stored as those same bytes. An earlier version
// deferred the write to idle to dodge a re-serialization cost that no longer exists,
// and lost the race on every fast navigation — measured on n8n as three concurrent cold
// re-fetches of the same 12.4 MB payload, ~50 s of backend stall in one spec.
import { RAW_TEXT } from "./transport.mjs";
import type { Exec, ResourceRequest } from "./types.mjs";

export interface EnvelopeStore {
  /** The path->etag index, SYNCHRONOUS — read once at construction, mutated by set().
   *  Sync is load-bearing: an async hydration loses the race to a contended page's
   *  first crossings, which is exactly where the cache matters most. */
  index(): Map<string, string>;
  /** The stored envelope for a path (undefined = evicted/never stored). */
  body(path: string): Promise<unknown>;
  /** Persist an envelope + its etag, and fold the pair into the index. `bodyText`, when
   *  given, is the body's ORIGINAL JSON text (transport.mts RAW_TEXT) — store it as-is
   *  instead of re-serializing the parsed body. */
  set(path: string, etag: string, envelope: unknown, bodyText?: string): Promise<void>;
}

export const memoryStore = (): EnvelopeStore => {
  const idx = new Map<string, string>();
  const bodies = new Map<string, unknown>();
  return {
    index: () => idx,
    body: async (p) => bodies.get(p),
    set: async (p, etag, env) => { bodies.set(p, env); idx.set(p, etag); },
  };
};

// The split that keeps crossings synchronous: the INDEX (paths + etags, ~KBs) lives in
// localStorage — read in one sync getItem at construction, no hydration race — while
// BODIES (envelopes, MBs) live in CacheStorage under a synthetic authority (the
// entries are envelopes, not fetchable URLs; quota is browser-managed). Concurrent
// tabs last-write-win the index; any drift — an indexed path whose body was evicted,
// or an index surviving a cleared cache — surfaces as a missing body on a 304 and
// falls back to one unconditional crossing.
export const cacheStorageStore = (cacheName = "tierless-envelopes"): EnvelopeStore => {
  const key = (p: string): string => "https://tierless.invalid" + (p.startsWith("/") ? p : "/" + p);
  const LS_KEY = "tierlessEnvelopeIndex";
  const idx = new Map<string, string>();
  try { for (const [p, e] of Object.entries(JSON.parse(localStorage.getItem(LS_KEY) || "{}") as Record<string, string>)) idx.set(p, e); }
  catch { /* no index yet, or storage denied: stay cold */ }
  return {
    index: () => idx,
    async body(p) {
      try {
        const hit = await (await caches.open(cacheName)).match(key(p));
        return hit ? await hit.json() : undefined;
      } catch { return undefined; }
    },
    async set(p, etag, env, bodyText) {
      // Build the stored JSON by CONCATENATION when we have the body's original text: a
      // memcpy instead of a full re-serialization of a body the edge was just handed as
      // bytes. That is what makes this write cheap enough to do immediately (below).
      const e = env as { status?: number; headers?: Record<string, string> };
      const json = bodyText !== undefined
        ? '{"status":' + JSON.stringify(e.status ?? 200) + ',"headers":' + JSON.stringify(e.headers ?? {}) + ',"body":' + bodyText + "}"
        : JSON.stringify(env);
      // no catch here: the caller logs-and-swallows, so a quota/serialization failure
      // is at least VISIBLE to the debug log instead of silently costing full price
      await (await caches.open(cacheName)).put(key(p), new Response(json, { headers: { "content-type": "application/json" } }));
      idx.set(p, etag);
      localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(idx)));   // body FIRST: an index entry must never precede its body
    },
  };
};

// The cache's own trace, next to __tierlessExecLog and under the same debug gate: a
// store that silently never happens (starved idle callback, quota, a navigation) is
// indistinguishable from a working cold cache without it.
const dbg = (ev: string, path: string): void => {
  const g = globalThis as { __TIERLESS_EXEC_LOG__?: unknown; __tierlessCacheLog?: Array<{ t: number; ev: string; path: string }> };
  if (!g.__TIERLESS_EXEC_LOG__) return;
  (g.__tierlessCacheLog ||= []).push({ t: Date.now(), ev, path });
  if (g.__tierlessCacheLog.length > 200) g.__tierlessCacheLog.splice(0, 100);
};

export function conditionalCrossings({ store }: { store?: EnvelopeStore } = {}): { wrap(inner: Exec): Exec } {
  const s = store ?? (typeof caches === "undefined" || typeof localStorage === "undefined" ? memoryStore() : cacheStorageStore());
  const etags = s.index();                                    // sync — no crossing ever waits on hydration
  // READ-YOUR-WRITES, across page loads. The reader of this cache is the NEXT page in
  // the same context — a different JS realm, so there is no pending write to coordinate
  // with and no version token to wait on: the write must simply have landed. It is
  // therefore awaited before the crossing resolves. That is affordable only because the
  // write no longer serializes the body (see set()'s bodyText path); the earlier
  // deferred-to-idle version existed to dodge that cost and lost the race on every fast
  // navigation, so each page re-fetched the same megabytes.
  const persist = async (when: string, path: string, etag: string, env: unknown, bodyText?: string): Promise<void> => {
    dbg("store:" + when, path);
    try { await s.set(path, etag, env, bodyText); dbg("ok", path); }
    catch (e) { dbg("fail:" + String(e).slice(0, 80), path); }   // over quota etc: next use pays full price, correctness unchanged
  };
  return {
    wrap: (inner) => async (req) => {
      const r = req as ResourceRequest;
      const path = r.name === "api.get" ? String((r.args ?? [])[0] ?? "") : "";
      const etag = r.name === "api.get" ? etags.get(path) : undefined;   // SYNC: a cold GET adds no work
      if (!etag) {
        const env = await inner(req) as { status?: number; headers?: Record<string, string> } | null;
        const fresh = r.name === "api.get" ? env?.headers?.etag : undefined;
        if (env?.status === 200 && fresh) await persist("cold", path, fresh, env, (env as Record<symbol, unknown>)[RAW_TEXT] as string | undefined);
        return env;
      }
      const bodyRead = s.body(path).catch(() => undefined);   // CONCURRENT with the crossing — hides under the RTT
      const [p0, p1, opts] = (r.args ?? []) as [unknown, unknown, { headers?: Record<string, string> }?];
      const env = await inner({ ...r, args: [p0, p1, { ...(opts ?? {}), headers: { ...(opts?.headers ?? {}), "if-none-match": etag } }] }) as { status?: number; headers?: Record<string, string> } | null;
      if (env?.status !== 304) {
        const fresh = env?.headers?.etag;
        if (env?.status === 200 && fresh && fresh !== etag) await persist("changed", path, fresh, env, (env as Record<symbol, unknown>)[RAW_TEXT] as string | undefined);
        return env;
      }
      const cached = await bodyRead;
      if (cached !== undefined) return cached;                // validated THIS crossing — replay
      etags.delete(path);                                    // index drift (evicted body): full price once, and stop attaching
      return inner(req);
    },
  };
}

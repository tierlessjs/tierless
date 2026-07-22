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
// loses the race to a contended page's first crossings), the body read for a hit
// runs CONCURRENT with the crossing (its latency hides under the RTT), and stores
// happen at idle with a tight cap (past the boot storm, inside a page's lifetime —
// a store that fires after navigation never happens at all).
import type { Exec, ResourceRequest } from "./types.mjs";

export interface EnvelopeStore {
  /** The path->etag index, SYNCHRONOUS — read once at construction, mutated by set().
   *  Sync is load-bearing: an async hydration loses the race to a contended page's
   *  first crossings, which is exactly where the cache matters most. */
  index(): Map<string, string>;
  /** The stored envelope for a path (undefined = evicted/never stored). */
  body(path: string): Promise<unknown>;
  /** Persist an envelope + its etag, and fold the pair into the index. */
  set(path: string, etag: string, envelope: unknown): Promise<void>;
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
    async set(p, etag, env) {
      try {
        await (await caches.open(cacheName)).put(key(p), new Response(JSON.stringify(env), { headers: { "content-type": "application/json" } }));
        idx.set(p, etag);
        localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(idx)));   // body FIRST: an index entry must never precede its body
      } catch { /* over quota: next use pays full price, correctness unchanged */ }
    },
  };
};

export function conditionalCrossings({ store }: { store?: EnvelopeStore } = {}): { wrap(inner: Exec): Exec } {
  const s = store ?? (typeof caches === "undefined" || typeof localStorage === "undefined" ? memoryStore() : cacheStorageStore());
  const etags = s.index();                                    // sync — no crossing ever waits on hydration
  const idle = (typeof requestIdleCallback === "function"
    ? (fn: () => void) => requestIdleCallback(fn, { timeout: 2_500 })
    : (fn: () => void) => setTimeout(fn, 0));                 // no render loop to yield to off-browser
  return {
    wrap: (inner) => async (req) => {
      const r = req as ResourceRequest;
      const path = r.name === "api.get" ? String((r.args ?? [])[0] ?? "") : "";
      const etag = r.name === "api.get" ? etags.get(path) : undefined;   // SYNC: a cold GET adds no work
      if (!etag) {
        const env = await inner(req) as { status?: number; headers?: Record<string, string> } | null;
        const fresh = r.name === "api.get" ? env?.headers?.etag : undefined;
        if (env?.status === 200 && fresh) idle(() => void s.set(path, fresh, env));
        return env;
      }
      const bodyRead = s.body(path).catch(() => undefined);   // CONCURRENT with the crossing — hides under the RTT
      const [p0, p1, opts] = (r.args ?? []) as [unknown, unknown, { headers?: Record<string, string> }?];
      const env = await inner({ ...r, args: [p0, p1, { ...(opts ?? {}), headers: { ...(opts?.headers ?? {}), "if-none-match": etag } }] }) as { status?: number; headers?: Record<string, string> } | null;
      if (env?.status !== 304) {
        const fresh = env?.headers?.etag;
        if (env?.status === 200 && fresh && fresh !== etag) idle(() => void s.set(path, fresh, env));
        return env;
      }
      const cached = await bodyRead;
      if (cached !== undefined) return cached;                // validated THIS crossing — replay
      etags.delete(path);                                    // index drift (evicted body): full price once, and stop attaching
      return inner(req);
    },
  };
}

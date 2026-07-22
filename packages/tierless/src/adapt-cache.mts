// Conditional crossings — HTTP caching semantics for session GETs.
//
// A browser pays for a large ETag'd GET once per context: later page loads send
// If-None-Match and get a 0-byte 304. An exec crossing paid full price every time —
// on n8n that one gap was the whole byte regression (a 12.4 MB node-types payload
// re-crossed per page session; ports/n8n/README.md byte anatomy). This wrap restores
// stock semantics on the socket, nothing more:
//
//   - api.get with a cached {etag, envelope} for its path attaches If-None-Match;
//   - a 304 reply replays the cached envelope (the server validated it this instant —
//     never a staleness heuristic, every use revalidates);
//   - a 200 reply whose envelope carries an etag is cached for next time.
//
// Storage: CacheStorage when the page has it — it spans page loads within a browser
// context, which is exactly the lifetime of the browser's own HTTP cache in a test
// context, and the quota is browser-managed. Otherwise (SSR, workers without caches,
// plain Node) an in-page Map — same semantics, page lifetime only.
import type { Exec, ResourceRequest } from "./types.mjs";

interface Entry { etag: string; envelope: unknown }
export interface EnvelopeStore {
  get(path: string): Promise<Entry | undefined>;
  set(path: string, entry: Entry): Promise<void>;
}

export const memoryStore = (): EnvelopeStore => {
  const m = new Map<string, Entry>();
  return { get: async (p) => m.get(p), set: async (p, e) => { m.set(p, e); } };
};

// CacheStorage holds Response objects keyed by Request URL; the entry is one JSON
// body with the etag denormalized into a header so get() can skip nothing. Keys use
// a synthetic authority — the entries are envelopes, not fetchable URLs, and this
// keeps them out of any real origin's path space.
export const cacheStorageStore = (cacheName = "tierless-envelopes"): EnvelopeStore => {
  const key = (p: string): string => "https://tierless.invalid" + (p.startsWith("/") ? p : "/" + p);
  return {
    async get(p) {
      try {
        const hit = await (await caches.open(cacheName)).match(key(p));
        if (!hit) return undefined;
        const etag = hit.headers.get("x-tierless-etag");
        return etag ? { etag, envelope: await hit.json() } : undefined;
      } catch { return undefined; }   // quota/eviction/opaque failures = cache miss
    },
    async set(p, e) {
      try {
        await (await caches.open(cacheName)).put(key(p), new Response(JSON.stringify(e.envelope), { headers: { "x-tierless-etag": e.etag, "content-type": "application/json" } }));
      } catch { /* over quota: next use pays full price, correctness unchanged */ }
    },
  };
};

export function conditionalCrossings({ store }: { store?: EnvelopeStore } = {}): { wrap(inner: Exec): Exec } {
  const s = store ?? (typeof caches === "undefined" ? memoryStore() : cacheStorageStore());
  return {
    wrap: (inner) => async (req) => {
      const r = req as ResourceRequest;
      if (r.name !== "api.get") return inner(req);
      const path = String((r.args ?? [])[0] ?? "");
      const hit = await s.get(path);
      const [p0, p1, opts] = (r.args ?? []) as [unknown, unknown, { headers?: Record<string, string> }?];
      const sent = hit
        ? { ...r, args: [p0, p1, { ...(opts ?? {}), headers: { ...(opts?.headers ?? {}), "if-none-match": hit.etag } }] }
        : r;
      const env = await inner(sent) as { status?: number; headers?: Record<string, string> } | null;
      if (env?.status === 304 && hit) return hit.envelope;   // validated THIS crossing — replay
      const etag = env?.headers?.etag;
      // store at IDLE, not on the reply path: serializing a large envelope on the main
      // thread inside a page's boot window is exactly the contention that costs n8n
      // ~1.1 s/session (ports/n8n/README.md wall section) — the cache must never add
      // to it. The cap is TIGHT (2.5 s: past the 1-2 s boot storm, well inside a page's
      // life): a busy canvas starves requestIdleCallback for its whole lifetime, and a
      // store that fires after the user navigated is a store that never happens — the
      // n8n suite's page-to-page moves outran a 10 s cap and the cache never warmed.
      if (env?.status === 200 && etag) {
        const idle = (typeof requestIdleCallback === "function"
          ? (fn: () => void) => requestIdleCallback(fn, { timeout: 2_500 })
          : (fn: () => void) => setTimeout(fn, 0));   // no render loop to yield to off-browser
        idle(() => void s.set(path, { etag, envelope: env }));
      }
      return env;
    },
  };
}

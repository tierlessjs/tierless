export const memoryStore = () => {
    const m = new Map();
    return { get: async (p) => m.get(p), set: async (p, e) => { m.set(p, e); } };
};
// CacheStorage holds Response objects keyed by Request URL; the entry is one JSON
// body with the etag denormalized into a header so get() can skip nothing. Keys use
// a synthetic authority — the entries are envelopes, not fetchable URLs, and this
// keeps them out of any real origin's path space.
export const cacheStorageStore = (cacheName = "tierless-envelopes") => {
    const key = (p) => "https://tierless.invalid" + (p.startsWith("/") ? p : "/" + p);
    return {
        async get(p) {
            try {
                const hit = await (await caches.open(cacheName)).match(key(p));
                if (!hit)
                    return undefined;
                const etag = hit.headers.get("x-tierless-etag");
                return etag ? { etag, envelope: await hit.json() } : undefined;
            }
            catch {
                return undefined;
            } // quota/eviction/opaque failures = cache miss
        },
        async set(p, e) {
            try {
                await (await caches.open(cacheName)).put(key(p), new Response(JSON.stringify(e.envelope), { headers: { "x-tierless-etag": e.etag, "content-type": "application/json" } }));
            }
            catch { /* over quota: next use pays full price, correctness unchanged */ }
        },
    };
};
export function conditionalCrossings({ store } = {}) {
    const s = store ?? (typeof caches === "undefined" ? memoryStore() : cacheStorageStore());
    return {
        wrap: (inner) => async (req) => {
            const r = req;
            if (r.name !== "api.get")
                return inner(req);
            const path = String((r.args ?? [])[0] ?? "");
            const hit = await s.get(path);
            const [p0, p1, opts] = (r.args ?? []);
            const sent = hit
                ? { ...r, args: [p0, p1, { ...(opts ?? {}), headers: { ...(opts?.headers ?? {}), "if-none-match": hit.etag } }] }
                : r;
            const env = await inner(sent);
            if (env?.status === 304 && hit)
                return hit.envelope; // validated THIS crossing — replay
            const etag = env?.headers?.etag;
            // store at IDLE, not on the reply path: serializing a large envelope on the main
            // thread inside a page's boot window is exactly the contention that costs n8n
            // ~1.1 s/session (ports/n8n/README.md wall section) — the cache must never add
            // to it. A page that navigates away before idle just pays full price next time.
            if (env?.status === 200 && etag) {
                const idle = (typeof requestIdleCallback === "function"
                    ? (fn) => requestIdleCallback(fn, { timeout: 10_000 })
                    : (fn) => setTimeout(fn, 0)); // no render loop to yield to off-browser
                idle(() => void s.set(path, { etag, envelope: env }));
            }
            return env;
        },
    };
}

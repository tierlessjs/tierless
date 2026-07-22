export const memoryStore = () => {
    const idx = new Map();
    const bodies = new Map();
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
export const cacheStorageStore = (cacheName = "tierless-envelopes") => {
    const key = (p) => "https://tierless.invalid" + (p.startsWith("/") ? p : "/" + p);
    const LS_KEY = "tierlessEnvelopeIndex";
    const idx = new Map();
    try {
        for (const [p, e] of Object.entries(JSON.parse(localStorage.getItem(LS_KEY) || "{}")))
            idx.set(p, e);
    }
    catch { /* no index yet, or storage denied: stay cold */ }
    return {
        index: () => idx,
        async body(p) {
            try {
                const hit = await (await caches.open(cacheName)).match(key(p));
                return hit ? await hit.json() : undefined;
            }
            catch {
                return undefined;
            }
        },
        async set(p, etag, env) {
            try {
                await (await caches.open(cacheName)).put(key(p), new Response(JSON.stringify(env), { headers: { "content-type": "application/json" } }));
                idx.set(p, etag);
                localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(idx))); // body FIRST: an index entry must never precede its body
            }
            catch { /* over quota: next use pays full price, correctness unchanged */ }
        },
    };
};
export function conditionalCrossings({ store } = {}) {
    const s = store ?? (typeof caches === "undefined" || typeof localStorage === "undefined" ? memoryStore() : cacheStorageStore());
    const etags = s.index(); // sync — no crossing ever waits on hydration
    const idle = (typeof requestIdleCallback === "function"
        ? (fn) => requestIdleCallback(fn, { timeout: 2_500 })
        : (fn) => setTimeout(fn, 0)); // no render loop to yield to off-browser
    return {
        wrap: (inner) => async (req) => {
            const r = req;
            const path = r.name === "api.get" ? String((r.args ?? [])[0] ?? "") : "";
            const etag = r.name === "api.get" ? etags.get(path) : undefined; // SYNC: a cold GET adds no work
            if (!etag) {
                const env = await inner(req);
                const fresh = r.name === "api.get" ? env?.headers?.etag : undefined;
                if (env?.status === 200 && fresh)
                    idle(() => void s.set(path, fresh, env));
                return env;
            }
            const bodyRead = s.body(path).catch(() => undefined); // CONCURRENT with the crossing — hides under the RTT
            const [p0, p1, opts] = (r.args ?? []);
            const env = await inner({ ...r, args: [p0, p1, { ...(opts ?? {}), headers: { ...(opts?.headers ?? {}), "if-none-match": etag } }] });
            if (env?.status !== 304) {
                const fresh = env?.headers?.etag;
                if (env?.status === 200 && fresh && fresh !== etag)
                    idle(() => void s.set(path, fresh, env));
                return env;
            }
            const cached = await bodyRead;
            if (cached !== undefined)
                return cached; // validated THIS crossing — replay
            etags.delete(path); // index drift (evicted body): full price once, and stop attaching
            return inner(req);
        },
    };
}

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
// TWO INVARIANTS govern this file, both learned the expensive way:
//
// 1. STORAGE IS ADVISORY, NEVER LOAD-BEARING: no crossing ever AWAITS a write. An
//    awaited write puts browser storage on the request path, and a write that never
//    SETTLES is not an error — no catch sees it, the crossing hangs, and the app hangs
//    with it: a deadlock no application code can defend against (an earlier version
//    shipped exactly that). Writes start EAGERLY at reply time and settle on their own.
//    Eager, because the one measured failure of deferral was requestIdleCallback
//    starving under a render storm for the page's whole life (n8n: every fast
//    navigation lost the race — three concurrent cold re-fetches of the same 12.4 MB
//    payload, ~50 s of backend stall in one spec). Advisory is SAFE because of
//    ORDERING: the body lands first and the index (synchronous localStorage) is written
//    only after it, so a page dying mid-write leaves the old index pointing at the old,
//    still-present body — every lost race is a clean miss, never a hole.
//
// 2. A READ MAY WAIT ONLY WHERE A FALLBACK EXISTS, AND ONLY BRIEFLY. A 304 reply needs
//    the cached body; if the store never answers, the only exit is one unconditional
//    refetch. So the body read races a deadline whose loser is that refetch — the price
//    of a miss, never a hang. This deadline is semantically REQUIRED (the crossing
//    cannot complete without either the body or the refetch decision); the write path
//    needs none, because nothing downstream ever depends on a write.
//
// Cross-page READ-YOUR-WRITES — what the removed await was for — rides a Web-Locks
// FENCE instead: while writes are in flight this page holds "tierless-envelopes"; the
// next page queues a no-op acquisition behind it and re-reads the index when it clears.
// Locks release on realm death, so a dying writer can never strand a reader. Crossings
// still never wait on the fence: one that fires before it clears sees the older index
// and at worst revalidates an older etag — one 200 instead of a 304.
//
// The read-side COST DISCIPLINE is unchanged and load-bearing (measured on n8n, whose
// canvas boot runs 2-5x contended): a cold GET adds NO async work — validator lookups
// are SYNCHRONOUS against a small path->etag index (one localStorage getItem at
// construction), and the body read for a hit runs CONCURRENT with the crossing (its
// latency hides under the RTT).
import { RAW_TEXT } from "./transport.mjs";
/** How long a 304 waits for its cached body before falling back to one unconditional
 *  refetch. Healthy CacheStorage matches run in single-digit ms and the read has already
 *  had the crossing's whole RTT to finish; a store that misses this window costs a
 *  cache miss, not a hang. (The WRITE path has no such budget — it has no await.) */
const READ_BUDGET_MS = 1000;
/** The write fence (Web Locks). Held while envelope writes are in flight; the next page
 *  queues its index refresh behind it. */
const LOCK = "tierless-envelopes";
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
    const load = () => {
        try {
            for (const [p, e] of Object.entries(JSON.parse(localStorage.getItem(LS_KEY) || "{}")))
                idx.set(p, e);
        }
        catch { /* no index yet, or storage denied: stay cold */ }
    };
    load();
    return {
        index: () => idx,
        refresh: load,
        async body(p) {
            try {
                const hit = await (await caches.open(cacheName)).match(key(p));
                return hit ? await hit.json() : undefined;
            }
            catch {
                return undefined;
            }
        },
        async set(p, etag, env, bodyText) {
            // Build the stored JSON by CONCATENATION when we have the body's original text: a
            // memcpy instead of a full re-serialization of a body the edge was just handed as
            // bytes.
            const e = env;
            const json = bodyText !== undefined
                ? '{"status":' + JSON.stringify(e.status ?? 200) + ',"headers":' + JSON.stringify(e.headers ?? {}) + ',"body":' + bodyText + "}"
                : JSON.stringify(env);
            // no catch here: the caller logs-and-swallows, so a quota/serialization failure
            // is at least VISIBLE to the debug log instead of silently costing full price
            await (await caches.open(cacheName)).put(key(p), new Response(json, { headers: { "content-type": "application/json" } }));
            idx.set(p, etag);
            localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(idx))); // body FIRST: an index entry must never precede its body
        },
    };
};
// The cache's own trace, next to __tierlessExecLog and under the same debug gate: a
// store that silently never happens (an abandoned write, quota, a navigation) is
// indistinguishable from a working cold cache without it.
const dbg = (ev, path) => {
    const g = globalThis;
    if (!g.__TIERLESS_EXEC_LOG__)
        return;
    (g.__tierlessCacheLog ||= []).push({ t: Date.now(), ev, path });
    if (g.__tierlessCacheLog.length > 200)
        g.__tierlessCacheLog.splice(0, 100);
};
// OBSERVABILITY MUST SHOW BROWSER-CACHE SEMANTICS. A page never sees a revalidating
// 304 — stock fetch() reports a transparent 200 with the cached body. The exec log
// (browser.mts record(), the contract tierless/playwright's transport-agnostic waits
// read) records at the wire layer BELOW this wrap, so a replayed revalidation lands
// there as {status: 304, reqHeaders: {"if-none-match": …}} — a status the app never saw
// carrying a header the app never sent. A stock-shaped harness predicate
// (`resp.status() === 200`, nocodb's whole wait vocabulary) then never matches, and the
// wait times out on the ported arm only — 32 tests' worth, measured. So the replay
// branch rewrites its own wire entry into the envelope the app actually received: the
// wrap already presents the replay as a 200 to the APP, and the log is just the same
// presentation for the HARNESS. (The drift path — 304 with an evicted body — leaves its
// stray 304 entry in place: the refetch logs its own 200, which is what waits match.)
const presentReplay = (path, env, appReqHeaders) => {
    const g = globalThis;
    if (!g.__TIERLESS_EXEC_LOG__ || !g.__tierlessExecLog)
        return;
    const log = g.__tierlessExecLog;
    for (let i = log.length - 1; i >= 0 && i >= log.length - 8; i--) { // its own inner call pushed the 304 moments ago
        const e = log[i];
        if (e.url !== path || e.status !== 304)
            continue;
        const v = env;
        e.status = v?.status;
        e.body = v?.body;
        if (v?.headers)
            e.headers = v.headers;
        if (appReqHeaders)
            e.reqHeaders = appReqHeaders;
        else
            delete e.reqHeaders; // the injected if-none-match was never the app's
        return;
    }
};
export function conditionalCrossings({ store, fence } = {}) {
    const s = store ?? (typeof caches === "undefined" || typeof localStorage === "undefined" ? memoryStore() : cacheStorageStore());
    const etags = s.index(); // sync — no crossing ever waits on hydration
    const f = fence ?? globalThis.navigator?.locks;
    // READER side of the fence: queue a no-op acquisition behind any in-flight writer and
    // re-read the index when it clears. Unawaited BY DESIGN — crossings that fire first
    // simply use the construction-time index (at worst one 200 instead of a 304).
    if (f && s.refresh) {
        try {
            void Promise.resolve(f.request(LOCK, () => { s.refresh(); dbg("fence:refresh", ""); })).catch(() => { });
        }
        catch { /* same */ }
    }
    // WRITER side: hold the lock while any write is in flight. The hold is what the next
    // page's refresh queues behind; realm death releases it, so a wedged store degrades
    // the FENCE (readers use their construction-time index) and never execution.
    let pendingWrites = 0;
    let releaseHold = null;
    const writeStarted = () => {
        if (++pendingWrites > 1 || !f)
            return;
        try {
            void Promise.resolve(f.request(LOCK, () => new Promise((r) => {
                if (pendingWrites === 0)
                    r();
                else
                    releaseHold = r; // drained before the grant arrived: release immediately
            }))).catch(() => { });
        }
        catch { /* no fence */ }
    };
    const writeEnded = () => {
        if (--pendingWrites === 0 && releaseHold) {
            releaseHold();
            releaseHold = null;
        }
    };
    // THE WRITE IS NOT AWAITED, ANYWHERE. Returns void so no caller can reintroduce the
    // coupling without changing this signature — the invariant is the shape of the code.
    const persist = (when, path, etag, env, bodyText) => {
        dbg("store:" + when, path);
        writeStarted();
        void s.set(path, etag, env, bodyText)
            .then(() => dbg("ok", path), (e) => dbg("fail:" + String(e).slice(0, 80), path)) // over quota etc: next use pays full price
            .finally(writeEnded);
    };
    const READ_MISS = Symbol("tierless-read-miss");
    return {
        wrap: (inner) => async (req) => {
            const r = req;
            const path = r.name === "api.get" ? String((r.args ?? [])[0] ?? "") : "";
            const etag = r.name === "api.get" ? etags.get(path) : undefined; // SYNC: a cold GET adds no work
            if (!etag) {
                const env = await inner(req);
                const fresh = r.name === "api.get" ? env?.headers?.etag : undefined;
                if (env?.status === 200 && fresh)
                    persist("cold", path, fresh, env, env[RAW_TEXT]);
                return env;
            }
            const bodyRead = s.body(path).catch(() => undefined); // CONCURRENT with the crossing — hides under the RTT
            const [p0, p1, opts] = (r.args ?? []);
            const env = await inner({ ...r, args: [p0, p1, { ...(opts ?? {}), headers: { ...(opts?.headers ?? {}), "if-none-match": etag } }] });
            if (env?.status !== 304) {
                const fresh = env?.headers?.etag;
                if (env?.status === 200 && fresh && fresh !== etag)
                    persist("changed", path, fresh, env, env[RAW_TEXT]);
                return env;
            }
            // 304: the body read must answer or lose to the refetch deadline (invariant 2)
            let timer;
            const cached = await Promise.race([
                bodyRead,
                new Promise((res) => { timer = setTimeout(() => res(READ_MISS), READ_BUDGET_MS); }),
            ]);
            clearTimeout(timer);
            if (cached !== undefined && cached !== READ_MISS) { // validated THIS crossing — replay
                presentReplay(path, cached, opts?.headers);
                return cached;
            }
            if (cached === READ_MISS)
                dbg("read-timeout", path);
            etags.delete(path); // drift (evicted/wedged body): full price once, and stop attaching
            return inner(req);
        },
    };
}

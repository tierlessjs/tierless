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
import { RAW_TEXT, SKIP_EXEC_LOG, pushExecLog } from "./transport.mjs";
/** How long a 304 waits for its cached body before falling back to one unconditional
 *  refetch. Healthy CacheStorage matches run in single-digit ms and the read has already
 *  had the crossing's whole RTT to finish; a store that misses this window costs a
 *  cache miss, not a hang. (The WRITE path has no such budget — it has no await.) */
const READ_BUDGET_MS = 1000;
/** How many bytes of FRESH envelopes one page may hold in memory. A page cannot grow
 *  this without bound; the least-recently-used entry goes first. Sized to hold a few
 *  static catalogues (InvenTree's icon pack is 643 KB) and nothing like a data plane. */
const MEM_BUDGET_BYTES = 8_000_000;
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
// 304 — stock fetch() reports a transparent 200 with the cached body — and the exec log
// is the harness-waits contract (tierless/playwright), so it must show what the app saw.
// The wire layer (browser.mts) logs BELOW this wrap; left alone, a replayed revalidation
// lands there as {status: 304, reqHeaders: {"if-none-match": …}} — a status the app never
// saw carrying a header the app never sent — and a stock-shaped predicate
// (`resp.status() === 200`, nocodb's whole wait vocabulary) never matches: 32 tests'
// worth of timed-out waits, measured, on the ported arm only.
//
// The wrong entry must never be PUSHED, not fixed up after: harness waits consume
// entries exactly once (firstCrossing advances a cursor on the push's own wake-up), so a
// rewrite always loses the race — a first cut shipped exactly that and reproduced the 32
// failures with the "fix" in place. So the conditional wire request is marked
// SKIP_EXEC_LOG (the wire layer stays silent) and THIS wrap logs the one app-visible
// entry: the envelope it returned, against the app's own request. The drift path
// (evicted body) refetches with the UNMARKED original request, which logs itself.
// ---------------------------------------------------------------- freshness ----------
// The OTHER half of browser cache semantics, and the half revalidation cannot supply: a
// response the server declared fresh is reused WITHOUT contacting it (RFC 9111 §4.2).
// This is not a staleness heuristic — max-age is the origin's own explicit instruction,
// and honoring it is exactly what fetch() does. Without it the transport is WORSE than
// the HTTP it replaces: InvenTree's /api/icons/ is `public, max-age=86400` with no ETag,
// so revalidation never engaged and the port re-crossed 643 KB 401 times where the stock
// browser fetched it 164 (once per test, every within-test repeat served from memory).
//
// Deliberately PER-PAGE AND IN MEMORY, not persistent. Two reasons, both load-bearing:
//   - it is where the entire measured penalty lives (the baseline's 1-per-test says the
//     browser's own memory cache absorbed the repeats; we had nothing);
//   - a persistent freshness entry would have to survive a change of login, and the
//     identity that governs that is the cookie jar — which is httpOnly and invisible
//     here. Within one page there is no such hazard. Cross-page freshness is a further
//     win and needs that question answered first.
// A hit is SYNCHRONOUS, so it costs strictly less than the cold path it replaces.
const CC_NO_STORE = /(?:^|,)\s*no-(?:store|cache)\s*(?:,|$)/;
const CC_MAX_AGE = /(?:^|,)\s*max-age\s*=\s*(\d+)/;
/** Milliseconds this response may be reused without asking, per its own headers.
 *  0 = not freshly cacheable (no directive, no-store/no-cache, or already expired). */
const freshLifetime = (headers) => {
    const cc = (headers?.["cache-control"] ?? "").toLowerCase();
    if (CC_NO_STORE.test(cc))
        return 0;
    const m = CC_MAX_AGE.exec(cc);
    if (m)
        return Number(m[1]) * 1000;
    if (cc)
        return 0; // a directive that says nothing about age: no freshness
    // Expires applies only in the absence of max-age, as HTTP specifies
    const exp = headers?.expires ? Date.parse(headers.expires) : Number.NaN;
    return Number.isNaN(exp) ? 0 : Math.max(0, exp - Date.now());
};
/** The request-side values of the headers a response's `Vary` names — what makes reuse
 *  safe. A cached entry serves a later request only if this string matches. `*` never
 *  matches (uncacheable by definition). `cookie` uses the readable jar: httpOnly
 *  cookies are invisible, which is why this cache does not outlive the page. */
const varyValues = (vary, reqHeaders) => {
    if (!vary)
        return "";
    const names = vary.toLowerCase().split(",").map((n) => n.trim()).filter(Boolean);
    if (names.includes("*"))
        return null;
    return names.map((n) => n + "=" + (n === "cookie"
        ? (typeof document === "undefined" ? "" : document.cookie)
        : (reqHeaders?.[n] ?? ""))).join(" ");
};
/** Charge an envelope against the memory budget. The raw JSON text is already at hand on
 *  the fetch arm (transport.mts RAW_TEXT) — free, and the number that matters. Anything
 *  else is measured once, on store, never on a hit. */
const envelopeBytes = (env) => {
    const raw = env[RAW_TEXT];
    if (typeof raw === "string")
        return raw.length;
    try {
        return JSON.stringify(env?.body ?? "").length;
    }
    catch {
        return MEM_BUDGET_BYTES + 1;
    } // unserializable: refuse to cache it
};
const presentAs = (req, env) => {
    const v = env;
    pushExecLog(req, v && typeof v.status === "number" ? v.status : undefined, v?.body, !!v && "body" in v, v?.headers);
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
    // this page's freshness cache (insertion order IS the LRU order — re-set on every hit)
    const memo = new Map();
    let memoBytes = 0;
    const memoDrop = (k) => { const e = memo.get(k); if (e) {
        memoBytes -= e.bytes;
        memo.delete(k);
    } };
    const memoPut = (path, env, headers, reqHeaders, bytes) => {
        const life = freshLifetime(headers);
        if (!life)
            return;
        const values = varyValues(headers?.vary, reqHeaders);
        if (values === null || bytes > MEM_BUDGET_BYTES)
            return;
        memoDrop(path);
        memo.set(path, { exp: Date.now() + life, env, vary: headers?.vary, values, bytes });
        memoBytes += bytes;
        for (const k of memo.keys()) {
            if (memoBytes <= MEM_BUDGET_BYTES)
                break;
            memoDrop(k);
            dbg("fresh:evict", k);
        }
        dbg("fresh:store", path);
    };
    const READ_MISS = Symbol("tierless-read-miss");
    return {
        wrap: (inner) => async (req) => {
            const r = req;
            const path = r.name === "api.get" ? String((r.args ?? [])[0] ?? "") : "";
            const reqHeaders = (r.args ?? [])[2]?.headers;
            // FRESHNESS FIRST, and synchronously: a live entry is reused with no crossing at
            // all, which is what the browser cache does for the same response.
            const hit = r.name === "api.get" ? memo.get(path) : undefined;
            if (hit) {
                if (hit.exp > Date.now() && hit.values === varyValues(hit.vary, reqHeaders)) {
                    memo.delete(path);
                    memo.set(path, hit); // LRU touch
                    dbg("fresh:hit", path);
                    presentAs(r, hit.env);
                    return hit.env;
                }
                memoDrop(path); // expired, or the vary-named headers moved
            }
            const etag = r.name === "api.get" ? etags.get(path) : undefined; // SYNC: a cold GET adds no work
            if (!etag) {
                const env = await inner(req);
                const fresh = r.name === "api.get" ? env?.headers?.etag : undefined;
                if (env?.status === 200 && fresh)
                    persist("cold", path, fresh, env, env[RAW_TEXT]);
                if (env?.status === 200 && r.name === "api.get")
                    memoPut(path, env, env.headers, reqHeaders, envelopeBytes(env));
                return env;
            }
            const bodyRead = s.body(path).catch(() => undefined); // CONCURRENT with the crossing — hides under the RTT
            const [p0, p1, opts] = (r.args ?? []);
            // the WIRE request: carries the validator, and is marked so the wire layer does
            // not log it — whatever this branch RETURNS is logged below as the app's crossing
            const env = await inner({ ...r, [SKIP_EXEC_LOG]: true, args: [p0, p1, { ...(opts ?? {}), headers: { ...(opts?.headers ?? {}), "if-none-match": etag } }] });
            if (env?.status !== 304) {
                const fresh = env?.headers?.etag;
                if (env?.status === 200 && fresh && fresh !== etag)
                    persist("changed", path, fresh, env, env[RAW_TEXT]);
                if (env?.status === 200)
                    memoPut(path, env, env.headers, reqHeaders, envelopeBytes(env));
                presentAs(r, env);
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
                presentAs(r, cached);
                return cached;
            }
            if (cached === READ_MISS)
                dbg("read-timeout", path);
            etags.delete(path); // drift (evicted/wedged body): full price once, and stop attaching
            return inner(req); // UNMARKED: the refetch logs itself at the wire layer
        },
    };
}

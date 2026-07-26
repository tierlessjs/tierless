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
import type { Exec, ResourceRequest } from "./types.mjs";

/** How long a 304 waits for its cached body before falling back to one unconditional
 *  refetch. Healthy CacheStorage matches run in single-digit ms and the read has already
 *  had the crossing's whole RTT to finish; a store that misses this window costs a
 *  cache miss, not a hang. (The WRITE path has no such budget — it has no await.) */
const READ_BUDGET_MS = 1000;
/** The write fence (Web Locks). Held while envelope writes are in flight; the next page
 *  queues its index refresh behind it. */
const LOCK = "tierless-envelopes";

interface Fence { request(name: string, cb: () => void | Promise<void>): Promise<unknown> }

export interface EnvelopeStore {
  /** The path->etag index, SYNCHRONOUS — read once at construction, mutated by set().
   *  Sync is load-bearing: an async hydration loses the race to a contended page's
   *  first crossings, which is exactly where the cache matters most. */
  index(): Map<string, string>;
  /** The stored envelope for a path (undefined = evicted/never stored). */
  body(path: string): Promise<unknown>;
  /** Persist an envelope + its etag, and fold the pair into the index. MUST write the
   *  body before the index — that ordering is what makes an abandoned write a clean
   *  miss. `bodyText`, when given, is the body's ORIGINAL JSON text (transport.mts
   *  RAW_TEXT) — store it as-is instead of re-serializing the parsed body. */
  set(path: string, etag: string, envelope: unknown, bodyText?: string): Promise<void>;
  /** Re-read the durable index into the live Map (synchronously). Called when the
   *  previous page's write fence clears, so this page picks up writes that were still
   *  in flight when it constructed. Optional: a store without one just serves its
   *  construction-time index. */
  refresh?(): void;
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
  const load = (): void => {
    try { for (const [p, e] of Object.entries(JSON.parse(localStorage.getItem(LS_KEY) || "{}") as Record<string, string>)) idx.set(p, e); }
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
      } catch { return undefined; }
    },
    async set(p, etag, env, bodyText) {
      // Build the stored JSON by CONCATENATION when we have the body's original text: a
      // memcpy instead of a full re-serialization of a body the edge was just handed as
      // bytes.
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
// store that silently never happens (an abandoned write, quota, a navigation) is
// indistinguishable from a working cold cache without it.
const dbg = (ev: string, path: string): void => {
  const g = globalThis as { __TIERLESS_EXEC_LOG__?: unknown; __tierlessCacheLog?: Array<{ t: number; ev: string; path: string }> };
  if (!g.__TIERLESS_EXEC_LOG__) return;
  (g.__tierlessCacheLog ||= []).push({ t: Date.now(), ev, path });
  if (g.__tierlessCacheLog.length > 200) g.__tierlessCacheLog.splice(0, 100);
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
const presentAs = (req: ResourceRequest, env: unknown): void => {
  const v = env as { status?: number; body?: unknown; headers?: Record<string, string> } | null;
  pushExecLog(req, v && typeof v.status === "number" ? v.status : undefined, v?.body, !!v && "body" in (v as object), v?.headers);
};

export function conditionalCrossings({ store, fence }: { store?: EnvelopeStore; fence?: Fence } = {}): { wrap(inner: Exec): Exec } {
  const s = store ?? (typeof caches === "undefined" || typeof localStorage === "undefined" ? memoryStore() : cacheStorageStore());
  const etags = s.index();                                    // sync — no crossing ever waits on hydration
  const f = fence ?? (globalThis as { navigator?: { locks?: Fence } }).navigator?.locks;

  // READER side of the fence: queue a no-op acquisition behind any in-flight writer and
  // re-read the index when it clears. Unawaited BY DESIGN — crossings that fire first
  // simply use the construction-time index (at worst one 200 instead of a 304).
  if (f && s.refresh) {
    try { void Promise.resolve(f.request(LOCK, () => { s.refresh!(); dbg("fence:refresh", ""); })).catch(() => { /* no fence here: construction-time index stands */ }); }
    catch { /* same */ }
  }

  // WRITER side: hold the lock while any write is in flight. The hold is what the next
  // page's refresh queues behind; realm death releases it, so a wedged store degrades
  // the FENCE (readers use their construction-time index) and never execution.
  let pendingWrites = 0;
  let releaseHold: (() => void) | null = null;
  const writeStarted = (): void => {
    if (++pendingWrites > 1 || !f) return;
    try {
      void Promise.resolve(f.request(LOCK, () => new Promise<void>((r) => {
        if (pendingWrites === 0) r(); else releaseHold = r;   // drained before the grant arrived: release immediately
      }))).catch(() => { /* no fence */ });
    } catch { /* no fence */ }
  };
  const writeEnded = (): void => {
    if (--pendingWrites === 0 && releaseHold) { releaseHold(); releaseHold = null; }
  };

  // THE WRITE IS NOT AWAITED, ANYWHERE. Returns void so no caller can reintroduce the
  // coupling without changing this signature — the invariant is the shape of the code.
  const persist = (when: string, path: string, etag: string, env: unknown, bodyText?: string): void => {
    dbg("store:" + when, path);
    writeStarted();
    void s.set(path, etag, env, bodyText)
      .then(() => dbg("ok", path), (e: unknown) => dbg("fail:" + String(e).slice(0, 80), path))   // over quota etc: next use pays full price
      .finally(writeEnded);
  };

  const READ_MISS = Symbol("tierless-read-miss");
  return {
    wrap: (inner) => async (req) => {
      const r = req as ResourceRequest;
      const path = r.name === "api.get" ? String((r.args ?? [])[0] ?? "") : "";
      const etag = r.name === "api.get" ? etags.get(path) : undefined;   // SYNC: a cold GET adds no work
      if (!etag) {
        const env = await inner(req) as { status?: number; headers?: Record<string, string> } | null;
        const fresh = r.name === "api.get" ? env?.headers?.etag : undefined;
        if (env?.status === 200 && fresh) persist("cold", path, fresh, env, (env as Record<symbol, unknown>)[RAW_TEXT] as string | undefined);
        return env;
      }
      const bodyRead = s.body(path).catch(() => undefined);   // CONCURRENT with the crossing — hides under the RTT
      const [p0, p1, opts] = (r.args ?? []) as [unknown, unknown, { headers?: Record<string, string> }?];
      // the WIRE request: carries the validator, and is marked so the wire layer does
      // not log it — whatever this branch RETURNS is logged below as the app's crossing
      const env = await inner({ ...r, [SKIP_EXEC_LOG]: true, args: [p0, p1, { ...(opts ?? {}), headers: { ...(opts?.headers ?? {}), "if-none-match": etag } }] } as ResourceRequest) as { status?: number; headers?: Record<string, string> } | null;
      if (env?.status !== 304) {
        const fresh = env?.headers?.etag;
        if (env?.status === 200 && fresh && fresh !== etag) persist("changed", path, fresh, env, (env as Record<symbol, unknown>)[RAW_TEXT] as string | undefined);
        presentAs(r, env);
        return env;
      }
      // 304: the body read must answer or lose to the refetch deadline (invariant 2)
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cached = await Promise.race([
        bodyRead,
        new Promise<typeof READ_MISS>((res) => { timer = setTimeout(() => res(READ_MISS), READ_BUDGET_MS); }),
      ]);
      clearTimeout(timer);
      if (cached !== undefined && cached !== READ_MISS) {                // validated THIS crossing — replay
        presentAs(r, cached);
        return cached;
      }
      if (cached === READ_MISS) dbg("read-timeout", path);
      etags.delete(path);                                     // drift (evicted/wedged body): full price once, and stop attaching
      return inner(req);                                      // UNMARKED: the refetch logs itself at the wire layer
    },
  };
}

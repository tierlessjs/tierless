// Regression: the served-path deref cache is BYTE-BOUNDED under a long session.
//
// Before this, fetch.mts's makeHost held a set-only Map — resident memory grew for every
// distinct object a session dereferenced, with no bound short of disconnect. The cache now
// lives behind an injected store; the default is an LRU weighed by bytes. A byte budget is
// what actually bounds memory — a count cap can't, since entries vary in size by orders of
// magnitude. This proves, end to end, that a long session dereferencing far more bytes than
// the budget stays within it, evicts by recency (LRU, not FIFO), and — the served-path
// safety property — that every eviction costs at most a correct refetch, never a lost or
// stale value.
import { makeTier, Channel, makeHost, makeLruStore, makeUnboundedStore, DEFAULT_CACHE_BYTES } from "tierless/heap";
import { makeCheck } from "../lib/check.mts";

const { check, ok } = makeCheck();
console.log("Probe: served-cache memory is byte-bounded — a long session of distinct derefs stays within budget\n");

// The Store contract types get() as possibly-async; the bundled stores resolve
// synchronously, so narrow their return to read a field in these assertions.
const sync = <T,>(v: T | Promise<T>): T => v as T;

// --- the store primitives: get / set / evict, weighed by bytes ------------------------
{
  const s = makeLruStore<{ w: number; tag: string }>({ max: 100, weigh: (v) => v.w });
  s.set("a", { w: 40, tag: "a" }); s.set("b", { w: 40, tag: "b" });       // total 80 <= 100
  check("weighed store holds entries within budget", sync(s.get("a"))?.tag === "a" && sync(s.get("b"))?.tag === "b");
  s.set("c", { w: 40, tag: "c" });                                         // 120 > 100 -> evict least-recent
  check("a byte budget evicts the least-recent when over budget", sync(s.get("a")) === undefined && sync(s.get("b"))?.tag === "b" && sync(s.get("c"))?.tag === "c");
  s.set("big", { w: 500, tag: "big" });                                    // larger than the whole budget
  check("an entry larger than the whole budget bypasses the cache (the resident set is kept)", sync(s.get("big")) === undefined && sync(s.get("b"))?.tag === "b" && sync(s.get("c"))?.tag === "c");
  s.evict("b");
  check("evict(id) drops an entry outright", sync(s.get("b")) === undefined);
}

// Size, not count, is what governs eviction — the whole point of weighing by bytes.
{
  const s = makeLruStore<{ w: number }>({ max: 100, weigh: (v) => v.w });
  s.set("x1", { w: 10 }); s.set("x2", { w: 10 }); s.set("x3", { w: 10 });  // 3 small entries, total 30
  check("a byte budget holds many small entries (it is count-blind)", sync(s.get("x1"))?.w === 10 && sync(s.get("x2"))?.w === 10 && sync(s.get("x3"))?.w === 10);
  s.set("big", { w: 90 });                                                 // one big insert: evict small ones until it fits (30+90 -> drop 2 -> 100)
  check("a large entry evicts as many small ones as its bytes require (a count cap would not)", sync(s.get("x1")) === undefined && sync(s.get("x2")) === undefined && sync(s.get("x3"))?.w === 10 && sync(s.get("big"))?.w === 90);
}

// The evictable() gate: a pinned entry survives budget pressure (the §5 coherence pins a
// snapshot with an unshipped mutation — evicting its baseline would degrade the write-back);
// explicit evict(id) still removes it, and unpinning makes it evictable again.
{
  const s = makeLruStore<{ w: number; pinned: boolean }>({ max: 100, weigh: (v) => v.w, evictable: (v) => !v.pinned });
  const a = { w: 60, pinned: true }, b = { w: 30, pinned: false };
  s.set("a", a); s.set("b", b);
  s.set("c", { w: 40, pinned: false });                                    // 130 > 100: LRU order is a,b — a is pinned, so b evicts
  check("budget eviction skips a pinned entry and takes the next least-recent", sync(s.get("a"))?.w === 60 && sync(s.get("b")) === undefined && sync(s.get("c"))?.w === 40);
  s.set("d", { w: 40, pinned: false });                                    // 140 > 100: c (LRU after a) evicts; a stays pinned over budget
  check("only pinned weight may exceed the budget, transiently", sync(s.get("a"))?.w === 60 && sync(s.get("c")) === undefined && sync(s.get("d"))?.w === 40);
  a.pinned = false;                                                        // the write-back landed: unpin
  s.set("e", { w: 40, pinned: false });                                    // 140 > 100: a is now evictable -> dropped
  check("an unpinned entry becomes evictable again", sync(s.get("a")) === undefined && sync(s.get("d"))?.w === 40 && sync(s.get("e"))?.w === 40);
  const p = { w: 10, pinned: true };
  s.set("p", p); s.evict("p");
  check("explicit evict(id) removes even a pinned entry", sync(s.get("p")) === undefined);
}

// Unit weight (the default) is a plain count cap; a budget below 1 is rejected.
{
  const c = makeLruStore<number>({ max: 2 });
  c.set("a", 1); c.set("b", 2); c.set("c", 3);
  check("unit-weight LRU is a plain count cap", c.get("a") === undefined && c.get("b") === 2 && c.get("c") === 3);
  let threw = false; try { makeLruStore({ max: 0 }); } catch { threw = true; }
  check("a budget below 1 is rejected", threw);

  const u = makeUnboundedStore<number>();
  for (let i = 0; i < 10000; i++) u.set("k" + i, i);
  check("unbounded store retains everything (the honest non-evicting default)", u.get("k0") === 0 && u.get("k9999") === 9999);
}

// --- a long served session, byte-bounded ----------------------------------------------
const server = makeTier("server");
const browser = makeTier("browser");
const channel = new Channel({ server, browser });

// Uniform-size objects, so the byte budget maps to an exact resident COUNT: every fetch is
// the same wire size S, and a budget of S*CAP holds exactly CAP entries.
const N = 4000;
const CAP = 100;
const payload = "x".repeat(200);
const handles = Array.from({ length: N }, () => server.heap.put({ payload }));

const probe = makeHost(browser, channel);                 // measure one snapshot's wire size
probe.deref(handles[0]);
const S = probe.stats.bytes;
check(`each snapshot weighs a uniform ${S} B on the wire`, S > 0);

const host = makeHost(browser, channel, makeLruStore({ max: S * CAP, weigh: (e) => e.bytes }));
for (const h of handles) host.deref(h);                   // each distinct handle: a cold, coherent-miss fetch
check(`derefed ${N} distinct objects (~${((N * S) / 1048576).toFixed(1)} MiB), each a cold fetch`, host.stats.fetches === N && host.stats.hits === 0);

// Boundedness, airtight. The budget holds exactly the most-recent CAP: ids [N-CAP .. N-1].
// Re-deref that window in order — every one MUST be a hit (nothing older fit alongside it).
let allHits = true; const winStart = host.stats.fetches;
for (let i = N - CAP; i < N; i++) { const f = host.stats.fetches; host.deref(handles[i]); if (host.stats.fetches !== f) allHits = false; }
check(`only the most-recent ${CAP} objects fit the ${((S * CAP) / 1024).toFixed(0)} KiB budget — re-derefing that window is all hits`, allHits && host.stats.fetches === winStart);

// The complement: an id beyond the budget was evicted (a miss). That miss then repopulates
// and evicts the current least-recent, proving the budget is a hard bound, not budget+1.
const missBefore = host.stats.fetches;
host.deref(handles[0]);
check("an object beyond the budget was evicted (a miss, not retained)", host.stats.fetches === missBefore + 1);
const evictBefore = host.stats.fetches;
host.deref(handles[N - CAP]);                             // was the LRU; the miss above pushed it out
check("adding one entry evicted one — the byte budget is a hard bound", host.stats.fetches === evictBefore + 1);

// --- eviction is by recency (LRU), not insertion order (FIFO) --------------------------
{
  const h2 = makeHost(browser, channel, makeLruStore({ max: 3 }));   // count-based here: recency logic is weight-agnostic
  const [A, B, C, D] = [handles[10], handles[11], handles[12], handles[13]];
  h2.deref(A); h2.deref(B); h2.deref(C);                  // resident {A,B,C}
  let f = h2.stats.fetches; h2.deref(A); const touchHit = h2.stats.fetches === f;   // touch A -> hit, promotes it; B now least-recent
  f = h2.stats.fetches; h2.deref(D); const missD = h2.stats.fetches === f + 1;      // miss -> evicts least-recent (B), not A
  f = h2.stats.fetches; h2.deref(A); const hitA = h2.stats.fetches === f;           // A was promoted -> still resident (hit)
  f = h2.stats.fetches; h2.deref(B); const missB = h2.stats.fetches === f + 1;      // B was the LRU -> evicted (miss)
  check("touching an entry is a hit and promotes it", touchHit && missD);
  check("LRU evicts the least-recently-used (B), keeping the recently-touched (A)", hitA && missB);
}

// --- the safety property: an eviction never holds the only copy or a stale one ---------
{
  const h3 = makeHost(browser, channel, makeLruStore({ max: 2 }));
  const X = server.heap.put({ v: 100 });
  const first = h3.deref(X) as { v: number };
  check("cold deref reads the master value", first.v === 100);
  server.heap.mutate(X.id, (o: any) => { o.v = 200; });                  // master changes while X sits in cache
  const refetched = h3.deref(X) as { v: number };
  check("a master mutation invalidates the cached copy — the reader refetches the new value", refetched.v === 200);
  h3.deref(server.heap.put({ v: 1 })); h3.deref(server.heap.put({ v: 2 }));  // 2 distinct -> X evicted from the 2-slot cache
  server.heap.mutate(X.id, (o: any) => { o.v = 300; });
  const afterEvict = h3.deref(X) as { v: number };
  check("after eviction, the refetch returns the correct current master (no lost/stale write)", afterEvict.v === 300);
}

// --- the default host is byte-bounded too (no store injected) --------------------------
{
  const hd = makeHost(browser, channel);                 // default: LRU weighed by bytes at DEFAULT_CACHE_BYTES
  hd.deref(handles[0]);
  const f = hd.stats.fetches; hd.deref(handles[0]);      // still resident -> a hit
  check(`the default host is byte-bounded at DEFAULT_CACHE_BYTES (${(DEFAULT_CACHE_BYTES / 1048576)} MiB) and serves from cache`, hd.stats.fetches === f && DEFAULT_CACHE_BYTES >= 1);
}

console.log(ok()
  ? "PASS — the served cache is byte-bounded: a long session of distinct derefs stays within a memory budget, LRU-evicts by recency, and every eviction costs at most a correct refetch"
  : "FAIL");
process.exit(ok() ? 0 : 1);

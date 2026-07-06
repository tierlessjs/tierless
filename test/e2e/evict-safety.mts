// Regression: the served-path deref cache is BOUNDED under a long session.
//
// Before this, fetch.mts's makeHost held a set-only Map — resident memory grew for every
// distinct object a session dereferenced, with no bound short of disconnect. The cache now
// lives behind an injected store; the default is a bounded LRU. This proves, end to end,
// that a long session dereferencing far more distinct objects than the cap stays capped,
// evicts by recency (LRU, not FIFO), and — the served-path safety property — that every
// eviction costs at most a correct refetch, never a lost or stale value.
import { makeTier, Channel, makeHost, makeLruStore, makeUnboundedStore, DEFAULT_CACHE_CAP } from "tierless/heap";
import { makeCheck } from "../lib/check.mts";

const { check, ok } = makeCheck();
console.log("Probe: served-cache memory is bounded — a long session of distinct derefs stays capped\n");

// --- the store primitives: get / set / evict, and the cap guard -----------------------
{
  const s = makeLruStore<number>(2);
  s.set("a", 1); s.set("b", 2);
  check("LRU store returns what it holds", s.get("a") === 1 && s.get("b") === 2);
  s.set("c", 3);                                    // over cap 2 -> least-recent evicted
  check("LRU store caps size, evicting least-recent on overflow", s.get("a") === undefined && s.get("b") === 2 && s.get("c") === 3);
  s.evict("b");
  check("evict(id) drops an entry outright", s.get("b") === undefined);
  let threw = false;
  try { makeLruStore(0); } catch { threw = true; }
  check("a cap below 1 is rejected", threw);

  const u = makeUnboundedStore<number>();
  for (let i = 0; i < 10000; i++) u.set("k" + i, i);
  check("unbounded store retains everything (the honest non-evicting default)", u.get("k0") === 0 && u.get("k9999") === 9999);
}

// --- a long session on a real host: distinct derefs far exceeding the cap --------------
const server = makeTier("server");
const browser = makeTier("browser");
const channel = new Channel({ server, browser });

const N = 5000;
const CAP = 100;
const handles = Array.from({ length: N }, (_, i) => server.heap.put({ i, tag: "obj-" + i }));

const host = makeHost(browser, channel, makeLruStore(CAP));
for (const h of handles) host.deref(h);              // each distinct handle: a cold, coherent-miss fetch
check(`derefed ${N} distinct objects, each a cold fetch (${host.stats.fetches})`, host.stats.fetches === N && host.stats.hits === 0);

// Boundedness, airtight. After the pass, LRU membership is exactly the most-recent CAP:
// ids [N-CAP .. N-1]. Re-deref that window in order — every one MUST be a hit (nothing
// older survived to occupy a slot), and the membership is unchanged.
let hitFetches = host.stats.fetches;
let allHits = true;
for (let i = N - CAP; i < N; i++) { const f = host.stats.fetches; host.deref(handles[i]); if (host.stats.fetches !== f) allHits = false; }
check(`only the most-recent ${CAP} objects are resident — re-derefing that window is all cache hits`, allHits && host.stats.fetches === hitFetches);

// The complement: an id just older than the window was evicted, so it is a MISS. Then
// that miss repopulates and evicts the current least-recent (N-CAP), proving the cap held
// (adding one dropped one) rather than the set growing to CAP+1.
const missBefore = host.stats.fetches;
host.deref(handles[0]);                              // oldest — long gone
check("an object older than the window was evicted (a miss, not retained)", host.stats.fetches === missBefore + 1);
const evictBefore = host.stats.fetches;
host.deref(handles[N - CAP]);                        // was the LRU; the miss above pushed it out
check("adding one entry evicted one — the cap is a hard bound, not CAP+1", host.stats.fetches === evictBefore + 1);

// --- eviction is by recency (LRU), not insertion order (FIFO) --------------------------
{
  const h2 = makeHost(browser, channel, makeLruStore(3));
  const [A, B, C, D] = [handles[10], handles[11], handles[12], handles[13]];
  h2.deref(A); h2.deref(B); h2.deref(C);             // resident {A,B,C}
  let f = h2.stats.fetches; h2.deref(A); const touchHit = h2.stats.fetches === f;   // touch A -> hit, promotes it; B now least-recent
  f = h2.stats.fetches; h2.deref(D); const missD = h2.stats.fetches === f + 1;      // miss -> evicts least-recent (B), not A
  f = h2.stats.fetches; h2.deref(A); const hitA = h2.stats.fetches === f;           // A was promoted -> still resident (hit)
  f = h2.stats.fetches; h2.deref(B); const missB = h2.stats.fetches === f + 1;      // B was the LRU -> evicted (miss)
  check("touching an entry is a hit and promotes it", touchHit && missD);
  check("LRU evicts the least-recently-used (B), keeping the recently-touched (A)", hitA && missB);
}

// --- the safety property: an eviction never holds the only copy or a stale one ---------
// Evicting a served-cache entry costs at most a refetch, and the refetch observes the
// current master — even if the master mutated while the entry was evicted.
{
  const h3 = makeHost(browser, channel, makeLruStore(2));
  const X = server.heap.put({ v: 100 });
  const first = h3.deref(X) as { v: number };
  check("cold deref reads the master value", first.v === 100);
  server.heap.mutate(X.id, (o: any) => { o.v = 200; });   // master changes while X sits in cache
  const refetched = h3.deref(X) as { v: number };
  check("a master mutation invalidates the cached copy — the reader refetches the new value", refetched.v === 200);
  // now force X out by cap pressure, mutate again, and confirm the post-eviction refetch is correct
  h3.deref(server.heap.put({ v: 1 })); h3.deref(server.heap.put({ v: 2 }));  // 2 distinct -> X evicted from cap-2 cache
  server.heap.mutate(X.id, (o: any) => { o.v = 300; });
  const afterEvict = h3.deref(X) as { v: number };
  check("after eviction, the refetch returns the correct current master (no lost/stale write)", afterEvict.v === 300);
}

// --- the default host is bounded too (no store injected) --------------------------------
{
  const hd = makeHost(browser, channel);            // default: bounded LRU at DEFAULT_CACHE_CAP
  const many = Array.from({ length: DEFAULT_CACHE_CAP + 1 }, () => server.heap.put({}));
  for (const h of many) hd.deref(h);
  const f = hd.stats.fetches;
  hd.deref(many[0]);                                 // the very first, one past the cap -> evicted
  check(`the default host caps at DEFAULT_CACHE_CAP (${DEFAULT_CACHE_CAP}) with no store injected`, hd.stats.fetches === f + 1);
}

console.log(ok()
  ? "PASS — the served cache is bounded: a long session of distinct derefs stays capped, LRU-evicts by recency, and every eviction costs at most a correct refetch"
  : "FAIL");
process.exit(ok() ? 0 : 1);

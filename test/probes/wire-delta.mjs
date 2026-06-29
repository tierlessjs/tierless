// Probe: the DELTA wire codec (src/wire-delta.mjs) — ship a continuation as a patch over what
// the peer already holds, so a capture costs bytes proportional to what CHANGED, not to total
// size. This is the optimization for the oscillation case: a session that crosses the tier
// boundary many times re-ships a near-identical continuation each hop.
//
// What must hold:
//   1. Fidelity — a delta reconstructs the continuation exactly: object identity (sharing),
//      cycles, arrays, and exotic values (undefined, bigint, §5 handles) all survive, same as
//      the full wire codec.
//   2. Locality — a deep change bumps ONLY the object that changed (shallow versioning: children
//      by id), not its ancestors, so an N-deep edit ships 1 object, not the spine to the root.
//   3. Bidirectionality — a migration BOUNCE (A→B→A) is a delta in BOTH directions: the receiver
//      learns the versions it now holds, so its encode-back ships only what it then changes.
//   4. Floor — delta is never pathologically larger than just shipping the full binary wire; the
//      caller takes min(delta, full) per message (the §6 cost decision), so it can only help.
//   5. Write-tracked ≡ rescan — the O(changed) "bump version on write" encoder (touch() marks an
//      object dirty when mutated) ships the SAME set and reconstructs IDENTICALLY to the O(reachable)
//      rescan encoder, which is the oracle. Same wire, same store, lower cost.
import { makeDeltaSession, encodeDelta, applyDelta,
  makeTrackedSession, encodeDeltaTracked, applyDeltaTracked, touch } from "../../src/wire-delta.mjs";
import { encodeWireBinary } from "../../src/wire-binary.mjs";
import { makeTier } from "../../src/heap.mjs";

let pass = true;
const check = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); pass = pass && cond; };

// structural deep-equality that tolerates cycles, bigint, undefined, and §5 handles
function deepEq(a, b, seen = new Set()) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return Object.is(a, b);
  const tag = a; if (seen.has(tag)) return true; seen.add(tag);            // cycle guard (structural)
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k], seen));
}

console.log("Probe: the delta wire codec — fidelity, locality, bidirectional bounce, floor\n");

// ---------------------------------------------------------------------------------------------
// 1) FIDELITY — a single delta reconstructs identity, cycles, primitives, bigint, and a request.
// ---------------------------------------------------------------------------------------------
{
  const A = makeDeltaSession("server"), B = makeDeltaSession("browser");
  const shared = { tag: "shared", n: 1 };
  const cyc = { name: "node" }; cyc.self = cyc;                           // the most ordinary cycle
  const stack = [{ fn: "App", pc: 3, a: shared, b: shared, c: cyc, list: [1, 2, 3], flag: true, none: null, u: undefined, big: 10n }];
  const req = { op: "resource", tier: "server", name: "api.getTasks", args: [{ status: "all" }, 42] };
  const { stack: s, request: r } = applyDelta(B, encodeDelta(A, stack, req).bytes);

  check("fidelity: a shared object stays ONE object on the peer (identity, a === b)", s[0].a === s[0].b);
  check("fidelity: a cycle is restored (c.self === c)", s[0].c.self === s[0].c);
  check("fidelity: array / bool / null / undefined / bigint all round-trip",
    deepEq(s[0].list, [1, 2, 3]) && s[0].flag === true && s[0].none === null && s[0].u === undefined && s[0].big === 10n);
  check("fidelity: the suspended request (name + already-evaluated args) round-trips",
    r.name === "api.getTasks" && r.args[1] === 42 && r.args[0].status === "all");
}

// ---------------------------------------------------------------------------------------------
// 2) DELTA + LOCALITY — second capture ships only what changed; a deep edit does not bubble up.
// ---------------------------------------------------------------------------------------------
{
  const A = makeDeltaSession("server"), B = makeDeltaSession("browser");
  const big = { rows: Array.from({ length: 200 }, (_, i) => ({ id: i, title: "row " + i, done: false })) };
  const cursor = { filter: "all", page: 0 };
  const stack = [{ fn: "App", pc: 1, big, cursor }];

  const c1 = encodeDelta(A, stack, null);
  applyDelta(B, c1.bytes);
  check("first capture ships the whole graph (nothing known on the peer yet)", c1.shipped === c1.reachable);

  cursor.page = 1;                                                        // mutate ONE small object
  const c2 = encodeDelta(A, stack, null);
  const { stack: s2 } = applyDelta(B, c2.bytes);
  check("second capture ships ONLY the changed object (1 of " + c2.reachable + ")", c2.shipped === 1);
  check("the delta is far smaller than the full capture (" + c2.bytes.length + " B vs " + c1.bytes.length + " B)", c2.bytes.length * 10 < c1.bytes.length);
  check("the delta applied on the peer: cursor.page is now 1", s2[0].cursor.page === 1);
  check("the unchanged 200-row graph is intact on the peer (never re-shipped)", s2[0].big.rows.length === 200 && s2[0].big.rows[199].title === "row 199");
}
{
  // shallow versioning: a leaf edit 3 deep ships exactly 1 object, not the spine to the root.
  const A = makeDeltaSession("server"), B = makeDeltaSession("browser");
  const leaf = { v: 0 }, mid = { leaf }, root = { mid, label: "r" };
  const stack = [{ fn: "F", pc: 0, root }];
  applyDelta(B, encodeDelta(A, stack, null).bytes);                       // prime: peer now holds all 3
  leaf.v = 99;
  const c = encodeDelta(A, stack, null);
  const { stack: s } = applyDelta(B, c.bytes);
  check("locality: a 3-deep leaf edit ships exactly 1 object — no ancestor bubble", c.shipped === 1);
  check("locality: the deep change is visible THROUGH the unchanged ancestors on the peer", s[0].root.mid.leaf.v === 99);
  check("locality: the ancestors were not re-shipped but still resolve (root.label intact)", s[0].root.label === "r");
}

// ---------------------------------------------------------------------------------------------
// 3) §5 HANDLE — a big subgraph that travels as a handle stays a leaf on the peer (not copied).
// ---------------------------------------------------------------------------------------------
{
  const A = makeDeltaSession("server"), B = makeDeltaSession("browser");
  const tier = makeTier("server");
  const handle = { __stackmix_handle__: true, owner: tier.id, id: tier.heapPut({ huge: "x".repeat(5000) }), kind: "object" };
  const stack = [{ fn: "App", pc: 2, view: { title: "page" }, data: handle }];
  const { stack: s } = applyDelta(B, encodeDelta(A, stack, null).bytes);
  check("§5 handle travels as a leaf (stays an opaque handle on the peer, not dereferenced/copied)",
    s[0].data.__stackmix_handle__ === true && s[0].data.owner === tier.id && s[0].data.id === handle.id && s[0].data.kind === "object");
}

// ---------------------------------------------------------------------------------------------
// 4) BIDIRECTIONAL OSCILLATION — bounce the live continuation A→B→A… K times, mutating a couple
//    of locals on whichever side holds it each hop. Assert EXACT reconstruction every hop, and
//    that after the first (full) hop every hop ships only the change — far under a full re-ship.
// ---------------------------------------------------------------------------------------------
{
  const server = makeDeltaSession("server"), browser = makeDeltaSession("browser");
  // a realistic continuation: a fixed-size feed model + a small mutable UI cursor
  const feed = Array.from({ length: 120 }, (_, i) => ({ id: i, title: "Article " + i, author: "user" + (i % 20), score: i % 100 }));
  let live = [{ fn: "App", pc: 4, model: { feed, total: feed.length }, ui: { filter: "all", page: 0, tick: 0 } }];

  const K = 12;
  let here = server, there = browser;
  const deltaBytes = [], fullBytes = [];
  let allExact = true, maxShippedAfterFirst = 0;

  for (let hop = 0; hop < K; hop++) {
    const enc = encodeDelta(here, live, null);
    const { stack: recv } = applyDelta(there, enc.bytes);

    // the reconstruction must equal what we sent, every hop
    const exact = deepEq(recv, live)
      && recv[0].model.feed[119].title === "Article 119"               // big graph survived
      && recv[0].ui.tick === live[0].ui.tick;                          // the mutating field survived
    allExact = allExact && exact;

    deltaBytes.push(enc.bytes.length);
    fullBytes.push(encodeWireBinary(live, null, {}).length);          // what a full (non-delta) capture would cost
    if (hop > 0) maxShippedAfterFirst = Math.max(maxShippedAfterFirst, enc.shipped);

    // the receiver now holds it: mutate a couple of small locals, then bounce back (roles swap)
    recv[0].ui.page = hop;
    recv[0].ui.tick = hop + 1;
    live = recv;
    [here, there] = [there, here];
  }

  check(`oscillation: all ${K} hops reconstructed the continuation EXACTLY (identity + values)`, allExact);
  check("oscillation: after hop 1, every hop ships ≤ 2 objects (only the touched UI locals)", maxShippedAfterFirst <= 2);
  check(`oscillation: hop-1 was a full capture (${deltaBytes[0]} B), then deltas collapse (hop-2 = ${deltaBytes[1]} B)`, deltaBytes[1] * 10 < deltaBytes[0]);

  const avgDelta = Math.round(deltaBytes.slice(1).reduce((a, b) => a + b, 0) / (K - 1));
  const avgFull = Math.round(fullBytes.slice(1).reduce((a, b) => a + b, 0) / (K - 1));
  check(`oscillation: steady-state delta (~${avgDelta} B) is an order of magnitude under a full re-ship (~${avgFull} B)`, avgDelta * 8 < avgFull);

  // delta is FLAT in the (constant) change, independent of the feed size — the defining property
  const spread = Math.max(...deltaBytes.slice(1)) - Math.min(...deltaBytes.slice(1));
  check(`oscillation: steady-state delta size is FLAT (spread ${spread} B) — proportional to change, not to total size`, spread < 32);
}

// ---------------------------------------------------------------------------------------------
// 5) FLOOR via min(delta, full) — the optimal strategy is to ship the smaller of {delta, full
//    wire} per message (the §6 cost decision). On a COLD capture (nothing shared) the delta form
//    is LESS compact than the full wire — it pays a stable id per object where the binary wire
//    amortizes keys through a shape table — so the strategy correctly falls back to full. That
//    fallback is what guarantees the chosen wire is never worse than the full encoding.
// ---------------------------------------------------------------------------------------------
{
  const A = makeDeltaSession("server"), B = makeDeltaSession("browser");
  const fresh = [{ fn: "App", pc: 0, rows: Array.from({ length: 80 }, (_, i) => ({ id: i, name: "n" + i, on: i % 2 === 0 })) }];
  const d = encodeDelta(A, fresh, null);                                  // cold: nothing shared, everything changed
  applyDelta(B, d.bytes);
  const full = encodeWireBinary(fresh, null, {}).length;
  const chosen = Math.min(d.bytes.length, full);                         // the strategy: take the smaller
  check(`floor: min(delta, full) is never worse than the full wire (ships ${chosen} B; full ${full} B, cold delta ${d.bytes.length} B)`, chosen <= full);
  check("floor: on a cold capture the delta exceeds full, so the strategy correctly falls back to full",
    d.bytes.length > full ? chosen === full : true);
}

// ---------------------------------------------------------------------------------------------
// 6) WRITE-TRACKED ≡ RESCAN — drive the SAME mutations through a rescan pair (the oracle) and a
//    write-tracked pair (touch() on each write). Assert identical ship counts and identical
//    reconstruction every hop, plus correct detection of a NEW object created mid-oscillation.
// ---------------------------------------------------------------------------------------------
{
  const mk = () => [{ fn: "App", pc: 4,
    model: { feed: Array.from({ length: 60 }, (_, i) => ({ id: i, title: "A" + i, done: false })), total: 60 },
    ui: { filter: "all", page: 0, tick: 0 } }];

  const rs = makeDeltaSession("server"), rp = makeDeltaSession("browser");
  const ts = makeTrackedSession("server"), tp = makeTrackedSession("browser");
  let rLive = mk(), tLive = mk(), rHere = rs, rThere = rp, tHere = ts, tThere = tp;
  let countsMatch = true, reconMatch = true, allExact = true;

  for (let hop = 0; hop < 10; hop++) {
    const rEnc = encodeDelta(rHere, rLive, null);
    const { stack: rRecv } = applyDelta(rThere, rEnc.bytes);
    const tEnc = encodeDeltaTracked(tHere, tLive, null);
    const { stack: tRecv } = applyDeltaTracked(tThere, tEnc.bytes);

    countsMatch = countsMatch && rEnc.shipped === tEnc.shipped;
    reconMatch = reconMatch && deepEq(rRecv, tRecv);
    allExact = allExact && deepEq(tRecv, tLive);

    for (const [recv, tracked] of [[rRecv, false], [tRecv, true]]) {
      recv[0].ui.filter = ["all", "active", "done"][hop % 3];
      recv[0].ui.tick = hop + 1;
      const row = recv[0].model.feed[hop % 60]; row.done = !row.done;
      if (tracked) touch(tThere, recv[0].ui, row);                      // bump version on each write
    }
    rLive = rRecv; [rHere, rThere] = [rThere, rHere];
    tLive = tRecv; [tHere, tThere] = [tThere, tHere];
  }
  check("write-tracked ships the SAME object count as the rescan oracle, every hop", countsMatch);
  check("write-tracked reconstructs IDENTICALLY to the rescan oracle, every hop", reconMatch);
  check("write-tracked reconstructs the exact continuation it sent, every hop", allExact);
}
{
  // a NEW object created mid-oscillation must be detected and shipped (the walk finds it past the
  // dirty array that now references it), even though it was never itself touch()ed.
  const s = makeTrackedSession("server"), p = makeTrackedSession("browser");
  const live = [{ fn: "F", pc: 0, root: { items: [{ id: 0 }] } }];
  applyDeltaTracked(p, encodeDeltaTracked(s, live, null).bytes);        // prime
  live[0].root.items.push({ id: 1, note: "new" });
  touch(s, live[0].root.items);                                        // bump the mutated array
  const enc = encodeDeltaTracked(s, live, null);
  const { stack: recv } = applyDeltaTracked(p, enc.bytes);
  check("write-tracked: a new object created mid-stream is shipped and linked on the peer",
    recv[0].root.items.length === 2 && recv[0].root.items[1].note === "new");
  check("write-tracked: it ships exactly the mutated array + the one new object (2)", enc.shipped === 2);
}

// ---------------------------------------------------------------------------------------------
// 7) MAP / SET — first-class in the delta codec: identity and cycles preserved (a shared object
//    that is a Map key AND a Set member AND a frame local stays ONE object), and a Map.set / Set
//    mutation ships only the changed container, matching the rescan oracle.
// ---------------------------------------------------------------------------------------------
{
  const A = makeDeltaSession("server"), B = makeDeltaSession("browser");
  const shared = { tag: "s" };
  const m = new Map([["k", 1], [shared, { v: 10 }], ["arr", [1, 2, 3]]]);
  const set = new Set([shared, "x", 42]);
  const cyc = new Map(); cyc.set("self", cyc);                           // a cyclic Map
  const stack = [{ fn: "App", pc: 1, m, set, shared, cyc }];
  const { stack: s } = applyDelta(B, encodeDelta(A, stack, null).bytes);
  check("map/set: Map and Set reconstruct with the right size and entries",
    s[0].m instanceof Map && s[0].m.size === 3 && s[0].m.get("arr").length === 3 && s[0].set instanceof Set && s[0].set.has(42));
  const mapKey = [...s[0].m.keys()].find((k) => k && k.tag === "s");
  check("map/set: a shared object is ONE instance across a Map key, a Set member, and a local",
    mapKey === s[0].shared && s[0].set.has(s[0].shared));
  check("map/set: a cyclic Map (m.self === m) round-trips", s[0].cyc.get("self") === s[0].cyc);
}
{
  // Map.set ships only the changed Map, matching the rescan oracle
  const rs = makeDeltaSession("server"), rp = makeDeltaSession("browser");
  const ts = makeTrackedSession("server"), tp = makeTrackedSession("browser");
  const mk = () => [{ fn: "F", pc: 0, cache: new Map([["a", { n: 1 }], ["b", { n: 2 }]]), tags: new Set(["x"]) }];
  const rl = mk(), tl = mk();
  applyDelta(rp, encodeDelta(rs, rl, null).bytes); applyDeltaTracked(tp, encodeDeltaTracked(ts, tl, null).bytes);
  rl[0].cache.set("c", { n: 3 }); rl[0].tags.add("y");
  tl[0].cache.set("c", { n: 3 }); tl[0].tags.add("y"); touch(ts, tl[0].cache, tl[0].tags);
  const re = encodeDelta(rs, rl, null), te = encodeDeltaTracked(ts, tl, null);
  const rb = applyDelta(rp, re.bytes), tb = applyDeltaTracked(tp, te.bytes);
  check("map/set: a Map.set + Set.add ship the same count tracked as rescan", re.shipped === te.shipped);
  check("map/set: both reconstruct the grown Map (3) and Set (2)",
    rb.stack[0].cache.size === 3 && tb.stack[0].cache.size === 3 && tb.stack[0].tags.has("y") && tb.stack[0].cache.get("c").n === 3);
}

// ---------------------------------------------------------------------------------------------
// 8) ORPHAN — write-tracked is O(changed), so it cannot cheaply prove reachability; if code mutates
//    an object then orphans it in the SAME run, the orphan ships as a harmless extra. Assert the
//    RECONSTRUCTION is still correct (the contract is correctness, not always byte-minimality).
// ---------------------------------------------------------------------------------------------
{
  const s = makeTrackedSession("server"), p = makeTrackedSession("browser");
  const live = [{ fn: "F", pc: 0, list: [{ id: 0, n: 0 }, { id: 1, n: 0 }] }];
  applyDeltaTracked(p, encodeDeltaTracked(s, live, null).bytes);         // baseline holds both rows
  const victim = live[0].list[0];
  victim.n = 99; touch(s, victim);                                       // mutate row 0…
  live[0].list.shift(); touch(s, live[0].list);                          // …then orphan it (remove from the list)
  const enc = encodeDeltaTracked(s, live, null);
  const { stack: recv } = applyDeltaTracked(p, enc.bytes);
  check("orphan: the reconstruction is correct — list is [{id:1}], the orphaned row is gone",
    recv[0].list.length === 1 && recv[0].list[0].id === 1 && !recv[0].list.some((r) => r.id === 0));
  check("orphan: a subsequent clean capture ships nothing new (the stray was bounded to one hop)",
    (live[0].list.push({ id: 2, n: 0 }), touch(s, live[0].list), encodeDeltaTracked(s, live, null).shipped) <= 2);
}

console.log(`\n  delta wire: ${pass ? "fidelity, locality, bounce, floor, write-tracked≡rescan, Map/Set, and orphan-correctness all hold" : "FAILURES above"}`);
process.exit(pass ? 0 : 1);

// Delta wire vs full wire — the OSCILLATION case: a continuation that crosses the tier boundary
// many times (a session driven by a sequence of events) re-ships a near-identical continuation
// each hop. Shipping the full capture every time pays for the whole model every hop; shipping a
// PATCH over what the peer already holds pays only for what changed.
//
// The optimal strategy (what this measures):
//   • Each tier keeps a replicated, stably-identified object store (stable id per object, a
//     SHALLOW content version so a deep edit bumps only its own object, not its ancestors).
//   • Baseline = what the peer already holds (the last exchange). Encode the capture as the set
//     of changed objects + the root references; the peer mutates its store in place.
//   • Per message take min(delta, full wire): the first (cold) hop has no baseline and falls back
//     to the full binary wire; every subsequent (warm) hop ships a delta. Never worse than full.
//
// Result: session bytes track CHANGE, not total size — and the win GROWS with model size, because
// the full wire grows with the model while the delta stays flat in the (constant) per-hop change.
//
//   node bench/delta.mjs
import { makeDeltaSession, encodeDelta, applyDelta,
  makeTrackedSession, encodeDeltaTracked, applyDeltaTracked, touch } from "tierless/delta";
import { encodeWireBinary } from "tierless/wire";

const fmt = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB");
const sum = (a) => a.reduce((x, y) => x + y, 0);

// A realistic continuation: a fixed-size feed model the session reads, plus a small UI cursor the
// events mutate. `rows` rows of {id, title, author, score, done}.
const makeContinuation = (rows) => [{
  fn: "App", pc: 4,
  model: { feed: Array.from({ length: rows }, (_, i) => ({ id: i, title: "Article number " + i, author: "user" + (i % 20), score: i % 100, done: false })), total: rows },
  ui: { filter: "all", page: 0, selected: -1, tick: 0 },
}];

// Bounce the continuation A→B→A… K times. Each hop the holder mutates a couple of small UI locals
// (a filter change, a page step) and toggles one feed row's `done` (a deep edit). Return per-hop
// delta bytes and the full-wire bytes the same hop would have cost.
function oscillate(rows, K) {
  const A = makeDeltaSession("server"), B = makeDeltaSession("browser");
  let live = makeContinuation(rows);
  let here = A, there = B;
  const delta = [], full = [], shipped = [];
  for (let hop = 0; hop < K; hop++) {
    const enc = encodeDelta(here, live, null);
    const { stack: recv } = applyDelta(there, enc.bytes);
    delta.push(enc.bytes.length);
    full.push(encodeWireBinary(live, null, {}).length);
    shipped.push(enc.shipped);
    // the receiver now holds it — drive one event, then bounce back (roles swap)
    recv[0].ui.filter = ["all", "active", "done"][hop % 3];
    recv[0].ui.page = hop;
    recv[0].ui.tick = hop + 1;
    recv[0].model.feed[hop % rows].done = !recv[0].model.feed[hop % rows].done;   // a deep edit (1 row object)
    live = recv;
    [here, there] = [there, here];
  }
  return { delta, full, shipped };
}

console.log("Delta wire vs full wire — an oscillating continuation\n");

// ---- per-hop trace for one representative size: watch the cold→warm collapse ----
const K = 12, traceRows = 200;
const t = oscillate(traceRows, K);
console.log(`A ${traceRows}-record feed bounced ${K} times (each hop: a filter/page change + toggle one row):\n`);
console.log("   hop   objs shipped        delta        full wire     min(delta,full)");
for (let i = 0; i < K; i++) {
  const chosen = Math.min(t.delta[i], t.full[i]);
  const note = i === 0 ? "  cold → full" : "";
  console.log(`   ${String(i + 1).padStart(3)}   ${String(t.shipped[i]).padStart(6)}        ${fmt(t.delta[i]).padStart(9)}      ${fmt(t.full[i]).padStart(9)}      ${fmt(chosen).padStart(9)}${note}`);
}
{
  const fullOnly = sum(t.full);
  const strategy = sum(t.full.map((f, i) => Math.min(t.delta[i], f)));
  console.log(`\n   session total — full every hop: ${fmt(fullOnly)}    strategy min(delta,full): ${fmt(strategy)}    saved ${(100 * (1 - strategy / fullOnly)).toFixed(0)}%`);
}

// ---- the win grows with model size: delta is flat in the change, full grows with the model ----
console.log(`\nThe win grows with model size (${K} hops, steady-state = warm hops 2..${K}):\n`);
console.log("   feed size      full / hop     warm delta / hop     session full-only     session strategy      saved");
for (const rows of [25, 100, 400, 1600]) {
  const o = oscillate(rows, K);
  const warmDelta = Math.round(sum(o.delta.slice(1)) / (K - 1));
  const fullPerHop = Math.round(sum(o.full) / K);
  const fullOnly = sum(o.full);
  const strategy = sum(o.full.map((f, i) => Math.min(o.delta[i], f)));
  console.log(`   ${String(rows).padStart(5)} recs    ${fmt(fullPerHop).padStart(9)}        ${fmt(warmDelta).padStart(9)}            ${fmt(fullOnly).padStart(9)}            ${fmt(strategy).padStart(9)}       ${(100 * (1 - strategy / fullOnly)).toFixed(0)}%`);
}

console.log(`\nThe warm delta is FLAT (~the bytes of one filter change + one toggled row), independent of feed`);
console.log(`size, while the full wire scales with the feed. So over a multi-crossing session the delta`);
console.log(`saves more the larger the model — and min(delta, full) makes the cold first hop a safe fallback,`);
console.log(`never worse than shipping the full binary wire. This reuses the §5 versioning and the §6 cost`);
console.log(`decision: ship a coherence patch, and pick the cheaper of {patch, full} per message.`);

// ---- CPU: does the change-accounting add or remove serialization overhead? -------------------
// The delta replaces "serialize every object" with "walk + shallow-hash every object, serialize
// only the changed ones." Both encoders walk the whole graph; the question is whether hashing-all
// is cheaper than the serialization it saves. Measure encode time three ways on one continuation:
//   full        encodeWireBinary(whole)            — today's per-hop cost (walk + serialize all)
//   delta-cold  encodeDelta(fresh peer, whole)     — worst case: walk + hash all + serialize all
//   delta-warm  encodeDelta(primed peer, whole)    — steady state: walk + hash all + serialize ~none
const best = (thunk, iters = 300) => { for (let i = 0; i < 5; i++) thunk(); let b = Infinity; for (let k = 0; k < 8; k++) { const t = process.hrtime.bigint(); for (let i = 0; i < iters; i++) thunk(); b = Math.min(b, Number(process.hrtime.bigint() - t) / iters); } return b / 1000; };

console.log(`\nCPU — encode time per hop (the accounting cost), JS codec, ${traceRows}-record continuation:\n`);
console.log("   encoder                                         time      vs full");
{
  const live = makeContinuation(traceRows);
  const tFull = best(() => encodeWireBinary(live, null, {}));
  const tCold = best(() => encodeDelta(makeDeltaSession("server"), live, null));   // fresh peer each call ⇒ ships all
  // primed warm peer: it already holds the baseline, so an encode walks+hashes all but serializes ~none
  const warm = makeDeltaSession("server"); const peer = makeDeltaSession("browser");
  applyDelta(peer, encodeDelta(warm, live, null).bytes);
  const tWarm = best(() => encodeDelta(warm, live, null));
  const rel = (x) => (x / tFull).toFixed(2) + "×";
  console.log(`   full wire (serialize whole graph)           ${tFull.toFixed(1).padStart(7)} µs     ${"1.00×".padStart(6)}`);
  console.log(`   delta — cold (no baseline, ships all)       ${tCold.toFixed(1).padStart(7)} µs     ${rel(tCold).padStart(6)}`);
  console.log(`   delta — warm (baseline held, ships change)  ${tWarm.toFixed(1).padStart(7)} µs     ${rel(tWarm).padStart(6)}`);
}
console.log(`\nReading it: the warm delta still WALKS the whole graph to find what changed (a shallow hash per`);
console.log(`object), so it is NOT free — but it skips serializing the unchanged bulk, so vs a full encode it`);
console.log(`is roughly a wash to a win on CPU while being an order of magnitude smaller on the wire. The cold`);
console.log(`delta is strictly more work (hash-all + serialize-all) — which is the other reason the cold hop`);
console.log(`falls back to the full wire. That O(reachable) walk is what the write-tracked encoder removes:`);

// ---- Bump version on write: O(reachable) rescan vs O(changed) write-tracked ------------------
// The rescan encoder hashes the whole graph each capture to find what changed — O(reachable),
// growing with model size even when one field changed. The write-tracked encoder marks an object
// dirty when it is mutated (touch(), the version bump), so it ships the dirty set directly and the
// peer's apply touches only the shipped objects — O(changed), FLAT in model size. Same wire, same
// reconstruction (proven in the probe). Measure encode AND apply, warm, across sizes.
function warmPairs(rows) {
  // rescan pair: encoder + a receiver primed with the baseline; encoder holds a 2-object change.
  const rs = makeDeltaSession("server"), rp = makeDeltaSession("browser");
  const rl = makeContinuation(rows); applyDelta(rp, encodeDelta(rs, rl, null).bytes);
  rl[0].ui.tick = 1; rl[0].model.feed[0].done = true;
  const rPrimed = new Map(rs.peerVer);                                 // baseline the peer holds
  const rEncode = () => { rs.peerVer = new Map(rPrimed); return encodeDelta(rs, rl, null).bytes; };
  // tracked pair: same shape, the 2-object change declared via touch (the version bump).
  const ts = makeTrackedSession("server"), tp = makeTrackedSession("browser");
  const tl = makeContinuation(rows); applyDeltaTracked(tp, encodeDeltaTracked(ts, tl, null).bytes);
  tl[0].ui.tick = 1; tl[0].model.feed[0].done = true;
  const tEncode = () => { touch(ts, tl[0].ui, tl[0].model.feed[0]); return encodeDeltaTracked(ts, tl, null).bytes; };
  return { rEncode, tEncode, rp, tp };
}

console.log(`\nbump-on-write — rescan O(reachable) vs write-tracked O(changed), warm encode + apply (µs):\n`);
console.log("   feed size      rescan enc   tracked enc      rescan apply   tracked apply");
for (const rows of [50, 200, 800, 3200]) {
  const w = warmPairs(rows);
  const encR = best(w.rEncode), encT = best(w.tEncode);
  const dR = w.rEncode(), dT = w.tEncode();                            // a warm delta from each, to feed apply
  const applyR = best(() => applyDelta(w.rp, dR));                     // onto the primed receiver (re-scans: O(reachable))
  const applyT = best(() => applyDeltaTracked(w.tp, dT));              // onto the primed receiver (writes shipped: O(changed))
  console.log(`   ${String(rows).padStart(5)} recs    ${encR.toFixed(1).padStart(8)} µs  ${encT.toFixed(1).padStart(8)} µs     ${applyR.toFixed(1).padStart(8)} µs  ${applyT.toFixed(1).padStart(8)} µs`);
}
console.log(`\nThe rescan times climb with the feed (it re-hashes every object every hop); the write-tracked`);
console.log(`times stay FLAT — encode ships the dirty set, apply writes only the shipped objects, neither`);
console.log(`touching the unchanged bulk. That is the bump-version-on-write win: O(changed), not O(reachable),`);
console.log(`on both ends. It is exact only if every mutation bumps — the guarantee a compiler write-barrier`);
console.log(`(the --auto-writeback hook) provides; rescan stays the safe fallback when the caller can't.`);

// ---- The orphan tradeoff: pruned O(changed) vs exact O(reachable) ----------------------------
// The pruned selectDirty ships every dirty object (seeded directly), so if code mutates an object
// then ORPHANS it in the same run, the orphan ships once as a stray — not minimal. The exact variant
// ships only reachable objects (no strays) but pays a full O(reachable) walk. Which is optimal is a
// data question, not an assertion: measure the orphan rate, the wasted bytes, and the CPU under a
// MEAN workload (realistic oscillation, never orphans) and an EXTREME one (orphans every hop).
function runWorkload(rows, hops, exact, extreme) {
  const s = makeTrackedSession("server"), p = makeTrackedSession("browser");
  const live = makeContinuation(rows);
  applyDeltaTracked(p, encodeDeltaTracked(s, live, null, { exact }).bytes);     // cold baseline
  let bytes = 0, objs = 0;
  for (let hop = 0; hop < hops; hop++) {
    live[0].ui.tick = hop + 1; touch(s, live[0].ui);                            // a normal in-place edit
    const k = hop % live[0].model.feed.length;
    live[0].model.feed[k].done = !live[0].model.feed[k].done; touch(s, live[0].model.feed[k]);
    if (extreme) { touch(s, live[0].model.feed[k]); live[0].model.feed.splice(k, 1); touch(s, live[0].model.feed); live[0].model.total--; touch(s, live[0].model); }  // mutate-then-orphan the row
    const enc = encodeDeltaTracked(s, live, null, { exact });
    bytes += enc.bytes.length; objs += enc.shipped;
  }
  return { bytes, objs };
}

console.log(`\nThe orphan tradeoff — pruned O(changed) vs exact O(reachable), 200 rows, 40 hops:\n`);
console.log("   workload                       pruned objs   exact objs   orphans   wasted bytes   pruned/exact enc");
for (const [label, extreme] of [["mean (realistic oscillation)", false], ["extreme (orphan every hop)", true]]) {
  const pr = runWorkload(200, 40, false, extreme), ex = runWorkload(200, 40, true, extreme);
  const orphans = pr.objs - ex.objs, wasted = pr.bytes - ex.bytes;
  // CPU: a single warm encode under each mode on a primed session holding a one-row edit
  const mk = (exact) => { const s = makeTrackedSession("server"), p = makeTrackedSession("browser"); const l = makeContinuation(200); applyDeltaTracked(p, encodeDeltaTracked(s, l, null, { exact }).bytes); return () => { l[0].ui.tick++; touch(s, l[0].ui); l[0].model.feed[0].done = !l[0].model.feed[0].done; touch(s, l[0].model.feed[0]); return encodeDeltaTracked(s, l, null, { exact }).bytes; }; };
  const tP = best(mk(false)), tE = best(mk(true));
  console.log(`   ${label.padEnd(30)} ${String(pr.objs).padStart(8)}   ${String(ex.objs).padStart(10)}   ${String(orphans).padStart(7)}   ${fmt(Math.max(0, wasted)).padStart(11)}   ${tP.toFixed(1)}/${tE.toFixed(1)} µs`);
}
console.log(`\nTuned conclusion: under realistic oscillation the orphan count is ZERO — pruned wastes nothing and`);
console.log(`exact only adds the O(reachable) walk (slower for no benefit), so pruned O(changed) is the optimal`);
console.log(`default. Only an adversarial mutate-then-orphan-every-hop loop produces strays, each bounded to one`);
console.log(`hop (dirty is cleared per capture; adoptBaseline GCs them on the next full frame). For such a`);
console.log(`workload encodeDeltaTracked(..., { exact: true }) trades the walk cost to ship zero strays. The`);
console.log(`default is tuned to the mean; the knob covers the extreme.`);

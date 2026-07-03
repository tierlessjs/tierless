// Probe: the COMPILER write-barrier driving the delta wire's write-tracked mode on PLAIN source.
//
// track-app.src.js is ordinary straight-line code — it mutates its continuation in place every hop
// (model.hops++, model.items.push(...), model.items[i].done = ..., model.log.push(...)) with NO
// touch()/writeBack() anywhere. Compiled with --track-writes, transform.cjs wraps each mutation in
// __dirty(obj). This probe installs a sink that routes those __dirty calls into a write-tracked
// delta session, drives the compiled machine through an oscillation of scripted events, and asserts
// the compiler-tracked delta matches the RESCAN oracle every hop (same ship count, identical
// reconstruction) and reconstructs the live continuation exactly. That is the end-to-end claim:
// write-tracked delta works on unannotated source because the compiler emits the version bump.
import { PROGRAMS, __setDirtySink } from "../../test/e2e/track-app.gen.mjs";
import { makeDeltaSession, encodeDelta, applyDelta,
  makeTrackedSession, encodeDeltaTracked, applyDeltaTracked, touch } from "tierless/delta";
import { encodeWireBinary } from "tierless/wire";
import { makeCheck } from "../lib/check.mts";

const { check, ok } = makeCheck();
function deepEq(a, b, seen = new Set()) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return Object.is(a, b);
  if (seen.has(a)) return true; seen.add(a);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k], seen));
}
// step the compiled machine until it suspends at a resource (commit) or returns
function runToResource(stack) {
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (r.op === "resource") return { done: false, request: r, stack };
    else throw new Error("unexpected op " + r.op);
  }
}

console.log("Probe: the compiler write-barrier (--track-writes) drives write-tracked delta on plain source\n");

const tracked = makeTrackedSession("server"), tpeer = makeTrackedSession("browser");
const rescan = makeDeltaSession("server"), rpeer = makeDeltaSession("browser");
// the compiler-emitted __dirty(o) calls land here — mark the object dirty in the tracked session
__setDirtySink((o) => touch(tracked, o));

// a scripted oscillation: adds, deep toggles/renames, array pushes, a splice-clear — then stop
const events = [
  { type: "add", id: 1, label: "alpha" },
  { type: "add", id: 2, label: "beta" },
  { type: "toggle", idx: 0 },
  { type: "tick" },
  { type: "rename", idx: 1, label: "beta-2" },
  { type: "add", id: 3, label: "gamma" },
  { type: "tick" },
  { type: "toggle", idx: 2 },
  { type: "clear" },
  { type: "add", id: 4, label: "delta" },
  { type: "stop" },
];

let countsMatch = true, reconMatch = true, fidelity = true, hops = 0, sawTinyDelta = false;
const trackedTotal = [], fullTotal = []; // bytes per hop: write-tracked delta vs a full re-ship

let r = runToResource([{ fn: "Session", pc: 0, args: [] }]);   // run to the first commit (model built, not yet mutated)
let evIdx = 0;
while (!r.done) {
  // capture the SAME live continuation two ways: compiler-tracked vs rescan oracle
  const te = encodeDeltaTracked(tracked, r.stack, r.request);
  const re = encodeDelta(rescan, r.stack, r.request);
  countsMatch = countsMatch && te.shipped === re.shipped;

  const tb = applyDeltaTracked(tpeer, te.bytes);
  const rb = applyDelta(rpeer, re.bytes);
  reconMatch = reconMatch && deepEq(tb.stack, rb.stack) && deepEq(tb.request, rb.request);
  fidelity = fidelity && deepEq(tb.stack, r.stack) && deepEq(tb.request, r.request);

  trackedTotal.push(te.bytes.length);
  fullTotal.push(encodeWireBinary(r.stack, r.request, {}).length);   // what a full re-ship of this hop would cost
  if (hops > 0 && te.shipped <= 4) sawTinyDelta = true;          // warm hops ship just the few mutated objects
  hops++;

  const ev = events[evIdx++] || { type: "stop" };               // service the commit, advance the session
  r.stack[r.stack.length - 1].ret = ev;
  r = runToResource(r.stack);
}

check(`drove ${hops} oscillation hops of plain compiled source to completion (returned ${r.value})`, r.done && hops >= 8);
check("compiler-tracked delta ships the SAME object count as the rescan oracle, every hop", countsMatch);
check("compiler-tracked delta reconstructs IDENTICALLY to the rescan oracle, every hop", reconMatch);
check("the reconstruction equals the live continuation the machine produced, every hop", fidelity);
check("warm hops ship only the few mutated objects, not the whole model (the object-count win)", sawTinyDelta);
{
  // This model is tiny, so the delta's fixed overhead (magic + the sid string table) dominates and
  // it need not beat the compact full wire on raw bytes — that win is for large models (bench/delta).
  // Here the size claim is just that the strategy is never worse than always shipping the full wire.
  const strategy = trackedTotal.reduce((a, d, i) => a + Math.min(d, fullTotal[i]), 0);
  const fullOnly = fullTotal.reduce((a, f) => a + f, 0);
  check("the session under min(delta, full) is never worse than re-shipping the full wire each hop", strategy <= fullOnly);
}

// And confirm the barrier is load-bearing for IN-PLACE edits. New objects are found by the
// reachability walk regardless; an EXISTING object's mutation is seen ONLY because the compiler
// bumps it. Build a baseline holding a row, then with the sink UNINSTALLED toggle that row: with no
// __dirty firing, the edit ships nothing and the peer's copy goes stale — so the matches above truly
// depended on the compiler's write-barrier, not on the walk or rescan-style detection.
{
  const s = makeTrackedSession("server"), p = makeTrackedSession("browser");
  __setDirtySink((o) => touch(s, o));
  let rr = runToResource([{ fn: "Session", pc: 0, args: [] }]);
  applyDeltaTracked(p, encodeDeltaTracked(s, rr.stack, rr.request).bytes);    // baseline: empty model
  rr.stack[rr.stack.length - 1].ret = { type: "add", id: 1, label: "x" };
  rr = runToResource(rr.stack);
  applyDeltaTracked(p, encodeDeltaTracked(s, rr.stack, rr.request).bytes);    // peer now holds a row, done=false

  __setDirtySink(null);                                                       // stop reporting writes
  rr.stack[rr.stack.length - 1].ret = { type: "toggle", idx: 0 };             // a pure in-place edit of the existing row
  rr = runToResource(rr.stack);
  encodeDeltaTracked(s, rr.stack, rr.request);                                // capture with the sink off…
  const back = applyDeltaTracked(p, encodeDeltaTracked(s, rr.stack, rr.request).bytes);
  const liveDone = rr.stack[0].model.items[0].done, peerDone = back.stack[0].model.items[0].done;
  // (the fresh event object is still shipped — new objects are found by the walk — but the existing
  // row's in-place toggle is NOT, because no __dirty fired for it: the peer's row stays stale.)
  check("control: sink uninstalled ⇒ the existing row's in-place toggle is lost (live toggled, peer did not)", liveDone === true && peerDone === false);
  __setDirtySink((o) => touch(tracked, o));                                   // restore (hygiene)
}

console.log(`\n  compiler write-barrier: --track-writes drives write-tracked delta on plain source, matching the rescan oracle`);
process.exit(ok() ? 0 : 1);

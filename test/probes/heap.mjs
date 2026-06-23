// Probe: does our continuation wire format survive a real heap? (Layer-2 de-risk)
//
// The demos only ever captured cursor-shaped state (ints, flat arrays). A real
// TS continuation holds locals that point into an object graph with sharing,
// mutation, and cycles. This feeds our ACTUAL serializer (serializeContinuation
// + the JSON transport the two-process demo uses) those cases and reports what
// breaks. It is meant to FAIL — it documents exactly what the heap work fixes.

import { serializeContinuation, deserializeContinuation, Tier } from "#stackmix/runtime/core.mjs";

const tier = new Tier("server", {});
const ship = (locals) => {
  // exactly what the two-process path does: encode -> JSON bytes -> parse -> decode
  const wire = serializeContinuation({ frames: [{ fn: "f", ip: 0, locals, stack: [] }], pending: null }, tier);
  const json = JSON.stringify(wire);
  return { back: deserializeContinuation(JSON.parse(json)), bytes: Buffer.byteLength(json) };
};

console.log("Probe: continuation wire format vs. a real heap\n");

// 1) Aliasing / object identity -------------------------------------------------
const shared = { id: 1, label: "shared" };
const { back: r1 } = ship([shared, shared]);            // two locals, same object
const a = r1.frames[0].locals[0], b = r1.frames[0].locals[1];
console.log(`1. aliasing: two locals point at the SAME object`);
console.log(`   after migration, still the same object?  ${a === b ? "YES" : "NO — split into two copies"}`);
console.log(`   => mutating one no longer affects the other; === breaks.\n`);

// 2) Cycles ---------------------------------------------------------------------
const node = { id: 1 }; node.self = node;               // the most ordinary cyclic graph
console.log(`2. cycle: node.self = node`);
try { ship([node]); console.log("   serialized OK"); }
catch (e) { console.log(`   serialize THREW -> ${e.constructor.name}: ${String(e.message).slice(0, 48)}...`); }
console.log(`   => any doubly-linked / parent-pointer / DOM-ish graph crashes the wire.\n`);

// 3) Size: a local that references a graph --------------------------------------
function tree(n, b = 4) {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: i, payload: "x".repeat(40), kids: [] }));
  for (let i = 1; i < n; i++) nodes[Math.floor((i - 1) / b)].kids.push(nodes[i]); // root reaches all
  return nodes[0];
}
for (const n of [50, 5000]) {
  const { bytes, back } = ship([tree(n)]);
  const isHandle = back.frames[0].locals[0]?.__stackmix_handle__ === true;
  console.log(`3. local references a ${n}-node graph: continuation = ${bytes} B` +
    (isHandle ? "  (became a §5 handle — graph stayed tier-local)" : "  (whole graph inlined into the continuation)"));
}
console.log(`   => small continuation only holds if we DON'T ship the graph; but then the`);
console.log(`      other tier has a handle it cannot traverse (cross-process deref unbuilt).`);

// ============================================================================
// SECTION B — the same cases through the identity/cycle-safe graph codec.
// ============================================================================
import { encodeGraph, decodeGraph, isHandle } from "#stackmix/runtime/heap.mjs";
const roundtrip = (values, opts) => decodeGraph(JSON.parse(JSON.stringify(encodeGraph(values, opts))));

console.log(`\n--- with the graph codec (stackmix-heap.mjs) ---\n`);
let pass = true;
const check = (name, cond) => { console.log(`   ${cond ? "PASS" : "FAIL"}  ${name}`); pass &&= cond; };

// 1) aliasing
const s2 = { id: 1, label: "shared" };
const [x, y] = roundtrip([s2, s2]);
check("aliasing: two locals stay the SAME object (identity preserved)", x === y);
x.label = "mutated";
check("aliasing: mutating via one local is visible via the other", y.label === "mutated");

// 2) cycle
const n2 = { id: 1 }; n2.self = n2;
let cyc = false, cycRef = false;
try { const [r] = roundtrip([n2]); cyc = true; cycRef = r.self === r; } catch { /* threw */ }
check("cycle: node.self = node round-trips without throwing", cyc);
check("cycle: the self-reference is restored (r.self === r)", cycRef);

// 3) size: big subgraph -> handle (tier-local); small -> shipped whole and usable
const tierB = new Tier("server", {});
const bigEnc = encodeGraph([tree(5000)], { tier: tierB });
const [bigBack] = decodeGraph(JSON.parse(JSON.stringify(bigEnc)));
check("big graph (5000 nodes) -> handle, NOT shipped (continuation stays small)",
  isHandle(bigBack) && Buffer.byteLength(JSON.stringify(bigEnc)) < 1024);
const [smallBack] = roundtrip([tree(50)], { tier: tierB });
const count = (r, seen = new Set()) => { if (!r || seen.has(r)) return 0; seen.add(r); return 1 + r.kids.reduce((s, k) => s + count(k, seen), 0); };
check("small graph (50 nodes) -> shipped whole and fully traversable", count(smallBack) === 50);

// 4) undefined survives
check("undefined local survives the round trip", roundtrip([undefined])[0] === undefined);

// 5) BigInt survives (not JSON-safe natively; codec encodes it as a string)
const [bi] = roundtrip([{ n: 9007199254740993n, arr: [1n, 2n] }]);
check("BigInt survives the round trip (exact, > MAX_SAFE_INTEGER)", bi.n === 9007199254740993n && bi.arr[1] === 2n);

console.log(`\nSection B: ${pass ? "all PASS" : "FAILURES"} — identity, cycles, big-vs-small all handled at the codec level.`);
console.log(`Remaining for the heap de-risk: wire this codec into the runtime, and build`);
console.log(`real cross-tier fetch so a handle can be dereferenced on the other process.`);
if (!pass) process.exitCode = 1;

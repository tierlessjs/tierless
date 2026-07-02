// Probe: the continuation WIRE codec (src/graph.mjs) — identity, cycles, §5 excision.
//
// A real continuation holds locals that point into an object graph with sharing, cycles,
// and the occasional big subgraph. Naive per-value JSON loses object identity and throws
// on cycles; this asserts the graph codec handles all of it, plus the exotic value types
// (undefined, BigInt) that aren't JSON-native. The §5 layer (src/heap.mjs makeTier)
// supplies the tier whose heap a big subgraph excises into as a handle.
import { encodeGraph, decodeGraph, isHandle } from "stackmix/graph";
import { makeTier } from "stackmix/heap";

const roundtrip = (values, opts) => decodeGraph(JSON.parse(JSON.stringify(encodeGraph(values, opts))));
function tree(n, b = 4) {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: i, payload: "x".repeat(40), kids: [] }));
  for (let i = 1; i < n; i++) nodes[Math.floor((i - 1) / b)].kids.push(nodes[i]); // root reaches all
  return nodes[0];
}

let pass = true;
const check = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); pass = pass && cond; };
console.log("Probe: the continuation wire codec — identity, cycles, §5 excision, exotic values\n");

// 1) aliasing / object identity
const s = { id: 1, label: "shared" };
const [x, y] = roundtrip([s, s]);                         // two locals, the SAME object
check("aliasing: two locals stay the SAME object (identity preserved)", x === y);
x.label = "mutated";
check("aliasing: mutating via one local is visible via the other", y.label === "mutated");

// 2) cycle
const n = { id: 1 }; n.self = n;                          // the most ordinary cyclic graph
let cyc = false, cycRef = false;
try { const [r] = roundtrip([n]); cyc = true; cycRef = r.self === r; } catch { /* threw */ }
check("cycle: node.self = node round-trips without throwing", cyc);
check("cycle: the self-reference is restored (r.self === r)", cycRef);

// 3) big subgraph -> §5 handle (stays tier-local); small -> shipped whole and traversable
const tier = makeTier("server");
const bigEnc = encodeGraph([tree(5000)], { tier });
const [bigBack] = decodeGraph(JSON.parse(JSON.stringify(bigEnc)));
check("big graph (5000 nodes) -> §5 handle, NOT shipped (continuation stays small)",
  isHandle(bigBack) && Buffer.byteLength(JSON.stringify(bigEnc)) < 1024);
const [smallBack] = roundtrip([tree(50)], { tier });
const count = (r, seen = new Set()) => { if (!r || seen.has(r)) return 0; seen.add(r); return 1 + r.kids.reduce((a, k) => a + count(k, seen), 0); };
check("small graph (50 nodes) -> shipped whole and fully traversable", count(smallBack) === 50);

// 4) exotic values that aren't JSON-native
check("undefined local survives the round trip", roundtrip([undefined])[0] === undefined);
const [bi] = roundtrip([{ n: 9007199254740993n, arr: [1n, 2n] }]);
check("BigInt survives exactly (> MAX_SAFE_INTEGER)", bi.n === 9007199254740993n && bi.arr[1] === 2n);

console.log(`\n${pass ? "PASS" : "FAIL"} — wire codec: identity, cycles, big-vs-small excision, exotic values all handled`);
process.exit(pass ? 0 : 1);

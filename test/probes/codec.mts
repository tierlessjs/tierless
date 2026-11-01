// Probe: the continuation WIRE codec (src/graph.mjs) — identity, cycles, §5 excision.
//
// A real continuation holds locals that point into an object graph with sharing, cycles,
// and the occasional big subgraph. Naive per-value JSON loses object identity and throws
// on cycles; this asserts the graph codec handles all of it, plus the exotic value types
// (undefined, BigInt) that aren't JSON-native. The §5 layer (src/heap.mjs makeTier)
// supplies the tier whose heap a big subgraph excises into as a handle.
import { encodeGraph, decodeGraph, isHandle, shareFunction, VIEW } from "tierless/graph";
import { makeTier } from "tierless/heap";
import { makeCheck } from "../lib/check.mts";

// encodeGraph/decodeGraph are generic over any JSON-like value (unknown in, unknown out) —
// this probe exercises that genericity directly, so the round-tripped values are cast at
// each use to the ad hoc shape this probe put in, not narrowed by the codec itself.
const roundtrip = (values: unknown[], opts?: Parameters<typeof encodeGraph>[1]): any[] => decodeGraph(JSON.parse(JSON.stringify(encodeGraph(values, opts))));
interface TreeNode { id: number; payload: string; kids: TreeNode[] }
function tree(n: number, b = 4): TreeNode {
  const nodes: TreeNode[] = Array.from({ length: n }, (_, i) => ({ id: i, payload: "x".repeat(40), kids: [] }));
  for (let i = 1; i < n; i++) nodes[Math.floor((i - 1) / b)].kids.push(nodes[i]); // root reaches all
  return nodes[0];
}

const { check, ok } = makeCheck();
console.log("Probe: the continuation wire codec — identity, cycles, §5 excision, exotic values\n");

// 1) aliasing / object identity
const s = { id: 1, label: "shared" };
const [x, y] = roundtrip([s, s]);                         // two locals, the SAME object
check("aliasing: two locals stay the SAME object (identity preserved)", x === y);
x.label = "mutated";
check("aliasing: mutating via one local is visible via the other", y.label === "mutated");

// 2) cycle
const n = { id: 1, self: null as unknown }; n.self = n;   // the most ordinary cyclic graph
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
const count = (r: TreeNode, seen = new Set<TreeNode>()): number => { if (!r || seen.has(r)) return 0; seen.add(r); return 1 + r.kids.reduce((a, k) => a + count(k, seen), 0); };
check("small graph (50 nodes) -> shipped whole and fully traversable", count(smallBack) === 50);

// 4) exotic values that aren't JSON-native
check("undefined local survives the round trip", roundtrip([undefined])[0] === undefined);
const [bi] = roundtrip([{ n: 9007199254740993n, arr: [1n, 2n] }]);
check("BigInt survives exactly (> MAX_SAFE_INTEGER)", bi.n === 9007199254740993n && bi.arr[1] === 2n);

// views: an ownership-excised plain object (a closure's caps) decodes off-tier as a view —
// primitives by value, other members as member handles — and goes home as its handle
{
  class Api { realm = "r1"; go(): void { /* behavior */ } }
  (Api.prototype as unknown as { __tierless_cls: string }).__tierless_cls = "Api";
  const home = makeTier("browser");
  const conv = (o: object): object => ({ ...o, converted: true });   // a pure helper, shared by name
  shareFunction("conv", conv);
  const caps = { id: "f1", n: 3, on: true, nil: null, gone: undefined, t: (k: string) => k, form: { a: 1, deep: { b: "x", list: [1] } }, api: new Api(), conv };
  const enc = encodeGraph([caps], { tier: home, excise: (v) => v === caps });
  const [view] = decodeGraph(JSON.parse(JSON.stringify(enc)), { tier: makeTier("server") }) as any[];
  check("view: primitive members arrive as values", view.id === "f1" && view.n === 3 && view.on === true && view.nil === null && !("gone" in view));
  check("view: a function member arrives as a member handle of the caps' handle", isHandle(view.t) && view.t.path?.join() === "t");
  check("view: a plain object member arrives as a nested view — primitives in place, deeper levels too, an array a nested view of its own",
    !isHandle(view.form) && view.form.a === 1 && view.form.deep.b === "x" && Array.isArray(view.form.deep.list) && view.form.deep.list[0] === 1 && view.form.deep.list[VIEW].path?.join() === "form,deep,list");
  check("view: a shared function arrives as this tier's own copy", view.conv === conv);
  check("view: a stamped member arrives as a nested INSTANCE view — its class on the view's handle, data readable, its prototype method absent (a read of it parks home)",
    !isHandle(view.api) && view.api[VIEW].cls === "Api" && view.api[VIEW].inst === true && view.api.realm === "r1" && !("go" in view.api));
  const back = encodeGraph([view, view.form, view.form.deep, view.form.deep.list, view.t], { tier: makeTier("server") });
  const [homeCaps, homeForm, homeDeep, homeList, homeT] = decodeGraph(JSON.parse(JSON.stringify(back)), { tier: home }) as any[];
  check("view: going home it decodes to the LIVE object, a nested view (an array too) to the live member, a member handle to the live member",
    homeCaps === caps && homeForm === caps.form && homeDeep === caps.form.deep && homeList === caps.form.deep.list && homeT === caps.t);
  const [sized] = decodeGraph(JSON.parse(JSON.stringify(encodeGraph([{ big: caps, small: 1 }], { tier: home, threshold: 16 }))), { tier: makeTier("server") }) as any[];
  check("view: an object excised only for SIZE ships no view (its contents are the point of keeping it home)", isHandle(sized));
  const [budget] = decodeGraph(JSON.parse(JSON.stringify(encodeGraph([{ big: caps, small: 1 }], { tier: home, threshold: 48, excise: (v) => v !== null && typeof v === "object" && "big" in (v as object) }))), { tier: makeTier("server") }) as any[];
  check("view: within the byte budget — a member over it is a member handle, a small one is read in place", isHandle(budget.big) && budget.small === 1);
}

console.log(`\n${ok() ? "PASS" : "FAIL"} — wire codec: identity, cycles, big-vs-small excision, exotic values all handled`);
process.exit(ok() ? 0 : 1);

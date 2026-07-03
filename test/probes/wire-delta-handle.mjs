// Probe: §5 handle excision COMPOSED with the delta wire. The framework's two core moves are "ship
// only the small continuation" (the delta wire — only what changed) and "big data stays home" (the §5
// heap — a big subgraph excises to a handle, fetched only on deref). This proves they compose: a
// continuation with a big dataset + a small UI excises the dataset to a handle in the DELTA path, so
// the big data never crosses (it's a leaf the delta ships once), and only the UI changes ride each
// hop. Deref still works (the data is in the owning tier's heap); the handle is stable across a bounce.
import { makeTrackedSession, encodeDeltaTracked, applyDeltaTracked, touch } from "tierless/delta";
import { isHandle } from "tierless/graph";
import { makeTier } from "tierless/heap";
import { makeCheck } from "../lib/check.mts";

const { check, ok } = makeCheck();
const fmt = (n) => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB");
console.log("Probe: §5 handle excision composed with the delta wire — big data stays home, UI ships as deltas\n");

const tier = makeTier("server");
const bigData = { rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, title: "Article " + i, body: "lorem ".repeat(12) })) };
const mk = () => [{ fn: "Board", pc: 1, data: bigData, alsoData: bigData, ui: { filter: "all", page: 0, sel: -1 } }];

// what the continuation costs shipped INLINE (no excision), for comparison
const inline = encodeDeltaTracked(makeTrackedSession("x"), mk(), null).bytes.length;

// ---------------------------------------------------------------------------------------------
// 1) COLD hop with excision — the big dataset stays home as a handle; only the small UI crosses.
// ---------------------------------------------------------------------------------------------
const A = makeTrackedSession("server"), B = makeTrackedSession("browser");
const live = mk();
const c1 = encodeDeltaTracked(A, live, null, { tier, threshold: 8192 });
const { stack: s1 } = applyDeltaTracked(B, c1.bytes);
check(`the cold capture is tiny — the dataset did NOT cross (${fmt(c1.bytes.length)} vs ${fmt(inline)} inline)`, c1.bytes.length * 20 < inline);
check("the big dataset arrives on the peer as a §5 handle leaf, not 2000 rows", isHandle(s1[0].data) && s1[0].data.owner === tier.id);
check("the small UI rode along inline (filter/page/sel present)", s1[0].ui && s1[0].ui.filter === "all" && s1[0].ui.page === 0);
check("two locals aliasing the SAME dataset excise to ONE handle (shared identity preserved)", s1[0].data === s1[0].alsoData);

// ---------------------------------------------------------------------------------------------
// 2) DEREF — the real data is in the owning tier's heap, fetched only when the peer touches it.
// (In a live run this fetch crosses the socket; heap-live proves that. Here the heap is the master.)
// ---------------------------------------------------------------------------------------------
const fetched = tier.heapGet(s1[0].data.id);
check("deref: the handle resolves to the real dataset in the server heap (2000 rows, intact)",
  fetched && fetched.rows.length === 2000 && fetched.rows[1999].title === "Article 1999");

// ---------------------------------------------------------------------------------------------
// 3) OSCILLATION — mutate only the UI each hop; the handle ships ONCE, the warm deltas stay tiny.
// ---------------------------------------------------------------------------------------------
let maxWarm = 0, handleReshipped = false, hops = 0;
for (let hop = 0; hop < 10; hop++) {
  live[0].ui.page = hop; live[0].ui.sel = hop % 5; touch(A, live[0].ui);
  const c = encodeDeltaTracked(A, live, null, { tier, threshold: 8192 });
  const { stack: s } = applyDeltaTracked(B, c.bytes);
  if (c.shipped > 2) handleReshipped = true;                 // only the UI object should ship (+ maybe a frame)
  maxWarm = Math.max(maxWarm, c.bytes.length);
  if (!(isHandle(s[0].data) && s[0].data.id === s1[0].data.id)) handleReshipped = true;
  hops++;
}
check(`every warm hop ships only the UI (the handle was never re-shipped over ${hops} hops)`, !handleReshipped);
check(`the warm deltas stayed tiny and flat — proportional to the UI change, not the dataset (max ${maxWarm} B)`, maxWarm < 120);

// ---------------------------------------------------------------------------------------------
// 4) BOUNCE — the handle survives a round trip (browser mutates + ships back; data still home).
// ---------------------------------------------------------------------------------------------
s1[0].ui.filter = "active"; touch(B, s1[0].ui);              // the browser edits the UI it holds
const back = encodeDeltaTracked(B, s1, null, { tier, threshold: 8192 });
const { stack: onA } = applyDeltaTracked(A, back.bytes);
check("bounce: the browser's return delta is tiny and carries the handle, not the data", back.bytes.length < 160 && isHandle(onA[0].data));
check("bounce: the dataset never left the server heap — deref on the way back still resolves it",
  onA[0].data.id === s1[0].data.id && tier.heapGet(onA[0].data.id).rows.length === 2000);
check("bounce: the browser's UI edit arrived on the server (filter = active)", onA[0].ui.filter === "active");

console.log(`\n  delta + §5 handle: the dataset stayed home as a handle while only UI deltas crossed — the two wire optimizations compose`);
process.exit(ok() ? 0 : 1);

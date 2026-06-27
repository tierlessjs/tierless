// How much overhead does Stackmix introduce? Two sources, isolated and measured:
//   A) state-machine CPU tax — the compiled while/switch machine vs the plain function,
//      run entirely on one tier (the resource is owned locally, so NO migration: this is
//      pure dispatch + frame-object cost, nothing else).
//   B) serialization cost — encode+decode of the continuation per crossing, vs working-set
//      size, plus the §5-handle effect that keeps the wire flat when the data is big.
//
//   node bench/overhead.mjs
import { PROGRAMS } from "./overhead.gen.mjs";
import { encodeWire, decodeWire, makeTier } from "../src/heap.mjs";

const SEED = 12345;
const fmt = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");

// --- the plain baseline: byte-identical loop to overhead.src.js (asserted equal below) ---
function churnPlain(n, seed) {
  let acc = seed;
  for (let i = 0; i < n; i = i + 1) {
    acc = (acc * 1103515245 + 12345) & 0x7fffffff;
    if (acc % 7 === 0) acc = acc + i;
  }
  return acc;
}

// --- a minimal single-tier pump: owns api.seed, runs everything inline (no migration) ---
function drive(fn, n) {
  const stack = [{ fn, pc: 0, args: [n] }];
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return r.value; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else stack[stack.length - 1].ret = SEED;   // api.seed, owned here -> inline, no serialize
  }
}

// best-of-batches ns/call (min suppresses GC/scheduler noise — standard for microbench)
function nsPerCall(thunk, iters, batches = 8) {
  for (let i = 0; i < 3; i++) thunk();                                   // warm the JIT
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) thunk();
    const t1 = process.hrtime.bigint();
    best = Math.min(best, Number(t1 - t0) / iters);
  }
  return best;
}

console.log("Stackmix overhead — isolated and measured\n");

// ============================ A) state-machine CPU tax ============================
console.log("A) state-machine CPU tax (compiled machine vs plain function, one tier, no migration)\n");
console.log("   workload: a tight LCG loop (~5 ops/iter). Worst case = loop inside the suspendable");
console.log("   function (compiles to a per-iteration machine); realistic = loop factored into a");
console.log("   pure helper (emitted native). Lower is better; ratio is compiled ÷ plain.\n");
console.log("        n      plain      realistic            worst (loop in machine)");
for (const n of [1000, 10000, 100000]) {
  // correctness gate: the compiled machines compute EXACTLY the plain result
  const want = churnPlain(n, SEED);
  if (drive("realistic", n) !== want || drive("worst", n) !== want) { console.error("MISMATCH at n=" + n); process.exit(1); }
  const iters = Math.max(20, Math.round(2e7 / n));
  const plain = nsPerCall(() => churnPlain(n, SEED), iters);
  const real = nsPerCall(() => drive("realistic", n), iters);
  const worst = nsPerCall(() => drive("worst", n), iters);
  const us = (x) => (x / 1000).toFixed(1).padStart(8) + " µs";
  console.log(`   ${String(n).padStart(7)}  ${us(plain)}  ${us(real)} (${(real / plain).toFixed(2)}x)   ${us(worst)} (${(worst / plain).toFixed(1)}x)`);
}
console.log("\n   Read: 'realistic' ≈ 1x — factoring a hot loop into a pure helper costs ~nothing, because");
console.log("   the transform emits pure functions verbatim. The tax only appears when a hot loop is");
console.log("   trapped inside a suspendable function ('worst'), and even then it's a constant factor on");
console.log("   work that, in a real app, is gated by the I/O it's orchestrating.\n");

// ============================ B) serialization cost ============================
console.log("B) serialization cost per migration (encode + decode of the continuation wire)\n");
console.log("   A continuation carrying N live records that genuinely must travel. Lower is better.\n");
console.log("        N       wire bytes     bytes/rec     encode+decode     per record");
for (const N of [10, 100, 1000, 10000]) {
  const rows = Array.from({ length: N }, (_, i) => ({ id: i, title: "row " + i, score: i % 100, done: i % 2 === 0 }));
  const stack = [{ fn: "View", pc: 3, rows, filter: "all", args: [] }];
  const req = { op: "resource", tier: "browser", name: "dom.commit", args: [{ n: N }] };
  const wire = encodeWire(stack, req, {});                               // inline: the records travel
  const iters = Math.max(20, Math.round(2e6 / N));
  const ns = nsPerCall(() => decodeWire(encodeWire(stack, req, {})), iters);
  console.log(`   ${String(N).padStart(7)}  ${fmt(wire.length).padStart(12)}  ${(wire.length / N).toFixed(0).padStart(8)} B   ${((ns) / 1000).toFixed(1).padStart(10)} µs   ${(ns / N).toFixed(0).padStart(8)} ns`);
}

// the §5-handle effect: a BIG dataset stays home, so the wire (and its cost) stays flat
const body = "x".repeat(700);                                           // ~0.75 KB/row
const big = Array.from({ length: 1500 }, (_, i) => ({ id: i, title: "row " + i, body }));
const bigStack = [{ fn: "View", pc: 3, dataset: big, filter: "all", args: [] }];
const bigReq = { op: "resource", tier: "browser", name: "dom.commit", args: [{ n: 1500 }] };
const inlineBytes = encodeWire(bigStack, bigReq, {}).length;
const handleBytes = encodeWire(bigStack, bigReq, { tier: makeTier("server"), threshold: 8192 }).length;
console.log(`\n   §5 handle: a ${fmt(inlineBytes)} dataset that ISN'T all live travels as a ${fmt(handleBytes)} handle`);
console.log(`   (${(inlineBytes / handleBytes).toFixed(0)}x smaller) — so serialization overhead does NOT grow with data the`);
console.log(`   migrated code doesn't touch. That is the design's whole point: stack < heap.\n`);

console.log("Bottom line: the overhead is (A) a constant-factor CPU tax that's ~0 for well-factored code");
console.log("and bounded even when not, plus (B) ~linear serialization in the LIVE working set only — which");
console.log("the §5 handle keeps small. None of it scales with the data you leave home.");

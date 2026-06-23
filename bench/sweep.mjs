// Stackmix — HN benchmark scale curve.
//
//   node bench-sweep.mjs        (writes bench-sweep.csv)
//
// Turns the single 2x2 data point into curves: as the thread grows, the naive
// REST client's round trips grow O(nodes), a hand-tuned parallel client's grow
// O(depth) (~log nodes), and Stackmix stays O(1) = 2 client round trips. A second
// sweep varies RTT to show Stackmix's advantage widening as the network slows.

import { writeFileSync } from "node:fs";
import { genThread, runStrategy, idSeq, DEFAULT_RTT, DEFAULT_API } from "./core.mjs";

const ms = (x) => (x >= 1000 ? (x / 1000).toFixed(1) + "s" : Math.round(x) + "ms");

async function measure(thread, { rtt, api }) {
  const rest = await runStrategy("fetch",   "loadThread",           thread, { rtt, api }); // O(nodes)
  const tuned = await runStrategy("fetch",   "loadThreadConcurrent", thread, { rtt, api }); // O(depth)
  const stackmix = await runStrategy("migrate", "loadThreadConcurrent", thread, { rtt, api }); // O(1)
  const ok = idSeq(rest.value) === idSeq(tuned.value) && idSeq(rest.value) === idSeq(stackmix.value);
  return { rest, tuned, stackmix, ok };
}

// --- Sweep 1: thread size (fixed RTT) --------------------------------------
const SIZES = [10, 30, 100, 300, 1000, 3000, 10000];
console.log(`Scale curve — varying thread size at ${DEFAULT_RTT}ms RTT, ${DEFAULT_API}ms server/API round\n`);
console.log("  nodes  depth │   REST (naive)      parallel client    Stackmix (migrate)  │  vs REST   vs client");
console.log("  ───────────────────────────────────────────────────────────────────────────────────────────");

const csv = [["nodes", "depth", "rest_rt", "rest_ms", "client_rt", "client_ms", "stackmix_rt", "stackmix_ms", "speedup_vs_rest", "speedup_vs_client"]];
let allOk = true;
for (const n of SIZES) {
  const thread = genThread(n);
  const { rest, tuned, stackmix, ok } = await measure(thread, { rtt: DEFAULT_RTT, api: DEFAULT_API });
  allOk &&= ok;
  const vRest = (rest.latency / stackmix.latency), vClient = (tuned.latency / stackmix.latency);
  console.log(
    `  ${String(n).padStart(5)}  ${String(thread.depth).padStart(5)} │ ` +
    `${(rest.hops + "rt").padStart(7)} ${ms(rest.latency).padStart(7)}  ` +
    `${(tuned.hops + "rt").padStart(5)} ${ms(tuned.latency).padStart(7)}  ` +
    `${(stackmix.hops + "rt").padStart(4)} ${ms(stackmix.latency).padStart(7)} │ ` +
    `${(vRest.toFixed(0) + "x").padStart(7)}  ${(vClient.toFixed(1) + "x").padStart(8)}`
  );
  csv.push([n, thread.depth, rest.hops, rest.latency, tuned.hops, tuned.latency, stackmix.hops, stackmix.latency, vRest.toFixed(2), vClient.toFixed(2)]);
}

console.log("\n  REST round trips grow O(nodes); parallel-client O(depth)~log(nodes); Stackmix stays 2.");
console.log("  Stackmix's win vs naive grows without bound; vs the optimal client it holds at ~depth/2.");

// --- Sweep 2: RTT (fixed thread size) --------------------------------------
const FIXED_N = 1000;
const thread = genThread(FIXED_N);
const RTTS = [5, 25, 50, 150, 300];
console.log(`\nLatency sensitivity — fixed ${FIXED_N}-node thread (depth ${thread.depth}), varying RTT\n`);
console.log("    RTT │   REST (naive)   parallel client   Stackmix (migrate) │  vs REST   vs client");
console.log("    ──────────────────────────────────────────────────────────────────────────────");
for (const rtt of RTTS) {
  const { rest, tuned, stackmix } = await measure(thread, { rtt, api: DEFAULT_API });
  console.log(
    `  ${(rtt + "ms").padStart(5)} │ ${ms(rest.latency).padStart(8)}      ${ms(tuned.latency).padStart(8)}     ${ms(stackmix.latency).padStart(8)} │ ` +
    `${((rest.latency / stackmix.latency).toFixed(0) + "x").padStart(7)}  ${((tuned.latency / stackmix.latency).toFixed(1) + "x").padStart(8)}`
  );
}
console.log("\n  Stackmix's advantage widens as the network slows: its cost is ~constant in RTT (2 hops),");
console.log("  while both client strategies scale linearly with RTT.");

writeFileSync("bench-sweep.csv", csv.map((r) => r.join(",")).join("\n") + "\n");
console.log(`\nWrote bench-sweep.csv (${csv.length - 1} rows). Correctness across all sizes: ${allOk ? "YES" : "NO"}`);
if (!allOk) process.exitCode = 1;

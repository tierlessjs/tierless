// Stackmix — HN benchmark, single run (the concurrency x placement matrix).
//
//   node bench/hn.mjs            (modeled latency, instant)
//   node bench/hn.mjs --real     (inject real RTT sleeps -> genuine wall-clock)
//
// The Hacker News thread is the canonical client-side waterfall: to load a
// thread you fetch the story, then each comment, then THEIR children — one
// dependent request per node, no "whole thread" API. We run the SAME traversal
// under the real runtime across a 2x2 of choices:
//
//                       per-item (sequential)     per-level (concurrent)
//   client (REST, stay)   fetch each node           fetch each level
//   Stackmix   (migrate)      migrate, loop on server   migrate, fan out on server
//
// Two independent levers: concurrency collapses round trips O(nodes)->O(depth);
// migration collapses the CLIENT round trips to 2, because once the traversal
// is on the server its per-level rounds are cheap server<->API hops. Stackmix wins
// even vs a hand-tuned parallel client, which still pays one RTT per tree level.

import { genThread, runMatrix, idSeq, DEFAULT_RTT, DEFAULT_API } from "./core.mjs";
import { fmt } from "#stackmix/runtime/core.mjs";

const REAL = process.argv.includes("--real");
const N = 254;
const thread = genThread(N);
const itemBytes = Buffer.byteLength(JSON.stringify(thread.store.get(1)));

const cells = await runMatrix(thread, { rtt: DEFAULT_RTT, api: DEFAULT_API, real: REAL });
const ok = Object.values(cells).every((c) => idSeq(c.value) === idSeq(cells.restSeq.value) && c.value.length === N);

console.log("Stackmix — HN thread load: concurrency x placement (same traversal, run on the runtime)\n");
console.log(`Thread: ${N} nodes, depth ${thread.depth}, ~${fmt(itemBytes)}/item (objects with string fields + nested kids)`);
console.log(`Network model: ${DEFAULT_RTT}ms client<->server RTT, ${DEFAULT_API}ms server<->API per round${REAL ? "  [REAL sleeps]" : "  [modeled]"}\n`);

const cell = (c) => `${(c.latency + "ms").padStart(8)} / ${String(c.hops).padStart(3)} rt`;
console.log("                       per-item (sequential)     per-level (concurrent)");
console.log(`  client (REST, stay)  ${cell(cells.restSeq).padEnd(24)}  ${cell(cells.restConc)}`);
console.log(`  Stackmix   (migrate)     ${cell(cells.stackmixSeq).padEnd(24)}  ${cell(cells.stackmixConc)}`);
console.log("");

const best = cells.stackmixConc, naive = cells.restSeq, tuned = cells.restConc;
console.log(`Two independent wins, both on the IDENTICAL traversal source:`);
console.log(`  concurrency : round trips O(nodes)=${naive.hops} -> O(depth)=${tuned.hops}`);
console.log(`  migration   : client round trips -> 2 (the per-level rounds move server-side)`);
console.log("");
console.log(`Stackmix (migrate + concurrent): ${best.latency}ms, ${best.hops} round trips`);
console.log(`  vs naive REST client         : ${naive.latency}ms  ->  ${(naive.latency / best.latency).toFixed(0)}x faster`);
console.log(`  vs hand-tuned parallel client: ${tuned.latency}ms  ->  ${(tuned.latency / best.latency).toFixed(1)}x faster`);
console.log(`  (it beats even the optimal client because the client still pays one`);
console.log(`   ${DEFAULT_RTT}ms RTT per tree level (${tuned.hops} levels); Stackmix pays 2 client RTTs total.)`);
if (REAL) console.log(`Wall clock (REAL): naive ${(naive.wall / 1000).toFixed(1)}s -> Stackmix ${(best.wall / 1000).toFixed(2)}s`);
console.log("");
console.log(`Same traversal source across all four cells; only placement & batching differ.`);
console.log(`The per-level concurrency assumes the server can fetch a level at once (concurrent`);
console.log(`queries / a batched IN) — which it can, co-located with the data; the public`);
console.log(`per-item API the client is stuck with cannot.`);
console.log(`Correctness: all four strategies returned identical ${N}-node threads? ${ok ? "YES" : "NO"}`);
if (!ok) process.exitCode = 1;

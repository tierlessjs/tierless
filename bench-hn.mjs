// Waso — HN benchmark kernel.
//
//   node bench-hn.mjs            (modeled latency, instant)
//   node bench-hn.mjs --real     (inject real RTT sleeps -> genuine wall-clock)
//
// The Hacker News thread is the canonical client-side waterfall: to load a
// thread you fetch the story, then each comment, then THEIR children — one
// request per node, each dependent on the previous result. The Firebase-style
// API has no "whole thread" call, so a client makes a deep sequential waterfall.
//
// We run the SAME traversal under the real runtime across a 2x2 of choices:
//
//                       per-item (sequential)     per-level (concurrent)
//   client (REST, stay)   fetch each node           fetch each level
//   Waso   (migrate)      migrate, loop on server   migrate, fan out on server
//
// Two independent levers:
//   - concurrency collapses round trips from O(nodes) to O(depth);
//   - migration collapses the *client* round trips to 2, because once the
//     traversal is on the server its per-level rounds are cheap server<->API
//     hops, not expensive client<->server RTTs.
// Waso (migrate + concurrent) wins even against a hand-tuned parallel client,
// because the client still pays one full RTT per tree level while Waso pays 2
// client RTTs total regardless of depth.

import {
  PROGRAM, run, Suspend, serializeContinuation, deserializeContinuation,
  contBytes, initialFrames, Tier, fmt,
} from "./waso-core.mjs";

function asm(lines) {
  const labels = {}, code = [];
  for (const l of lines) (typeof l === "string") ? (labels[l] = code.length) : code.push(l.slice());
  for (const ins of code)
    if ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string") ins[1] = labels[ins[1]];
  return code;
}

// --- sequential traversal: one api.item per node ----------------------------
//   function loadThread(rootId) {
//     const root = api.item(rootId);
//     const results = [root]; const queue = [...root.kids];
//     for (let head = 0; head < queue.length; head++) {
//       const c = api.item(queue[head]); results.push(c);
//       for (const k of c.kids) queue.push(k);
//     }
//     return results;
//   }
// locals: 0 rootId,1 root,2 results,3 queue,4 kids,5 j,6 head,7 cid,8 c
PROGRAM.loadThread = {
  nlocals: 9,
  code: asm([
    ["LOAD", 0], ["RES", "api.item", 1], ["STORE", 1],
    ["NEWARR"], ["STORE", 2], ["LOAD", 2], ["LOAD", 1], ["ARRPUSH"],
    ["NEWARR"], ["STORE", 3],
    ["LOAD", 1], ["GETPROP", "kids"], ["STORE", 4], ["PUSH", 0], ["STORE", 5],
    "cploop",
    ["LOAD", 5], ["LOAD", 4], ["GETPROP", "length"], ["BIN", "<"], ["JMPF", "cpend"],
    ["LOAD", 3], ["LOAD", 4], ["LOAD", 5], ["INDEX"], ["ARRPUSH"],
    ["LOAD", 5], ["PUSH", 1], ["BIN", "+"], ["STORE", 5], ["JMP", "cploop"],
    "cpend",
    ["PUSH", 0], ["STORE", 6],
    "loop",
    ["LOAD", 6], ["LOAD", 3], ["GETPROP", "length"], ["BIN", "<"], ["JMPF", "end"],
    ["LOAD", 3], ["LOAD", 6], ["INDEX"], ["STORE", 7],
    ["LOAD", 6], ["PUSH", 1], ["BIN", "+"], ["STORE", 6],
    ["LOAD", 7], ["RES", "api.item", 1], ["STORE", 8],
    ["LOAD", 2], ["LOAD", 8], ["ARRPUSH"],
    ["LOAD", 8], ["GETPROP", "kids"], ["STORE", 4], ["PUSH", 0], ["STORE", 5],
    "kloop",
    ["LOAD", 5], ["LOAD", 4], ["GETPROP", "length"], ["BIN", "<"], ["JMPF", "kend"],
    ["LOAD", 3], ["LOAD", 4], ["LOAD", 5], ["INDEX"], ["ARRPUSH"],
    ["LOAD", 5], ["PUSH", 1], ["BIN", "+"], ["STORE", 5], ["JMP", "kloop"],
    "kend",
    ["JMP", "loop"],
    "end",
    ["LOAD", 2], ["RET"],
  ]),
};

// --- concurrent traversal: one api.items(level) per tree level --------------
//   function loadThread(rootId) {
//     let level = [rootId]; const results = [];
//     while (level.length > 0) {
//       const items = api.items(level);   // fetch the whole level at once
//       const next = [];
//       for (const it of items) { results.push(it); for (const k of it.kids) next.push(k); }
//       level = next;
//     }
//     return results;
//   }
// locals: 0 rootId,1 level,2 results,3 items,4 next,5 i,6 it,7 kids,8 j
PROGRAM.loadThreadConcurrent = {
  nlocals: 9,
  code: asm([
    ["NEWARR"], ["STORE", 1], ["LOAD", 1], ["LOAD", 0], ["ARRPUSH"], // level = [rootId]
    ["NEWARR"], ["STORE", 2],                                        // results = []
    "wloop",
    ["LOAD", 1], ["GETPROP", "length"], ["PUSH", 0], ["BIN", ">"], ["JMPF", "wend"],
    ["LOAD", 1], ["RES", "api.items", 1], ["STORE", 3],              // items = api.items(level)
    ["NEWARR"], ["STORE", 4],                                        // next = []
    ["PUSH", 0], ["STORE", 5],
    "iloop",
    ["LOAD", 5], ["LOAD", 3], ["GETPROP", "length"], ["BIN", "<"], ["JMPF", "iend"],
    ["LOAD", 3], ["LOAD", 5], ["INDEX"], ["STORE", 6],               // it = items[i]
    ["LOAD", 2], ["LOAD", 6], ["ARRPUSH"],                           // results.push(it)
    ["LOAD", 6], ["GETPROP", "kids"], ["STORE", 7], ["PUSH", 0], ["STORE", 8],
    "jloop",
    ["LOAD", 8], ["LOAD", 7], ["GETPROP", "length"], ["BIN", "<"], ["JMPF", "jend"],
    ["LOAD", 4], ["LOAD", 7], ["LOAD", 8], ["INDEX"], ["ARRPUSH"],   // next.push(kids[j])
    ["LOAD", 8], ["PUSH", 1], ["BIN", "+"], ["STORE", 8], ["JMP", "jloop"],
    "jend",
    ["LOAD", 5], ["PUSH", 1], ["BIN", "+"], ["STORE", 5], ["JMP", "iloop"],
    "iend",
    ["LOAD", 4], ["STORE", 1],                                       // level = next
    ["JMP", "wloop"],
    "wend",
    ["LOAD", 2], ["RET"],
  ]),
};

// --- synthetic HN thread (objects with string fields + nested arrays) -------
function genThread(n, branching = 3) {
  const store = new Map();
  for (let id = 0; id < n; id++)
    store.set(id, { id, by: "user_" + id, text: `Comment ${id}. ` + "lorem ipsum dolor sit amet ".repeat(5), kids: [] });
  let next = 1, depth = 0;
  const level = new Map([[0, 0]]);
  const q = [0];
  while (next < n && q.length) {
    const parent = q.shift();
    for (let c = 0; c < branching && next < n; c++) {
      store.get(parent).kids.push(next);
      level.set(next, level.get(parent) + 1);
      depth = Math.max(depth, level.get(next));
      q.push(next); next++;
    }
  }
  return { rootId: 0, store, depth, count: n };
}

// --- network model ----------------------------------------------------------
const REAL = process.argv.includes("--real");
const RTT_MS = 50;   // client <-> server round trip (the latency that dominates)
const API_MS = 2;    // server <-> its API/DB per round, co-located (cheap)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the orchestrator: migrate vs fetch, on the real runtime ---------------
async function execute(entry, args, { startTier, tiers, policy, net }) {
  const host = { deref() { throw new Error("unexpected handle deref"); } };
  let current = startTier;
  let frames = initialFrames(entry, args);
  while (true) {
    let res;
    try { res = run(current, frames, host); }
    catch (e) {
      if (!(e instanceof Suspend)) throw e;
      const owner = tiers.find((t) => t.has(e.pending.name));
      if (!owner) throw new Error("no tier provides " + e.pending.name);
      if (policy === "migrate") {
        const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, current);
        net.hops++; net.bytes += contBytes(wire); if (REAL) await sleep(RTT_MS); // ship continuation
        const got = deserializeContinuation(wire);
        got.frames[got.frames.length - 1].stack.push(owner.resources[e.pending.name](got.pending.args));
        frames = got.frames; current = owner;          // and STAY (lazy placement)
      } else { // fetch: RPC one call, continuation stays put (the REST waterfall)
        const result = owner.resources[e.pending.name](e.pending.args);
        net.hops++;
        net.bytes += Buffer.byteLength(JSON.stringify(e.pending.args)) + Buffer.byteLength(JSON.stringify(result ?? null));
        if (REAL) await sleep(RTT_MS);
        e.frames[e.frames.length - 1].stack.push(result);
        frames = e.frames;
      }
      continue;
    }
    if (current !== startTier) { net.hops++; net.bytes += Buffer.byteLength(JSON.stringify(res.value)); if (REAL) await sleep(RTT_MS); }
    return res.value;
  }
}

async function runStrategy(policy, program, thread) {
  const net = { hops: 0, bytes: 0, calls: 0 };
  // Server owns both per-item and per-level reads (it's co-located with the data
  // and can fetch a level concurrently). The client owns nothing.
  const server = new Tier("server", {
    "api.item":  ([id])  => { net.calls++; return thread.store.get(id); },
    "api.items": ([ids]) => { net.calls++; return ids.map((id) => thread.store.get(id)); }, // one concurrent round
  });
  const client = new Tier("client", {});
  const t0 = performance.now();
  const value = await execute(program, [thread.rootId], { startTier: client, tiers: [server, client], policy, net });
  const wall = performance.now() - t0;
  // latency = client round trips * RTT  +  server read rounds * API_MS
  return { value, hops: net.hops, bytes: net.bytes, calls: net.calls, latency: net.hops * RTT_MS + net.calls * API_MS, wall };
}

// --- go ---------------------------------------------------------------------
const N = 254;
const thread = genThread(N);
const itemBytes = Buffer.byteLength(JSON.stringify(thread.store.get(1)));

const cells = {
  restSeq:  await runStrategy("fetch",   "loadThread",           thread), // client, per-item
  restConc: await runStrategy("fetch",   "loadThreadConcurrent", thread), // client, per-level
  wasoSeq:  await runStrategy("migrate", "loadThread",           thread), // migrate, per-item
  wasoConc: await runStrategy("migrate", "loadThreadConcurrent", thread), // migrate, per-level
};

const ids = (v) => v.map((it) => it.id).join(",");
const ok = Object.values(cells).every((c) => ids(c.value) === ids(cells.restSeq.value) && c.value.length === N);

console.log("Waso — HN thread load: concurrency x placement (same traversal, run on the runtime)\n");
console.log(`Thread: ${N} nodes, depth ${thread.depth}, ~${fmt(itemBytes)}/item (objects with string fields + nested kids)`);
console.log(`Network model: ${RTT_MS}ms client<->server RTT, ${API_MS}ms server<->API per round${REAL ? "  [REAL sleeps]" : "  [modeled]"}\n`);

const cell = (c) => `${(c.latency + "ms").padStart(8)} / ${String(c.hops).padStart(3)} rt`;
console.log("                       per-item (sequential)     per-level (concurrent)");
console.log(`  client (REST, stay)  ${cell(cells.restSeq).padEnd(24)}  ${cell(cells.restConc)}`);
console.log(`  Waso   (migrate)     ${cell(cells.wasoSeq).padEnd(24)}  ${cell(cells.wasoConc)}`);
console.log("");

const best = cells.wasoConc, naive = cells.restSeq, tunedClient = cells.restConc;
console.log(`Two independent wins, both on the IDENTICAL traversal source:`);
console.log(`  concurrency : round trips O(nodes)=${naive.hops} -> O(depth)=${tunedClient.hops}`);
console.log(`  migration   : client round trips -> 2 (the per-level rounds move server-side)`);
console.log("");
console.log(`Waso (migrate + concurrent): ${best.latency}ms, ${best.hops} round trips`);
console.log(`  vs naive REST client      : ${naive.latency}ms  ->  ${(naive.latency / best.latency).toFixed(0)}x faster`);
console.log(`  vs hand-tuned parallel client: ${tunedClient.latency}ms  ->  ${(tunedClient.latency / best.latency).toFixed(1)}x faster`);
console.log(`  (it beats even the optimal client because the client still pays one`);
console.log(`   ${RTT_MS}ms RTT per tree level (${tunedClient.hops} levels); Waso pays 2 client RTTs total.)`);
if (REAL) console.log(`Wall clock (REAL): naive ${(naive.wall/1000).toFixed(1)}s -> Waso ${(best.wall/1000).toFixed(2)}s`);
console.log("");
console.log(`Same traversal source across all four cells; only placement & batching differ.`);
console.log(`The per-level concurrency assumes the server can fetch a level at once (concurrent`);
console.log(`queries / a batched IN) — which it can, co-located with the data; the public`);
console.log(`per-item API the client is stuck with cannot.`);
console.log(`Correctness: all four strategies returned identical ${N}-node threads? ${ok ? "YES" : "NO"}`);
if (!ok) process.exitCode = 1;

// Waso — HN benchmark kernel.
//
//   node bench-hn.mjs            (modeled latency, instant)
//   node bench-hn.mjs --real     (inject real RTT sleeps -> genuine wall-clock)
//
// The Hacker News data shape is the canonical client-side waterfall: to load a
// thread you fetch the story item, then its comment ids, then each comment,
// then THEIR child ids, recursively. The Firebase-style API has no "fetch a
// whole thread" call, so a client must make one request per node, and each
// request depends on the previous one's result — a deep sequential waterfall.
//
// We run ONE traversal (the obvious sequential code) under the Waso runtime in
// two placements and measure the difference:
//
//   REST  : the traversal stays on the client; every api.item is an RPC round
//           trip (fetch). O(nodes) sequential round trips. This is the standard
//           REST/React app.
//   Waso  : the SAME traversal migrates to the server once (the first api.item
//           forces it), runs every api.item locally where the API lives, and
//           ships the assembled thread back. O(1) round trips.
//
// The only thing that differs is WHERE the code runs — the traversal source is
// identical. Latency is RTT-dominated, so collapsing N round trips to 2 is the
// whole game. We count real cross-tier hops on the real runtime (not analytics)
// and price them with an explicit network model.

import {
  PROGRAM, run, Suspend, serializeContinuation, deserializeContinuation,
  contBytes, initialFrames, Tier, fmt,
} from "./waso-core.mjs";

// --- register the traversal as a Waso IR program ---------------------------
// loadThread(rootId): BFS the comment tree, fetching each node via api.item,
// and return the assembled list. Authored as ordinary code:
//
//   function loadThread(rootId) {
//     const root = api.item(rootId);
//     const results = [root];
//     const queue = [...root.kids];
//     for (let head = 0; head < queue.length; head++) {
//       const c = api.item(queue[head]);   // <-- the resource boundary
//       results.push(c);
//       for (let j = 0; j < c.kids.length; j++) queue.push(c.kids[j]);
//     }
//     return results;
//   }
//
// locals: 0 rootId, 1 root, 2 results, 3 queue, 4 kids, 5 j, 6 head, 7 cid, 8 c
function asm(lines) {
  const labels = {}, code = [];
  for (const l of lines) (typeof l === "string") ? (labels[l] = code.length) : code.push(l.slice());
  for (const ins of code)
    if ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string") ins[1] = labels[ins[1]];
  return code;
}
PROGRAM.loadThread = {
  nlocals: 9,
  code: asm([
    ["LOAD", 0], ["RES", "api.item", 1], ["STORE", 1],          // root = api.item(rootId)
    ["NEWARR"], ["STORE", 2],
    ["LOAD", 2], ["LOAD", 1], ["ARRPUSH"],                       // results = [root]
    ["NEWARR"], ["STORE", 3],
    ["LOAD", 1], ["GETPROP", "kids"], ["STORE", 4],              // copy root.kids -> queue
    ["PUSH", 0], ["STORE", 5],
    "cploop",
    ["LOAD", 5], ["LOAD", 4], ["GETPROP", "length"], ["BIN", "<"], ["JMPF", "cpend"],
    ["LOAD", 3], ["LOAD", 4], ["LOAD", 5], ["INDEX"], ["ARRPUSH"],
    ["LOAD", 5], ["PUSH", 1], ["BIN", "+"], ["STORE", 5], ["JMP", "cploop"],
    "cpend",
    ["PUSH", 0], ["STORE", 6],                                   // head = 0
    "loop",
    ["LOAD", 6], ["LOAD", 3], ["GETPROP", "length"], ["BIN", "<"], ["JMPF", "end"],
    ["LOAD", 3], ["LOAD", 6], ["INDEX"], ["STORE", 7],           // cid = queue[head]
    ["LOAD", 6], ["PUSH", 1], ["BIN", "+"], ["STORE", 6],        // head++
    ["LOAD", 7], ["RES", "api.item", 1], ["STORE", 8],           // c = api.item(cid)
    ["LOAD", 2], ["LOAD", 8], ["ARRPUSH"],                       // results.push(c)
    ["LOAD", 8], ["GETPROP", "kids"], ["STORE", 4],              // kids = c.kids
    ["PUSH", 0], ["STORE", 5],
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
const API_MS = 2;    // server <-> its API/DB, co-located (cheap)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeNet() {
  const net = {
    hops: 0, bytes: 0, calls: 0,
    async hop(bytes) { this.hops++; this.bytes += bytes; if (REAL) await sleep(RTT_MS); },
  };
  return net;
}

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
        await net.hop(contBytes(wire));                       // ship the continuation
        const got = deserializeContinuation(wire);
        const result = owner.resources[e.pending.name](got.pending.args);
        got.frames[got.frames.length - 1].stack.push(result);
        frames = got.frames;
        current = owner;                                      // and STAY there (lazy placement)
      } else { // fetch: RPC a single call, continuation stays put (the REST waterfall)
        const reqBytes = Buffer.byteLength(JSON.stringify(e.pending.args));
        const result = owner.resources[e.pending.name](e.pending.args);
        const respBytes = Buffer.byteLength(JSON.stringify(result ?? null));
        await net.hop(reqBytes + respBytes);
        e.frames[e.frames.length - 1].stack.push(result);
        frames = e.frames;
      }
      continue;
    }
    let value = res.value;
    if (current !== startTier) await net.hop(Buffer.byteLength(JSON.stringify(value))); // ship result home
    return value;
  }
}

// --- run one strategy -------------------------------------------------------
async function runStrategy(policy, thread) {
  const net = makeNet();
  // The server owns api.item; the client owns nothing (it's where the user is).
  const server = new Tier("server", { "api.item": ([id]) => { net.calls++; return thread.store.get(id); } });
  const client = new Tier("client", {});
  const t0 = performance.now();
  const value = await execute("loadThread", [thread.rootId], {
    startTier: client, tiers: [server, client], policy, net,
  });
  const wall = performance.now() - t0;
  const latency = net.hops * RTT_MS + net.calls * API_MS; // modeled end-to-end latency
  return { value, hops: net.hops, bytes: net.bytes, calls: net.calls, latency, wall };
}

// --- go ---------------------------------------------------------------------
const N = 254;
const thread = genThread(N);
const sample = thread.store.get(1);
const itemBytes = Buffer.byteLength(JSON.stringify(sample));

const rest = await runStrategy("fetch", thread);
const waso = await runStrategy("migrate", thread);

// correctness: identical assembled threads
const ids = (v) => v.map((it) => it.id).join(",");
const ok = ids(rest.value) === ids(waso.value) && rest.value.length === N;

console.log("Waso — HN thread load: REST waterfall vs continuation migration\n");
console.log(`Thread: ${N} nodes, depth ${thread.depth}, ~${fmt(itemBytes)}/item (objects with string fields + nested kids)`);
console.log(`Network model: ${RTT_MS}ms client<->server RTT, ${API_MS}ms server<->API${REAL ? "  [REAL sleeps]" : "  [modeled]"}\n`);

// A hand-tuned level-parallel client: one RTT per tree level, fetches in a level
// overlap. Computed (not executed) as an honest upper bound on what a client can do.
const optimalHops = thread.depth + 1;
const optimalLatency = optimalHops * (RTT_MS + API_MS);

const row = (name, hops, latency, bytes, note = "") =>
  `  ${name.padEnd(28)} ${String(hops).padStart(4)} rt   ${(latency + "ms").padStart(9)}   ${bytes.padStart(9)}  ${note}`;
console.log("  strategy                     round trips   latency       bytes");
console.log(row("REST (fetch each item)", rest.hops, rest.latency, fmt(rest.bytes)));
console.log(row("Waso (migrate once)", waso.hops, waso.latency, fmt(waso.bytes)));
console.log(row("level-parallel client", optimalHops, optimalLatency, "—", "(computed, hand-tuned)"));
console.log("");

console.log(`Headline: the SAME sequential traversal, run as REST vs migrated by Waso:`);
console.log(`  round trips  ${rest.hops} -> ${waso.hops}   (the waterfall collapses to migrate + return)`);
console.log(`  latency      ${rest.latency}ms -> ${waso.latency}ms   =  ${(rest.latency / waso.latency).toFixed(1)}x faster`);
console.log(`  bytes        ${fmt(rest.bytes)} vs ${fmt(waso.bytes)}   (similar total; the win is round trips, not bandwidth)`);
if (REAL) console.log(`  wall clock   ${(rest.wall / 1000).toFixed(1)}s -> ${(waso.wall / 1000).toFixed(1)}s`);
console.log("");
console.log(`Honest caveat: a hand-tuned level-parallel client (~${optimalLatency}ms) would edge out`);
console.log(`this Waso run, because the migrated traversal calls api.item SEQUENTIALLY on the`);
console.log(`server (${N} x ${API_MS}ms = ${N * API_MS}ms of server-side reads). Server-side concurrency would`);
console.log(`close that gap. The point of the kernel: the OBVIOUS sequential code an agent`);
console.log(`writes gets ${(rest.latency / waso.latency).toFixed(0)}x for free — no batching, no resolvers, no client orchestration.`);
console.log("");
console.log(`Correctness: both strategies returned identical ${N}-node threads? ${ok ? "YES" : "NO"}`);
if (!ok) process.exitCode = 1;

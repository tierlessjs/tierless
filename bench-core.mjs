// Waso — shared HN benchmark core. Used by bench-hn.mjs (the 2x2 single run)
// and bench-sweep.mjs (the scale curve) so the mechanism can't drift.
//
// Two IR traversals (sequential per-item, concurrent per-level), a synthetic
// HN thread generator, and an orchestrator that runs a traversal under either
// placement policy on the real runtime, counting real cross-tier hops.

import {
  PROGRAM, run, Suspend, serializeContinuation, deserializeContinuation,
  contBytes, initialFrames, Tier,
} from "./waso-core.mjs";

export const DEFAULT_RTT = 50; // ms, client <-> server round trip (dominates)
export const DEFAULT_API = 2;  // ms, server <-> its API/DB per round (co-located)

function asm(lines) {
  const labels = {}, code = [];
  for (const l of lines) (typeof l === "string") ? (labels[l] = code.length) : code.push(l.slice());
  for (const ins of code)
    if ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string") ins[1] = labels[ins[1]];
  return code;
}

// Sequential: one api.item per node (the obvious traversal).
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

// Concurrent: one api.items(level) per tree level (fan out a level at once).
// locals: 0 rootId,1 level,2 results,3 items,4 next,5 i,6 it,7 kids,8 j
PROGRAM.loadThreadConcurrent = {
  nlocals: 9,
  code: asm([
    ["NEWARR"], ["STORE", 1], ["LOAD", 1], ["LOAD", 0], ["ARRPUSH"],
    ["NEWARR"], ["STORE", 2],
    "wloop",
    ["LOAD", 1], ["GETPROP", "length"], ["PUSH", 0], ["BIN", ">"], ["JMPF", "wend"],
    ["LOAD", 1], ["RES", "api.items", 1], ["STORE", 3],
    ["NEWARR"], ["STORE", 4],
    ["PUSH", 0], ["STORE", 5],
    "iloop",
    ["LOAD", 5], ["LOAD", 3], ["GETPROP", "length"], ["BIN", "<"], ["JMPF", "iend"],
    ["LOAD", 3], ["LOAD", 5], ["INDEX"], ["STORE", 6],
    ["LOAD", 2], ["LOAD", 6], ["ARRPUSH"],
    ["LOAD", 6], ["GETPROP", "kids"], ["STORE", 7], ["PUSH", 0], ["STORE", 8],
    "jloop",
    ["LOAD", 8], ["LOAD", 7], ["GETPROP", "length"], ["BIN", "<"], ["JMPF", "jend"],
    ["LOAD", 4], ["LOAD", 7], ["LOAD", 8], ["INDEX"], ["ARRPUSH"],
    ["LOAD", 8], ["PUSH", 1], ["BIN", "+"], ["STORE", 8], ["JMP", "jloop"],
    "jend",
    ["LOAD", 5], ["PUSH", 1], ["BIN", "+"], ["STORE", 5], ["JMP", "iloop"],
    "iend",
    ["LOAD", 4], ["STORE", 1],
    ["JMP", "wloop"],
    "wend",
    ["LOAD", 2], ["RET"],
  ]),
};

// Synthetic HN thread: objects with string fields + nested kids arrays.
export function genThread(n, branching = 3) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Orchestrator: migrate (ship the continuation) vs fetch (RPC one call, stay put).
async function execute(entry, args, { startTier, tiers, policy, net, rtt, real }) {
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
        net.hops++; net.bytes += contBytes(wire); if (real) await sleep(rtt);
        const got = deserializeContinuation(wire);
        got.frames[got.frames.length - 1].stack.push(owner.resources[e.pending.name](got.pending.args));
        frames = got.frames; current = owner;
      } else {
        const result = owner.resources[e.pending.name](e.pending.args);
        net.hops++;
        net.bytes += Buffer.byteLength(JSON.stringify(e.pending.args)) + Buffer.byteLength(JSON.stringify(result ?? null));
        if (real) await sleep(rtt);
        e.frames[e.frames.length - 1].stack.push(result);
        frames = e.frames;
      }
      continue;
    }
    if (current !== startTier) { net.hops++; net.bytes += Buffer.byteLength(JSON.stringify(res.value)); if (real) await sleep(rtt); }
    return res.value;
  }
}

// Run one strategy and return its measured costs.
export async function runStrategy(policy, program, thread, { rtt = DEFAULT_RTT, api = DEFAULT_API, real = false } = {}) {
  const net = { hops: 0, bytes: 0, calls: 0 };
  const server = new Tier("server", {
    "api.item":  ([id])  => { net.calls++; return thread.store.get(id); },
    "api.items": ([ids]) => { net.calls++; return ids.map((id) => thread.store.get(id)); }, // one concurrent round
  });
  const client = new Tier("client", {});
  const t0 = performance.now();
  const value = await execute(program, [thread.rootId], { startTier: client, tiers: [server, client], policy, net, rtt, real });
  const wall = performance.now() - t0;
  return { value, hops: net.hops, bytes: net.bytes, calls: net.calls, latency: net.hops * rtt + net.calls * api, wall };
}

// The four cells of the concurrency x placement matrix.
export async function runMatrix(thread, opts = {}) {
  return {
    restSeq:  await runStrategy("fetch",   "loadThread",           thread, opts),
    restConc: await runStrategy("fetch",   "loadThreadConcurrent", thread, opts),
    wasoSeq:  await runStrategy("migrate", "loadThread",           thread, opts),
    wasoConc: await runStrategy("migrate", "loadThreadConcurrent", thread, opts),
  };
}

export const idSeq = (v) => v.map((it) => it.id).join(",");

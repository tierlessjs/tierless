// §5 distributed handle heap for the react-tiers CPS model.
//
// docs/design.md §5: a migrating continuation references locals; small ones travel with
// it, but a BIG local should stay on its owning tier as an opaque handle and be fetched
// only if the other tier actually touches it ("stack smaller than heap"). The interpreter
// already does this (src/runtime/core.mjs serializeContinuation + fetch.mjs); this brings
// the same machinery to the compiled continuation.
//
// The one adaptation: the codec excises any *root* bigger than `threshold`, so we must
// flatten each frame's locals into INDIVIDUAL roots (the frame skeleton — fn/pc/keys —
// rides as metadata). Then a big local excises to a handle while the frame stays small,
// exactly as serializeContinuation flattens locals/stack/env. Coherence is the prior
// single-writer model (fetch.mjs): the owner is master, bumps a version on mutation, and
// readers hold a version-invalidated snapshot cache.
import { encodeGraph, decodeGraph } from "../../src/runtime/heap.mjs";
import { Heap } from "../../src/runtime/fetch.mjs";

export { Channel, makeHost } from "../../src/runtime/fetch.mjs";

// A tier with a versioned heap. heapPut/heapGet adapt Heap to the codec's §5 excision
// hook (encodeGraph calls tier.heapPut(v) and stamps {owner: tier.id, id}).
export function makeTier(id) {
  const heap = new Heap(id);
  return { id, heap, heapPut: (v) => heap.put(v).id, heapGet: (hid) => heap.get(hid) };
}

// Serialize a continuation, excising any local/arg bigger than `threshold` into `tier`'s
// heap as a §5 handle (it stays home). Frame skeletons (fn/pc + which keys) travel as
// metadata; only the value-bearing locals go through the graph codec, flattened so each
// is independently excise-or-inline. With no `tier`, nothing excises (everything inline).
export function encodeWire(stack, request, { tier = null, threshold = 8192 } = {}) {
  const roots = [];
  const frames = stack.map((f) => {
    const keys = Object.keys(f).filter((k) => k !== "fn" && k !== "pc");  // fn/pc are scalar machine state
    const b0 = roots.length; for (const k of keys) roots.push(f[k]);
    return { fn: f.fn, pc: f.pc, keys, b0 };
  });
  let req = null;
  if (request) {
    const a0 = roots.length; for (const a of request.args || []) roots.push(a);
    req = { op: request.op, tier: request.tier, name: request.name, a0, argc: (request.args || []).length };
  }
  return JSON.stringify({ frames, req, graph: encodeGraph(roots, { tier, threshold }) });
}

export function decodeWire(wire) {
  const { frames, req, graph } = JSON.parse(wire);
  const vals = decodeGraph(graph);
  const stack = frames.map((f) => { const fr = { fn: f.fn, pc: f.pc }; f.keys.forEach((k, i) => { fr[k] = vals[f.b0 + i]; }); return fr; });
  const request = req ? { op: req.op, tier: req.tier, name: req.name, args: vals.slice(req.a0, req.a0 + req.argc) } : null;
  return { stack, request };
}

// How many §5 handles the wire carries (a local that stayed home), for reporting/tests.
export const wireHandles = (wire) => JSON.parse(wire).graph.objs.filter((o) => o.k === "H").map((o) => o.h);

// --- §5 write-back: optimistic, version-checked coherence ------------------------------
//
// v1 was single-writer: the owner mutates the master, readers hold version-invalidated
// snapshots and never write. Write-back lifts that to single-MASTER with optimistic
// concurrency: any tier may be the writer, but it must propose its mutated snapshot back
// under the version it read (a compare-and-set). The master stays the sole serialization
// point — it accepts only if no one bumped the version since the reader fetched, so a
// stale write is rejected as a conflict and the reader refetches + retries. No lost
// updates; the same guarantee a CAS register gives, applied to a fetched §5 snapshot.

// The owner-side CAS. Accept `value` as the new master iff the heap is still at
// `baseVersion` (what the writer last saw). Returns {ok, version}: on success the version
// is bumped; on conflict ok=false and `version` is the owner's current (newer) version so
// the writer knows what to refetch.
export function writeBack(heap, id, baseVersion, value) {
  const cur = heap.version(id);
  if (cur !== baseVersion) return { ok: false, version: cur };  // someone wrote first — reject
  heap.objs.set(id, value);                                     // accept the reader's snapshot as the new master
  heap.ver.set(id, cur + 1);                                    // bump: invalidates every other reader's cache
  return { ok: true, version: cur + 1 };
}

// The reader-side optimistic loop: fetch the current snapshot, apply `mutator` to it,
// propose it back under the fetched version. On conflict, refetch (now seeing the winner's
// change) and re-apply — at most `tries` times. Because each attempt re-reads first, a
// retry merges on top of the latest master instead of clobbering it. Returns
// {ok, version, tries, copy}; `tries` reveals how much contention it hit.
export function commitWrite(channel, handle, mutator, { tries = 5 } = {}) {
  const ownerHeap = channel.tiers[handle.owner].heap;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const { copy, version } = channel.fetch(handle);  // read-current (counts a fetch on the channel)
    mutator(copy);                                     // apply the intended mutation to the fresh snapshot
    const res = writeBack(ownerHeap, handle.id, version, copy);
    if (res.ok) return { ok: true, version: res.version, tries: attempt, copy };
  }
  return { ok: false, tries };
}

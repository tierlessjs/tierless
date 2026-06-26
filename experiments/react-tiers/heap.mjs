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

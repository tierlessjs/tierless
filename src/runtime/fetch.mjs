// Stackmix — cross-tier handle fetch (Layer-2 de-risk, step 2).
//
// A continuation that migrates carries handles to objects that stayed on the
// owning tier (§5). Until now, dereferencing such a handle on the other tier
// threw "not implemented". This builds the real thing: a deref resolves three
// ways (the shape from the 2006 design) —
//
//   local?            -> use the master copy on this tier
//   movable data?     -> FETCH it from the owner (graph-codec, identity/cycle
//                        safe), cache it, and keep using the cached snapshot
//   pinned resource?  -> (handled elsewhere: a RES call migrates the continuation)
//
// Coherence: single-master. The owning tier is the master; it bumps a version
// on mutation. A reader caches fetched snapshots keyed by version; a deref
// consults the owner's current version (an "invalidating cache"), so a stale
// snapshot is refetched after the master changes. This module is the read path
// (readers mutate only their own snapshot copy); the optimistic, version-checked
// WRITE path — a reader proposing its mutated snapshot back to the master under a
// compare-and-set — is layered on top in experiments/react-tiers/heap.mjs.

import { encodeGraph, decodeGraph, isHandle } from "./heap.mjs";

// A tier-local heap of versioned objects. The owner is the single writer.
export class Heap {
  constructor(tierId) { this.tierId = tierId; this.objs = new Map(); this.ver = new Map(); this.next = 1; }
  put(obj) { const id = `${this.tierId}#${this.next++}`; this.objs.set(id, obj); this.ver.set(id, 1); return { __stackmix_handle__: true, owner: this.tierId, id }; }
  get(id) { return this.objs.get(id); }
  version(id) { return this.ver.get(id); }
  mutate(id, fn) { fn(this.objs.get(id)); this.ver.set(id, this.ver.get(id) + 1); } // single-writer; invalidates readers
}

// The wire between tiers. fetch() serializes the master on the owner with the
// identity/cycle-safe graph codec and returns a detached copy + its version.
export class Channel {
  constructor(tiers) { this.tiers = tiers; this.bytes = 0; this.fetches = 0; } // tiers: { id: { heap } }
  currentVersion(handle) { return this.tiers[handle.owner].heap.version(handle.id); } // cheap consult (modeled)
  fetch(handle) {
    this.fetches++;
    const owner = this.tiers[handle.owner];
    const wire = encodeGraph([owner.heap.get(handle.id)]); // graph-codec: preserves identity/cycles
    const json = JSON.stringify(wire);
    this.bytes += Buffer.byteLength(json);
    const [copy] = decodeGraph(JSON.parse(json));          // detached snapshot on the requester
    return { copy, version: owner.heap.version(handle.id) };
  }
}

// A deref host for the interpreter running on `localTier`, with a read-through,
// version-invalidated cache. Plug into run(tier, frames, host).
export function makeHost(localTier, channel) {
  const cache = new Map(); // id -> { version, copy }
  const stats = { fetches: 0, hits: 0, localUses: 0, bytes: 0 };
  return {
    stats,
    deref(h) {
      if (!isHandle(h)) return h;
      if (h.owner === localTier.id) { stats.localUses++; return localTier.heap.get(h.id); } // use the master
      const current = channel.currentVersion(h);
      const c = cache.get(h.id);
      if (c && c.version === current) { stats.hits++; return c.copy; }                       // coherent cache hit
      const before = channel.bytes;
      const { copy, version } = channel.fetch(h);                                            // fetch the snapshot
      cache.set(h.id, { version, copy });
      stats.fetches++; stats.bytes += channel.bytes - before;
      return copy;
    },
  };
}

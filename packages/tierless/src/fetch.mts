// Tierless — cross-tier handle fetch (Layer-2 de-risk, step 2).
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
// compare-and-set — is layered on top in src/heap.mjs.

import { encodeGraph, decodeGraph, isHandle, type Handle } from "./graph.mjs";
import { makeLruStore, DEFAULT_CACHE_CAP, type Store } from "./store.mjs";

export { makeLruStore, makeUnboundedStore, DEFAULT_CACHE_CAP, type Store, type MaybePromise } from "./store.mjs";

export interface TierEntry {
  heap: Heap;
}
export type Tiers = Record<string, TierEntry>;

// A tier-local heap of versioned objects. The owner is the single writer.
export class Heap {
  tierId: string;
  objs: Map<string, unknown>;
  ver: Map<string, number>;
  next: number;
  constructor(tierId: string) { this.tierId = tierId; this.objs = new Map(); this.ver = new Map(); this.next = 1; }
  put(obj: unknown): Handle { const id = `${this.tierId}#${this.next++}`; this.objs.set(id, obj); this.ver.set(id, 1); return { __tierless_handle__: true, owner: this.tierId, id }; }
  get(id: string): unknown { return this.objs.get(id); }
  version(id: string): number { return this.ver.get(id) as number; }
  mutate(id: string, fn: (obj: unknown) => void): void { fn(this.objs.get(id)); this.ver.set(id, (this.ver.get(id) as number) + 1); } // single-writer; invalidates readers
}

// The wire between tiers. fetch() serializes the master on the owner with the
// identity/cycle-safe graph codec and returns a detached copy + its version.
export class Channel {
  tiers: Tiers;
  bytes: number;
  fetches: number;
  constructor(tiers: Tiers) { this.tiers = tiers; this.bytes = 0; this.fetches = 0; } // tiers: { id: { heap } }
  currentVersion(handle: Handle): number { return this.tiers[handle.owner].heap.version(handle.id); } // cheap consult (modeled)
  fetch(handle: Handle): { copy: unknown; version: number } {
    this.fetches++;
    const owner = this.tiers[handle.owner];
    const wire = encodeGraph([owner.heap.get(handle.id)]); // graph-codec: preserves identity/cycles
    const json = JSON.stringify(wire);
    this.bytes += Buffer.byteLength(json);
    const [copy] = decodeGraph(JSON.parse(json));          // detached snapshot on the requester
    return { copy, version: owner.heap.version(handle.id) };
  }
}

export interface LocalTier {
  id: string;
  heap: Heap;
}
export interface HostStats {
  fetches: number;
  hits: number;
  localUses: number;
  bytes: number;
}
export interface FetchHost {
  stats: HostStats;
  deref(h: unknown): unknown;
}

// A deref host for the interpreter running on `localTier`, with a read-through,
// version-invalidated cache. Plug into run(tier, frames, host). The cache lives behind
// an injected `store` so its retention policy is replaceable; the default is a bounded
// LRU that caps resident entries within a long session (release across sessions is
// already provided by the per-socket host lifetime in server.mts). The served cache is
// safe to evict — the master is on the owner tier, so an eviction costs at most a
// refetch — so the cap is the only parameter.
type CacheEntry = { version: number; copy: unknown };
export function makeHost(localTier: LocalTier, channel: Channel, store: Store<CacheEntry> = makeLruStore<CacheEntry>(DEFAULT_CACHE_CAP)): FetchHost {
  const stats: HostStats = { fetches: 0, hits: 0, localUses: 0, bytes: 0 };
  return {
    stats,
    deref(h: unknown): unknown {
      if (!isHandle(h)) return h;
      if (h.owner === localTier.id) { stats.localUses++; return localTier.heap.get(h.id); } // use the master
      const current = channel.currentVersion(h);
      // deref is a synchronous hot path (the auto-deref machine consumes its return
      // synchronously); the default store resolves synchronously. The Store contract is
      // typed possibly-async so an async store can be injected without a signature
      // change — such a store would require an async deref, layered on top later.
      const c = store.get(h.id) as CacheEntry | undefined;
      if (c && c.version === current) { stats.hits++; return c.copy; }                       // coherent cache hit
      const before = channel.bytes;
      const { copy, version } = channel.fetch(h);                                            // fetch the snapshot
      store.set(h.id, { version, copy });
      stats.fetches++; stats.bytes += channel.bytes - before;
      return copy;
    },
  };
}

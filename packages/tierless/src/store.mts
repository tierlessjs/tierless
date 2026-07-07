// Tierless — pluggable retention store for the deref hosts (memory management).
//
// A deref host retains a copy of every remote object a session's continuation
// dereferences. Left unbounded, resident memory grows for the life of the retaining
// host (the per-socket host in server.mts), with no bound short of disconnect. This
// lifts that retention behind an injected store so the retention *policy* is
// replaceable, and ships a bounded-LRU default that fixes the leak on the served path.
//
// The interface is deliberately narrow: get / set / evict. No `has`, iteration, or
// `size` — no caller needs them, and a policy tracks its own size internally.
//
// get/set are typed possibly-async from the start. The bundled default resolves
// synchronously (the deref hot path consumes it synchronously), but an alternative
// store — off-heap, networked, disk-backed — is free to resolve a key asynchronously.
// Baking that into the contract now avoids a breaking signature change once the
// interface has callers.

export type MaybePromise<T> = T | Promise<T>;

// A replaceable retention store keyed by object id. One instance is one namespace with
// one policy: the served cache and the coherent write-back baselines share a key space
// but differ in eviction safety, so each gets its own store rather than a single global
// policy (which is what would permit silent write-loss on the coherent path).
export interface Store<V> {
  get(id: string): MaybePromise<V | undefined>;
  set(id: string, value: V): MaybePromise<void>;
  evict(id: string): MaybePromise<void>;
}

// Default served-cache budget: 64 MiB of retained snapshots per host. The cap is on
// BYTES, not entry count — a count cap can't bound memory when entries vary in size (a
// thousand tiny records and a thousand megabyte datasets are the same count but three
// orders of magnitude apart in memory). This bounds growth within a long session;
// release across sessions is already provided by the per-socket host lifetime. It is
// per-connection and tunable — pass a store with a different budget to makeHost.
export const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

export interface LruOpts<V> {
  /** Eviction budget, in the units `weigh` returns. */
  max: number;
  /** Per-entry weight. Default 1 per entry, i.e. `max` is an entry count. Return byte
   *  size for a memory budget (the served cache weighs each entry by its fetched size). */
  weigh?: (value: V) => number;
  /** Eviction gate: return false to PIN an entry (skipped by budget eviction; `evict(id)`
   *  still removes it). The §5 coherence pins an entry whose snapshot has an unshipped
   *  mutation — evicting it would drop the baseline its write-back diffs against. Pinned
   *  weight can push the store over budget transiently. Default: everything evictable. */
  evictable?: (value: V) => boolean;
}

// Bounded LRU (synchronous), weighted. Retained weight is capped at `max`, evicting the
// least-recently-used entries on overflow. With the default unit weight it is a plain
// count cap; with `weigh: e => e.bytes` it is a memory cap. Eviction is safe on the
// served path — the master lives on the owner tier, so evicting an entry costs at most a
// refetch — so the budget is the only parameter. `get` and `set` count as uses
// (most-recent); `evict` drops an entry outright.
//
// Recency is carried by the Map's own insertion order: delete-then-set moves a key to
// the most-recent end, and the first key is always the least-recent. A parallel `sizes`
// map tracks each entry's weight so `total` stays exact across overwrite and eviction.
export function makeLruStore<V>(opts: LruOpts<V>): Store<V> {
  const { max, weigh = () => 1, evictable = () => true } = opts;
  if (!Number.isFinite(max) || max < 1) throw new RangeError(`LRU max must be a finite number >= 1, got ${max}`);
  const m = new Map<string, V>();
  const sizes = new Map<string, number>();
  let total = 0;
  const drop = (id: string): void => { total -= sizes.get(id) ?? 0; sizes.delete(id); m.delete(id); };
  const shrink = (keep: string): void => {
    if (total <= max) return;
    for (const [id, v] of m) {                                    // least-recent first; skip pinned entries
      if (id === keep || !evictable(v)) continue;                 // never the just-set entry
      drop(id);
      if (total <= max) return;
    }
    // only pinned weight remains over budget — allowed transiently (a pin is a pending write-back)
  };
  return {
    get(id: string): V | undefined {
      if (!m.has(id)) return undefined;
      const v = m.get(id) as V;
      m.delete(id); m.set(id, v);                                  // touch: move to most-recent (weight unchanged)
      return v;
    },
    set(id: string, value: V): void {
      const w = Math.max(1, weigh(value));                        // every entry counts at least 1 unit
      if (m.has(id)) drop(id);                                    // remove any stale entry for this id first
      if (w > max) return;                                        // larger than the whole budget: bypass — don't evict the cache to hold one object
      m.set(id, value); sizes.set(id, w); total += w;
      shrink(id);                                                 // evict least-recent evictable until within budget
    },
    evict(id: string): void { drop(id); },
  };
}

// Unbounded store — a plain Map behind the Store interface, never evicting. The honest
// default for a namespace whose eviction policy is not yet designed (the coherent
// write-back baselines: evicting a baseline with an uncommitted mutation silently loses
// the write, so it must be gated on clean state — a separate, later design). Injecting
// this keeps behavior identical to the old hardcoded Map while making the store
// replaceable, so bounding that path later is a policy swap, not a rewrite.
export function makeUnboundedStore<V>(): Store<V> {
  const m = new Map<string, V>();
  return {
    get(id: string): V | undefined { return m.get(id); },
    set(id: string, value: V): void { m.set(id, value); },
    evict(id: string): void { m.delete(id); },
  };
}

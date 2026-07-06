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

// Default entry-count cap for the served cache. Bounds growth within a long session;
// release across sessions is already provided by the per-socket host lifetime.
export const DEFAULT_CACHE_CAP = 4096;

// Bounded LRU (synchronous). Caps resident entries at `cap`, evicting the
// least-recently-used on overflow. Eviction is safe on the served path — the master
// lives on the owner tier, so evicting an entry costs at most a refetch. `get` and
// `set` count as uses (most-recent); `evict` drops an entry outright.
//
// Order is carried by the Map's own insertion order: delete-then-set moves a key to the
// most-recent end, and the first key is always the least-recent.
export function makeLruStore<V>(cap: number = DEFAULT_CACHE_CAP): Store<V> {
  if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`LRU cap must be an integer >= 1, got ${cap}`);
  const m = new Map<string, V>();
  return {
    get(id: string): V | undefined {
      if (!m.has(id)) return undefined;
      const v = m.get(id) as V;
      m.delete(id); m.set(id, v);                                  // touch: move to most-recent
      return v;
    },
    set(id: string, value: V): void {
      m.delete(id); m.set(id, value);                             // (re)insert at most-recent
      while (m.size > cap) m.delete(m.keys().next().value as string); // evict least-recent until within cap
    },
    evict(id: string): void { m.delete(id); },
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

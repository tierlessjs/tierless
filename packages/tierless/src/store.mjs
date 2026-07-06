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
export function makeLruStore(cap = DEFAULT_CACHE_CAP) {
    if (!Number.isInteger(cap) || cap < 1)
        throw new RangeError(`LRU cap must be an integer >= 1, got ${cap}`);
    const m = new Map();
    return {
        get(id) {
            if (!m.has(id))
                return undefined;
            const v = m.get(id);
            m.delete(id);
            m.set(id, v); // touch: move to most-recent
            return v;
        },
        set(id, value) {
            m.delete(id);
            m.set(id, value); // (re)insert at most-recent
            while (m.size > cap)
                m.delete(m.keys().next().value); // evict least-recent until within cap
        },
        evict(id) { m.delete(id); },
    };
}
// Unbounded store — a plain Map behind the Store interface, never evicting. The honest
// default for a namespace whose eviction policy is not yet designed (the coherent
// write-back baselines: evicting a baseline with an uncommitted mutation silently loses
// the write, so it must be gated on clean state — a separate, later design). Injecting
// this keeps behavior identical to the old hardcoded Map while making the store
// replaceable, so bounding that path later is a policy swap, not a rewrite.
export function makeUnboundedStore() {
    const m = new Map();
    return {
        get(id) { return m.get(id); },
        set(id, value) { m.set(id, value); },
        evict(id) { m.delete(id); },
    };
}

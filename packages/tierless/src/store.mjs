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
// Default served-cache budget: 64 MiB of retained snapshots per host. The cap is on
// BYTES, not entry count — a count cap can't bound memory when entries vary in size (a
// thousand tiny records and a thousand megabyte datasets are the same count but three
// orders of magnitude apart in memory). This bounds growth within a long session;
// release across sessions is already provided by the per-socket host lifetime. It is
// per-connection and tunable — pass a store with a different budget to makeHost.
export const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
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
export function makeLruStore(opts) {
    const { max, weigh = () => 1 } = opts;
    if (!Number.isFinite(max) || max < 1)
        throw new RangeError(`LRU max must be a finite number >= 1, got ${max}`);
    const m = new Map();
    const sizes = new Map();
    let total = 0;
    const drop = (id) => { total -= sizes.get(id) ?? 0; sizes.delete(id); m.delete(id); };
    return {
        get(id) {
            if (!m.has(id))
                return undefined;
            const v = m.get(id);
            m.delete(id);
            m.set(id, v); // touch: move to most-recent (weight unchanged)
            return v;
        },
        set(id, value) {
            const w = Math.max(1, weigh(value)); // every entry counts at least 1 unit
            if (m.has(id))
                drop(id); // remove any stale entry for this id first
            if (w > max)
                return; // larger than the whole budget: bypass — don't evict the cache to hold one object
            m.set(id, value);
            sizes.set(id, w);
            total += w;
            while (total > max)
                drop(m.keys().next().value); // evict least-recent until within budget (never the just-set entry: w <= max)
        },
        evict(id) { drop(id); },
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

// §5 distributed handle heap for the Tierless CPS state-machine framework.
//
// docs/design.md §5: a migrating continuation references locals; small ones travel with
// it, but a BIG local should stay on its owning tier as an opaque handle and be fetched
// only if the other tier actually touches it ("stack smaller than heap").
//
// The mechanism: the graph codec (graph.mjs) excises any *root* bigger than `threshold`,
// so we flatten each frame's locals into INDIVIDUAL roots (the frame skeleton — fn/pc/keys
// — rides as metadata). Then a big local excises to a handle while the frame stays small.
// Coherence (fetch.mjs) is single-master: the owner bumps a version on mutation and readers
// hold a version-invalidated snapshot cache; write-back lifts that to optimistic CAS.
import { encodeGraph, decodeGraph, isHandle } from "./graph.mjs";
import { Heap } from "./fetch.mjs";
import { openSnapshot, diffSnapshot, wholeSnapshot, applySnapshot } from "./wire-delta.mjs";
export { Channel, makeHost } from "./fetch.mjs";
export function makeTier(id) {
    const heap = new Heap(id);
    return { id, heap, heapPut: (v) => heap.put(v).id, heapGet: (hid) => heap.get(hid) };
}
// Serialize a continuation, excising any local/arg bigger than `threshold` into `tier`'s
// heap as a §5 handle (it stays home). Frame skeletons (fn/pc + which keys) travel as
// metadata; only the value-bearing locals go through the graph codec, flattened so each
// is independently excise-or-inline. With no `tier`, nothing excises (everything inline).
// DeltaFrame/DeltaRequest (from the delta wire) are the same stack/request shape this wire
// uses — reused rather than redeclared.
export function encodeWire(stack, request, { tier = null, threshold = 8192 } = {}) {
    const roots = [];
    const frames = stack.map((f) => {
        const keys = Object.keys(f).filter((k) => k !== "fn" && k !== "pc"); // fn/pc are scalar machine state
        const b0 = roots.length;
        for (const k of keys)
            roots.push(f[k]);
        return { fn: f.fn, pc: f.pc, keys, b0 };
    });
    let req = null;
    if (request) {
        const a0 = roots.length;
        for (const a of request.args || [])
            roots.push(a);
        req = { op: request.op, tier: request.tier, name: request.name, a0, argc: roots.length - a0 };
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
    if (cur !== baseVersion)
        return { ok: false, version: cur }; // someone wrote first — reject
    heap.objs.set(id, value); // accept the reader's snapshot as the new master
    heap.ver.set(id, cur + 1); // bump: invalidates every other reader's cache
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
        const { copy, version } = channel.fetch(handle); // read-current (counts a fetch on the channel)
        mutator(copy); // apply the intended mutation to the fresh snapshot
        const res = writeBack(ownerHeap, handle.id, version, copy);
        if (res.ok)
            return { ok: true, version: res.version, tries: attempt, copy };
    }
    return { ok: false, tries };
}
// A coherence host supporting BOTH reads and writes — the symmetric partner of fetch.mjs's
// read-only makeHost, used by the compiler's --auto-deref/--auto-writeback machine. deref()
// returns a version-invalidated snapshot (the master in place on the owner; a cached/fetched
// copy elsewhere); the fetched copy is tagged NON-enumerably (a Symbol, so it never travels
// or serializes) with the handle it came from and the version it was read at. writeBack()
// reads that tag and proposes the mutated snapshot back to the owner under that version (an
// optimistic CAS). On the owning tier the master is edited in place and writeBack just bumps
// the version so other tiers' caches invalidate.
const PROV = Symbol("tierless.provenance");
export function makeCoherentHost(localTier, channel) {
    const cache = new Map(); // id -> { version, copy }
    const sessions = new Map(); // id -> a delta session baselined at fetch, so a write-back ships only the change
    const stats = { fetches: 0, hits: 0, localUses: 0, writeBacks: 0, conflicts: 0, wire: 0, whole: 0 };
    const tag = (obj, owner, id, version) => {
        if (obj && typeof obj === "object" && Object.isExtensible(obj))
            Object.defineProperty(obj, PROV, { value: { owner, id, version }, enumerable: false, writable: true, configurable: true }); // a frozen/sealed user object can't be tagged — skip, don't throw (it can't be written back anyway)
        return obj;
    };
    return {
        stats,
        deref(h) {
            if (!isHandle(h))
                return h;
            if (h.owner === localTier.id) {
                stats.localUses++;
                return tag(localTier.heap.get(h.id), h.owner, h.id, localTier.heap.version(h.id));
            } // master in place
            const current = channel.currentVersion(h);
            const c = cache.get(h.id);
            if (c && c.version === current) {
                stats.hits++;
                return c.copy;
            } // coherent cache hit
            const { copy, version } = channel.fetch(h);
            tag(copy, h.owner, h.id, version);
            cache.set(h.id, { version, copy });
            sessions.set(h.id, openSnapshot(localTier.id, copy)); // baseline this snapshot for a future write-back delta
            stats.fetches++;
            return copy;
        },
        // A write-back IS a delta to the master: ship only the objects that changed in the snapshot (member
        // edits, array push, Map set, Set add — all handled by the content-based codec), applied in place
        // under the same CAS. min(delta, whole) so it is never larger than the old whole-object write-back.
        writeBack(obj) {
            const prov = obj && obj[PROV];
            if (!prov)
                return obj; // untracked value — nothing to propagate
            const ownerHeap = channel.tiers[prov.owner].heap;
            if (prov.owner === localTier.id) { // local master: edited in place, just bump the version
                ownerHeap.ver.set(prov.id, ownerHeap.version(prov.id) + 1);
                prov.version = ownerHeap.version(prov.id);
                stats.writeBacks++;
                return obj;
            }
            if (ownerHeap.version(prov.id) !== prov.version) {
                stats.conflicts++;
                return obj;
            } // optimistic CAS: stale -> reject (a real reader refetches+retries via commitWrite)
            const session = sessions.get(prov.id);
            if (!session)
                return obj; // no fetch baseline to diff against (a remote deref always opens one) — nothing coherent to ship
            const delta = diffSnapshot(session, obj);
            const whole = wholeSnapshot(session, obj); // the floor: same fetch-anchored baseline as the delta + the owner's applySnapshot, so ids align
            const bytes = delta.length < whole.length ? delta : whole; // min(delta, whole)
            applySnapshot(prov.owner, ownerHeap.get(prov.id), bytes); // mutate the master in place by matching id
            ownerHeap.ver.set(prov.id, prov.version + 1);
            prov.version += 1;
            cache.set(prov.id, { version: prov.version, copy: obj });
            stats.writeBacks++;
            stats.wire += bytes.length;
            stats.whole += whole.length;
            return obj;
        },
    };
}

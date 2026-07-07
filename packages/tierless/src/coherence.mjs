// Tierless — §5 heap coherence for the LIVE session host (the real serving path).
//
// A continuation that migrates carries §5 handles: big locals excised to their owning
// tier's heap so they don't travel (heap.mjs / graph.mjs excision). The compiler's
// --auto-deref/--auto-writeback passes emit a handle READ as a resource under the pseudo
// tier "@deref" and a mutation's propagation as "@writeback" — markers for "service this
// locally, on whatever tier is running." This module is what the session host (host.mjs)
// plugs in to service both for real, over the SAME websocket the continuation rides:
//
//   • encodeOpts(sid) — excise big locals into this connection's heap on the outbound
//                       wire, tagging each excised id with the continuation (sid) that
//                       created it, so release(sid) can free them when it completes.
//   • serve(peer)     — answer the peer: `deref` (ship the master, version-invalidated:
//                       "same" on a match), `writeback` (apply the shipped delta to the
//                       master in place under an optimistic CAS), `release` (drop a
//                       finished continuation's excised masters).
//   • deref(peer,h)   — the local master if we own it, else fetch the snapshot over
//                       `peer` into a BYTE-BOUNDED store. Each fetched entry carries a
//                       write-back baseline (openSnapshot), so a later mutation ships as
//                       a minimal delta.
//   • writeBack(peer,obj) — propose the mutated snapshot back to its owner under the
//                       version it was read at (optimistic CAS, single serialization
//                       point on the owner). Baseline present: min(delta, whole) applied
//                       IN PLACE on the master (identity preserved — the owner's own
//                       references observe the write). Baseline evicted: the whole graph
//                       replaces the master under the same CAS (commitWrite's semantics;
//                       counted in stats.wholeWrites). Conflict: the write is rejected
//                       and the stale entry dropped, exactly the optimistic-concurrency
//                       contract of heap.mjs's makeCoherentHost.
//
// Memory: the three retention surfaces and their bounds —
//   reader cache+baselines — byte-weighted LRU; an entry whose snapshot has an unshipped
//     mutation is PINNED (evictable gate) until its write-back lands, so bounding never
//     silently drops a write. The compiler emits the write-back immediately after each
//     mutation, so pins are transient.
//   owner excision heap — released per continuation: release(sid) locally when a drive
//     completes, and via the peer's `release` message for the answering side.
//   everything — per-connection: the whole object lives in the socket's closure.
import { encodeGraph, decodeGraph, isHandle } from "./graph.mjs";
import { makeTier } from "./heap.mjs";
import { openSnapshot, diffSnapshot, wholeSnapshot, applySnapshot, dirtySnapshot } from "./wire-delta.mjs";
import { makeLruStore, DEFAULT_CACHE_BYTES } from "./store.mjs";
// The pseudo-tiers the compiler stamps on §5 operations (see the compiled machines:
// `{ op:"resource", tier:"@deref", name:"deref", args:[local] }` and the "@writeback"
// twin the --auto-writeback pass emits after each mutation).
export const DEREF_TIER = "@deref";
export const WRITEBACK_TIER = "@writeback";
// Whether a compiled bundle uses the §5 heap: the --auto-deref pass exports an `isHandle`
// guard onto the module (--auto-writeback implies --auto-deref). The host uses this to
// auto-enable coherence for the apps that need it, leaving ordinary apps untouched.
export const usesHeap = (bundle) => !!bundle && typeof bundle.isHandle === "function";
// Fetched-copy provenance: which master this snapshot came from and the version it was
// read at. Non-enumerable Symbol, so it never serializes or travels.
const PROV = Symbol("tierless.provenance");
const tag = (obj, owner, id, version) => {
    if (obj && typeof obj === "object" && Object.isExtensible(obj))
        Object.defineProperty(obj, PROV, { value: { owner, id, version }, enumerable: false, writable: true, configurable: true }); // a frozen/sealed user object can't be tagged — skip, don't throw (it can't be written back anyway)
    return obj;
};
export function makeCoherence(tierId, { threshold = 8192, store } = {}) {
    const tier = makeTier(tierId);
    const stats = { fetches: 0, hits: 0, localUses: 0, bytes: 0, writeBacks: 0, conflicts: 0, wholeWrites: 0 };
    const cache = store ?? makeLruStore({
        max: DEFAULT_CACHE_BYTES,
        weigh: (e) => e.bytes,
        evictable: (e) => !dirtySnapshot(e.session, e.copy), // an unshipped mutation pins its baseline
    });
    const excised = new Map(); // sid -> heap ids this continuation excised here
    const release = (sid) => {
        const ids = excised.get(sid);
        if (!ids)
            return;
        excised.delete(sid);
        for (const id of ids)
            tier.heap.drop(id);
    };
    return {
        tier,
        encodeOpts(sid) {
            const collect = {
                id: tier.id,
                heapPut: (v) => {
                    const hid = tier.heapPut(v);
                    let ids = excised.get(sid);
                    if (!ids)
                        excised.set(sid, ids = new Set());
                    ids.add(hid);
                    return hid;
                },
            };
            return { tier: collect, threshold };
        },
        owns: (t) => t === DEREF_TIER || t === WRITEBACK_TIER,
        async deref(peer, h) {
            if (!isHandle(h))
                return h;
            if (h.owner === tier.id) {
                stats.localUses++;
                return tag(tier.heap.get(h.id), h.owner, h.id, tier.heap.version(h.id));
            } // we own the master — use it in place
            // Consult the owner with the version we hold; it ships the graph only on a miss.
            const cached = (await cache.get(h.id));
            const { obj } = await peer.request({ type: "deref", id: h.id, have: cached ? cached.version : -1 });
            if (obj.type === "error")
                throw new Error("tierless: deref failed: " + obj.message);
            if (obj.type === "same") {
                stats.hits++;
                return cached.copy;
            } // version match — the cached copy is still coherent
            const copy = decodeGraph(obj.graph)[0]; // identity/cycle-safe snapshot
            const bytes = JSON.stringify(obj.graph).length; // wire size — the entry's memory weight
            tag(copy, h.owner, h.id, obj.version);
            await cache.set(h.id, { version: obj.version, copy, bytes, session: openSnapshot(tier.id, copy) }); // baseline for a future write-back delta
            stats.fetches++;
            stats.bytes += bytes;
            return copy;
        },
        async writeBack(peer, obj) {
            const prov = (obj && typeof obj === "object" ? obj[PROV] : undefined);
            if (!prov)
                return obj; // untracked value — nothing to propagate
            if (prov.owner === tier.id) { // local master, edited in place: bump so other tiers' caches invalidate
                tier.heap.ver.set(prov.id, tier.heap.version(prov.id) + 1);
                prov.version = tier.heap.version(prov.id);
                stats.writeBacks++;
                return obj;
            }
            const entry = (await cache.get(prov.id));
            if (entry && entry.copy === obj) {
                // The good path: baseline present. Ship min(delta, whole) — both anchored to the
                // fetch baseline, so the owner's applySnapshot mutates its master IN PLACE.
                const delta = diffSnapshot(entry.session, obj); // advances the baseline
                const whole = wholeSnapshot(entry.session, obj);
                const bytes = delta.length < whole.length ? delta : whole;
                const { obj: reply } = await peer.request({ type: "writeback", id: prov.id, version: prov.version, mode: "apply" }, bytes);
                if (reply.type !== "ok") { // conflict (someone wrote first) or error: reject the write, drop the
                    stats.conflicts++; // stale entry so the next deref refetches — the optimistic contract
                    await cache.evict(prov.id);
                    return obj;
                }
                prov.version = reply.version;
                entry.version = reply.version; // the entry stays coherent: next deref is a version hit
                stats.writeBacks++;
                stats.bytes += bytes.length;
                return obj;
            }
            // Degraded path: the baseline was evicted (it was clean then; this object mutated
            // later), or the cache holds a NEWER copy of the same master. The fetch-anchored ids
            // are gone, so an in-place delta is impossible — ship the whole graph and have the
            // owner REPLACE the master under the same CAS (heap.mjs writeBack's semantics).
            const graph = encodeGraph([obj]);
            const { obj: reply } = await peer.request({ type: "writeback", id: prov.id, version: prov.version, mode: "replace", graph });
            if (reply.type !== "ok") {
                stats.conflicts++;
                return obj;
            }
            prov.version = reply.version;
            stats.writeBacks++;
            stats.wholeWrites++;
            return obj;
        },
        release,
        releaseRemote(peer, sid) {
            // Fire-and-forget: the reply (or an old peer's "no handler" error) is irrelevant.
            peer.request({ type: "release", sid }).catch(() => { });
        },
        serve(peer) {
            // Single-writer read coherence: the owner bumps a version on mutation; a reader that
            // still holds the current version needs no data, so answer "same" and ship nothing.
            peer.on("deref", (req) => {
                const version = tier.heap.version(req.id);
                if (version === undefined)
                    return { obj: { type: "error", message: "no such master " + req.id + " on " + tier.id + " (released or never excised)" } };
                if (req.have === version)
                    return { obj: { type: "same", version } };
                return { obj: { type: "fetchResult", version, graph: encodeGraph([tier.heapGet(req.id)]) } };
            });
            // The owner-side CAS: accept the write iff the master is still at the version the
            // reader read. On success the version bumps, invalidating every other reader's cache.
            peer.on("writeback", (req, bin) => {
                const cur = tier.heap.version(req.id);
                if (cur === undefined)
                    return { obj: { type: "error", message: "no such master " + req.id } };
                if (cur !== req.version)
                    return { obj: { type: "conflict", version: cur } }; // someone wrote first — reject
                if (req.mode === "apply")
                    applySnapshot(tier.id, tier.heap.get(req.id), bin); // mutate the master in place by matched ids
                else
                    tier.heap.objs.set(req.id, decodeGraph(req.graph)[0]); // replace (baseline-less write-back)
                tier.heap.ver.set(req.id, cur + 1);
                return { obj: { type: "ok", version: cur + 1 } };
            });
            peer.on("release", (req) => { release(req.sid); return { obj: { type: "ok" } }; });
        },
        stats,
    };
}

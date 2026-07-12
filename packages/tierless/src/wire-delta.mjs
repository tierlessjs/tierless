// Delta wire — encode a continuation as a PATCH over what the peer already holds, so a
// capture ships only the objects whose content actually changed. This generalizes the §5
// versioned heap (stable id + version, big objects fetched lazily) to "every object, shipped
// as a coherence delta," and the §6 cost decision picks min(delta, full) per message.
//
// Model: each tier keeps a replicated, stably-identified object store. An object's STABLE ID
// (a WeakMap, tier-prefixed like a §5 handle so the two stores never collide) persists across
// captures. The wire carries the root references + only the changed objects; the peer resolves
// unchanged ids from its store and MUTATES changed objects in place, so an unchanged ancestor
// sees its changed descendant's update for free. Bytes are proportional to actual change.
//
// Two ways to find "what changed" — same wire, same store, same apply, different cost:
//   • RESCAN (encodeDelta): no cooperation needed. Walk the reachable graph and give each object
//     a SHALLOW content version (children by id, so a deep edit bumps only its own object, not
//     its ancestors'); ship those whose version differs from the peer's. O(reachable) per capture.
//   • WRITE-TRACKED (encodeDeltaTracked): bump a version on write. `touch(obj)` marks an object
//     dirty the instant it is mutated (the same hook --auto-writeback already emits after a member
//     write); the encoder then ships the dirty set directly — plus any newly-reachable objects,
//     found by a walk that PRUNES at clean, already-shipped objects (their subgraph is known). So
//     it costs O(changed), not O(reachable): no per-object hashing, and the receiver's apply only
//     touches the shipped objects. Correct as long as every mutation bumps — exactly the guarantee
//     a compiler write-hook gives; rescan is the safe fallback when the caller can't cooperate.
//
// Scope: plain objects (own enumerable string keys), arrays, Map, Set, number/string/bool/
// null/undefined/bigint, and §5 handles — with identity and cycles preserved across all of them
// (a shared object that is also a Map key and a Set member stays one object). Symbols and
// non-enumerable props extend mechanically (same node table as wire-binary).
import { isHandle, approxExceeds, toBigInt } from "./graph.mjs";
import { W, R, isVarInt, writeMagic, checkMagic, makeInterner, writeStrings, readStrings, strAt, rootsOf, rebuildStack, writeFrameHeader, readFrameHeader } from "./wire-io.mjs";
// SMD2: the handle record's flag byte became a bitfield (bit 1 kind, bit 2 cls) — same
// versioning rule as wire-binary's SMW2; a skewed peer fails cleanly at checkMagic.
const MAGIC = "SMD2";
const isObj = (v) => v !== null && typeof v === "object";
const isMap = (v) => v instanceof Map;
const isSet = (v) => v instanceof Set;
// Own enumerable string keys, minus __proto__ — never ship it, so a round-trip can't set a
// reconstructed object's prototype from the wire (the decoder skips it too, defending a hostile peer).
const ownKeys = (v) => Object.keys(v).filter((k) => k !== "__proto__");
function fnv(s) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
} return h >>> 0; }
// The child values of a container, in a stable order (a §5 handle is an opaque leaf — no children).
// One definition shared by every graph walk (reach, version, dirty-select) so they never disagree.
function forEachChild(v, fn) {
    if (Array.isArray(v))
        v.forEach(fn);
    else if (isHandle(v)) { /* leaf: stays tier-local */ }
    else if (isMap(v))
        for (const [k, val] of v) {
            fn(k);
            fn(val);
        }
    else if (isSet(v))
        for (const val of v)
            fn(val);
    else
        for (const k of ownKeys(v))
            fn(v[k]);
}
// The canonical token of a value, identifying it for change detection: an object is its id (so a deep
// edit is invisible to an ancestor — children by id), everything else is its type+value.
function canonOf(idOf, sub, v) {
    v = sub(v);
    return isObj(v) ? "r" + idOf.get(v) : v === undefined ? "u" : typeof v === "bigint" ? "B" + v : typeof v + ":" + v;
}
// A container's slots as Map<slotId, { key, canon }> — the per-FIELD/element shape, so a diff can ship
// only the slots that changed (per-field granularity), not the whole container. slotId is the index
// (arrays), the string key (objects), or the key/member's canon (Map/Set, which keep the key object so a
// deletion can name it). One definition for all four kinds.
function slotsOf(idOf, sub, v) {
    const m = new Map();
    if (Array.isArray(v))
        for (let i = 0; i < v.length; i++)
            m.set(i, { key: i, canon: canonOf(idOf, sub, v[i]) });
    else if (isMap(v))
        for (const [k, val] of v)
            m.set(canonOf(idOf, sub, k), { key: k, canon: canonOf(idOf, sub, val) });
    else if (isSet(v))
        for (const e of v)
            m.set(canonOf(idOf, sub, e), { key: e, canon: "1" });
    else
        for (const k of ownKeys(v))
            m.set(k, { key: k, canon: canonOf(idOf, sub, v[k]) });
    return m;
}
// The writer/hardened reader, magic header, string table, isVarInt cut, and the frame/request
// flatten + rebuild live in wire-io.mts (one copy, shared with the binary wire). This file owns
// only what is delta-format-specific: sessions, versioning, the changed-record kinds, and patches.
const sidOfFn = (session) => (v) => { let id = session.idOf.get(v); if (id === undefined) {
    id = session.tier + "#" + (session.next++);
    session.idOf.set(v, id);
    session.store.set(id, v);
} return id; };
// Substitute an excised object with its §5 handle, so every graph walk (reach, version, ship, emit)
// sees the small handle leaf the wire carries, never the big subgraph that stayed home.
const subFn = (session) => { const h = session.handleOf; return (v) => (isObj(v) && h.has(v) ? h.get(v) : v); };
// §5 excision for the delta path: a big NEW subgraph stays tier-local as a handle. Walk the roots; the
// first time an object's subgraph exceeds `threshold`, put it in `tier.heap` and remember a stable
// handle (session.handleOf) so the wire carries that handle leaf in its place and the big data never
// crosses unless the peer derefs it. The mapping persists across hops — a §5 handle is a leaf the delta
// ships once — so a big immutable dataset rides every later capture for free, only UI deltas crossing.
function exciseBig(session, rootVals, tier, threshold, content) {
    const handleOf = session.handleOf, seen = new Set();
    const walk = (v) => {
        if (!isObj(v) || isHandle(v) || handleOf.has(v) || seen.has(v))
            return;
        seen.add(v);
        if (content && content.store.hashFor(v) !== undefined)
            return; // content-addressed immutable subgraph: ship it by hash, never excise it (content beats excision; don't descend)
        if (approxExceeds(v, threshold)) {
            handleOf.set(v, { __tierless_handle__: true, owner: tier.id, id: tier.heapPut(v), kind: Array.isArray(v) ? "array" : "object" });
            return;
        } // excise; don't descend
        forEachChild(v, walk);
    };
    rootVals.forEach(walk);
}
// Plan how to ship one changed object: a full record (the whole container — kinds o/a/m/s) or, under
// per-field mode (session.fields) when a baseline exists, a PATCH of only the slots that changed (op/ap/
// mp/sp). The patch is taken only when it touches FEWER slots than the whole — a strict per-object min,
// backed by the message-level min(delta, full) so a write-back/hop is never larger overall. Advances the
// sender's per-slot baseline either way.
// Object/Map/Set iterate in INSERTION order, which is observable, so a patch is only safe when applying
// it (delete the removed slots, append the new ones) reproduces the current order exactly. A reorder
// (delete-then-re-add a key) keeps membership but moves it — there a patch would leave the peer's order
// stale, so we ship the whole container instead (which carries the order). Arrays are index-addressed,
// so their patch is order-correct by construction and needs no check.
function orderPreserved(base, cur) {
    const survivors = [...base.keys()].filter((sid) => cur.has(sid));
    const news = [...cur.keys()].filter((sid) => !base.has(sid));
    if (survivors.length + news.length !== cur.size)
        return false;
    let i = 0;
    for (const sid of cur.keys()) {
        const want = i < survivors.length ? survivors[i] : news[i - survivors.length];
        if (sid !== want)
            return false;
        i++;
    }
    return true;
}
// Records are one of ~7 wire-record shapes (whole o/a/m/s, or a patch op/ap/mp/sp) — a genuinely
// polymorphic per-kind union kept as `any` internally (same pragmatism as graph.mts's enc/dec): every
// caller either hands it straight to emit()'s writer (which already switches on `kind`) or discards it.
function planRecord(session, sub, id, full = false) {
    const v = session.store.get(id);
    if (isHandle(v))
        return { id, kind: "H", v };
    // `full` (the wholeSnapshot arm) ships every object as a whole container AND leaves session.peerSlots
    // untouched, so it can be computed from the SAME fetch session as the delta without advancing — and
    // corrupting — the delta's per-slot baseline (advancing it is what made min(delta, whole) mis-decode).
    const useFields = session.fields && !full;
    const base = useFields ? session.peerSlots.get(id) : undefined;
    let cur;
    if (useFields) {
        cur = slotsOf(session.idOf, sub, v);
        session.peerSlots.set(id, cur);
    }
    if (base) { // we know what the peer holds slot-by-slot -> consider a patch
        if (Array.isArray(v)) {
            const sets = [];
            for (const [i, info] of cur) {
                const b = base.get(i);
                if (!b || b.canon !== info.canon)
                    sets.push([i, v[i]]);
            }
            if (sets.length < cur.size)
                return { id, kind: "ap", len: v.length, sets }; // a push/edit/truncate -> just the touched indices + length
        }
        else if (isMap(v)) {
            const sets = [], dels = [];
            for (const [sid, info] of cur) {
                const b = base.get(sid);
                if (!b || b.canon !== info.canon)
                    sets.push([info.key, v.get(info.key)]);
            }
            for (const [sid, info] of base)
                if (!cur.has(sid))
                    dels.push(info.key);
            if (sets.length + dels.length < cur.size && orderPreserved(base, cur))
                return { id, kind: "mp", sets, dels };
        }
        else if (isSet(v)) {
            const adds = [], dels = [];
            for (const [sid, info] of cur)
                if (!base.has(sid))
                    adds.push(info.key);
            for (const [sid, info] of base)
                if (!cur.has(sid))
                    dels.push(info.key);
            if (adds.length + dels.length < cur.size && orderPreserved(base, cur))
                return { id, kind: "sp", adds, dels };
        }
        else {
            const sets = [], dels = [];
            for (const [k, info] of cur) {
                const b = base.get(k);
                if (!b || b.canon !== info.canon)
                    sets.push([k, v[k]]);
            }
            for (const [k] of base)
                if (!cur.has(k))
                    dels.push(k);
            if (sets.length + dels.length < cur.size && orderPreserved(base, cur))
                return { id, kind: "op", sets, dels };
        }
    }
    return { id, kind: isMap(v) ? "m" : isSet(v) ? "s" : Array.isArray(v) ? "a" : "o", v }; // whole container
}
// Serialize { frames, req, roots, changed-objects } to bytes. Shared by both encoders — the wire
// is identical; only the choice of `changed` (the sids to ship) differs. `changed` objects are
// read from session.store (sidOf put every live object there); every value reference is its sid.
function emit(session, rootVals, frames, req, changed, full = false) {
    const sub = subFn(session);
    const records = changed.map((id) => planRecord(session, sub, id, full));
    const { strs, intern: si } = makeInterner();
    const internVal = (v) => { v = sub(v); if (isObj(v))
        si(session.idOf.get(v));
    else if (typeof v === "string")
        si(v);
    else if (typeof v === "bigint")
        si(String(v)); };
    for (const f of frames) {
        si(f.fn);
        f.keys.forEach(si);
    }
    if (req) {
        si(req.op);
        si(req.tier);
        si(req.name);
    }
    rootVals.forEach(internVal);
    for (const r of records) {
        si(r.id);
        if (r.kind === "H") {
            si(r.v.owner);
            si(String(r.v.id));
            if (r.v.kind)
                si(r.v.kind);
            if (r.v.cls)
                si(r.v.cls);
        }
        else if (r.kind === "o")
            for (const k of ownKeys(r.v)) {
                si(k);
                internVal(r.v[k]);
            }
        else if (r.kind === "a")
            for (const e of r.v)
                internVal(e);
        else if (r.kind === "m")
            for (const [k, val] of r.v) {
                internVal(k);
                internVal(val);
            }
        else if (r.kind === "s")
            for (const val of r.v)
                internVal(val);
        else if (r.kind === "op") {
            for (const [k, val] of r.sets) {
                si(k);
                internVal(val);
            }
            for (const k of r.dels)
                si(k);
        }
        else if (r.kind === "ap")
            for (const [, val] of r.sets)
                internVal(val);
        else if (r.kind === "mp") {
            for (const [k, val] of r.sets) {
                internVal(k);
                internVal(val);
            }
            for (const k of r.dels)
                internVal(k);
        }
        else if (r.kind === "sp") {
            for (const val of r.adds)
                internVal(val);
            for (const val of r.dels)
                internVal(val);
        }
    }
    const w = new W();
    const node = (v) => {
        v = sub(v);
        if (isObj(v)) {
            w.u8(0);
            w.varu(si(session.idOf.get(v)));
        }
        else if (v === null)
            w.u8(6);
        else if (v === true)
            w.u8(4);
        else if (v === false)
            w.u8(5);
        else if (v === undefined)
            w.u8(7);
        else if (typeof v === "string") {
            w.u8(3);
            w.varu(si(v));
        }
        else if (typeof v === "bigint") {
            w.u8(8);
            w.varu(si(String(v)));
        }
        else if (isVarInt(v)) {
            w.u8(1);
            w.vari(v);
        }
        else {
            w.u8(2);
            w.f64(v);
        }
    };
    writeMagic(w, MAGIC);
    writeStrings(w, strs);
    writeFrameHeader(w, frames, req, si);
    w.varu(rootVals.length);
    for (const v of rootVals)
        node(v);
    w.varu(records.length);
    for (const r of records) {
        w.varu(si(r.id));
        if (r.kind === "H") {
            w.u8(2);
            w.varu(si(r.v.owner));
            w.varu(si(String(r.v.id)));
            w.u8((r.v.kind ? 1 : 0) | (r.v.cls ? 2 : 0));
            if (r.v.kind)
                w.varu(si(r.v.kind));
            if (r.v.cls)
                w.varu(si(r.v.cls));
        }
        else if (r.kind === "o") {
            const ks = ownKeys(r.v);
            w.u8(0);
            w.varu(ks.length);
            for (const k of ks) {
                w.varu(si(k));
                node(r.v[k]);
            }
        }
        else if (r.kind === "a") {
            w.u8(1);
            w.varu(r.v.length);
            for (const e of r.v)
                node(e);
        }
        else if (r.kind === "m") {
            w.u8(3);
            w.varu(r.v.size);
            for (const [k, val] of r.v) {
                node(k);
                node(val);
            }
        }
        else if (r.kind === "s") {
            w.u8(4);
            w.varu(r.v.size);
            for (const val of r.v)
                node(val);
        }
        else if (r.kind === "op") {
            w.u8(5);
            w.varu(r.sets.length);
            for (const [k, val] of r.sets) {
                w.varu(si(k));
                node(val);
            }
            w.varu(r.dels.length);
            for (const k of r.dels)
                w.varu(si(k));
        }
        else if (r.kind === "ap") {
            w.u8(6);
            w.varu(r.len);
            w.varu(r.sets.length);
            for (const [i, val] of r.sets) {
                w.varu(i);
                node(val);
            }
        }
        else if (r.kind === "mp") {
            w.u8(7);
            w.varu(r.sets.length);
            for (const [k, val] of r.sets) {
                node(k);
                node(val);
            }
            w.varu(r.dels.length);
            for (const k of r.dels)
                node(k);
        }
        else if (r.kind === "sp") {
            w.u8(8);
            w.varu(r.adds.length);
            for (const val of r.adds)
                node(val);
            w.varu(r.dels.length);
            for (const val of r.dels)
                node(val);
        }
    }
    return w.done();
}
// Parse a delta to a plain structure (no session, no store mutation) — the hardened reader.
function parseDelta(bytes) {
    const r = new R(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), "wire-delta");
    checkMagic(r, MAGIC);
    const strs = readStrings(r);
    const S = strAt(strs, "wire-delta");
    const { frames, req } = readFrameHeader(r, S);
    const node = () => {
        const t = r.u8();
        switch (t) {
            case 0: return { ref: S(r.varu()) };
            case 1: return { v: r.vari() };
            case 2: return { v: r.f64() };
            case 3: return { v: S(r.varu()) };
            case 4: return { v: true };
            case 5: return { v: false };
            case 6: return { v: null };
            case 7: return { v: undefined };
            case 8: return { v: toBigInt(S(r.varu())) };
            default: throw new RangeError("wire-delta: bad node tag " + t);
        }
    };
    const rootNodes = [];
    {
        const n = r.count();
        for (let i = 0; i < n; i++)
            rootNodes.push(node());
    }
    const changed = [];
    {
        const n = r.count();
        for (let i = 0; i < n; i++) {
            const sid = S(r.varu());
            const kind = r.u8();
            if (kind === 0) {
                const c = r.count(), fields = [];
                for (let j = 0; j < c; j++) {
                    const k = S(r.varu());
                    fields.push([k, node()]);
                }
                changed.push({ sid, kind, fields });
            } // whole object
            else if (kind === 1) {
                const c = r.count(), e = [];
                for (let j = 0; j < c; j++)
                    e.push(node());
                changed.push({ sid, kind, elems: e });
            } // whole array
            else if (kind === 2) {
                const owner = S(r.varu()), id = S(r.varu());
                const h = { __tierless_handle__: true, owner, id };
                const fl = r.u8();
                if (fl & 1)
                    h.kind = S(r.varu());
                if (fl & 2)
                    h.cls = S(r.varu());
                changed.push({ sid, kind, handle: h });
            } // §5 handle (flags: 1 kind, 2 cls)
            else if (kind === 3) {
                const c = r.count(), entries = [];
                for (let j = 0; j < c; j++) {
                    const k = node();
                    entries.push([k, node()]);
                }
                changed.push({ sid, kind, entries });
            } // whole Map
            else if (kind === 4) {
                const c = r.count(), vals = [];
                for (let j = 0; j < c; j++)
                    vals.push(node());
                changed.push({ sid, kind, vals });
            } // whole Set
            else if (kind === 5) {
                const sc = r.count(), sets = [];
                for (let j = 0; j < sc; j++) {
                    const k = S(r.varu());
                    sets.push([k, node()]);
                }
                const dc = r.count(), dels = [];
                for (let j = 0; j < dc; j++)
                    dels.push(S(r.varu()));
                changed.push({ sid, kind, sets, dels });
            } // object PATCH
            else if (kind === 6) {
                const len = r.varu();
                const sc = r.count(), sets = [];
                for (let j = 0; j < sc; j++) {
                    const idx = r.varu();
                    sets.push([idx, node()]);
                }
                changed.push({ sid, kind, len, sets });
            } // array PATCH
            else if (kind === 7) {
                const sc = r.count(), sets = [];
                for (let j = 0; j < sc; j++) {
                    const k = node();
                    sets.push([k, node()]);
                }
                const dc = r.count(), dels = [];
                for (let j = 0; j < dc; j++)
                    dels.push(node());
                changed.push({ sid, kind, sets, dels });
            } // Map PATCH
            else if (kind === 8) {
                const ac = r.count(), adds = [];
                for (let j = 0; j < ac; j++)
                    adds.push(node());
                const dc = r.count(), dels = [];
                for (let j = 0; j < dc; j++)
                    dels.push(node());
                changed.push({ sid, kind, adds, dels });
            } // Set PATCH
            else
                throw new RangeError("wire-delta: bad changed-object kind " + kind);
        }
    }
    return { frames, req, rootNodes, changed };
}
// Apply a parsed delta against `session.store`, MUTATING changed objects in place (so an ancestor
// that still references them sees the update). Returns the reconstructed stack/request, the root
// values (for a receiver that wants to re-scan), and the list of shipped sids.
function reconstruct(session, parsed) {
    const { frames, req, rootNodes, changed } = parsed;
    const shell = (k, h) => (k === 1 || k === 6 ? [] : k === 2 ? h : k === 3 || k === 7 ? new Map() : k === 4 || k === 8 ? new Set() : {});
    for (const ch of changed) { // pass 1: locate-or-create shells
        let obj = session.store.get(ch.sid);
        if (!obj) {
            obj = shell(ch.kind, ch.handle);
            session.store.set(ch.sid, obj);
            session.idOf.set(obj, ch.sid);
        }
        ch.obj = obj;
    }
    const deref = (nd) => ("ref" in nd ? session.store.get(nd.ref) : nd.v); // store has every referenced id
    for (const ch of changed) { // pass 2: fill (mutate in place)
        if (ch.kind === 0) {
            for (const k of Object.keys(ch.obj))
                delete ch.obj[k];
            for (const [k, nd] of ch.fields)
                if (k !== "__proto__")
                    ch.obj[k] = deref(nd);
        } // skip __proto__: a hostile peer must not set a reconstructed object's prototype
        else if (ch.kind === 1) {
            ch.obj.length = 0;
            for (const nd of ch.elems)
                ch.obj.push(deref(nd));
        }
        else if (ch.kind === 2) {
            const h = ch.obj;
            h.owner = ch.handle.owner;
            h.id = ch.handle.id;
            if (ch.handle.kind !== undefined)
                h.kind = ch.handle.kind;
        }
        else if (ch.kind === 3) {
            ch.obj.clear();
            for (const [kn, vn] of ch.entries)
                ch.obj.set(deref(kn), deref(vn));
        }
        else if (ch.kind === 4) {
            ch.obj.clear();
            for (const vn of ch.vals)
                ch.obj.add(deref(vn));
        }
        else if (ch.kind === 5) {
            for (const [k, nd] of ch.sets)
                if (k !== "__proto__")
                    ch.obj[k] = deref(nd);
            for (const k of ch.dels)
                delete ch.obj[k];
        } // object PATCH: update/remove only the named keys
        else if (ch.kind === 6) {
            ch.obj.length = ch.len;
            for (const [idx, nd] of ch.sets)
                ch.obj[idx] = deref(nd);
        } // array PATCH: set length, then the changed indices
        else if (ch.kind === 7) {
            for (const [kn, vn] of ch.sets)
                ch.obj.set(deref(kn), deref(vn));
            for (const kn of ch.dels)
                ch.obj.delete(deref(kn));
        } // Map PATCH
        else if (ch.kind === 8) {
            for (const nd of ch.adds)
                ch.obj.add(deref(nd));
            for (const nd of ch.dels)
                ch.obj.delete(deref(nd));
        } // Set PATCH
    }
    const rootVals = rootNodes.map(deref);
    // per-slot baseline upkeep: a fields-mode receiver that later sends back must know what it now holds.
    if (session.fields) {
        const sub = subFn(session);
        for (const ch of changed)
            if (ch.kind !== 2)
                session.peerSlots.set(ch.sid, slotsOf(session.idOf, sub, ch.obj));
    }
    const { stack, request } = rebuildStack(frames, req, rootVals);
    return { stack, request, rootVals, shipped: changed.map((c) => c.sid) };
}
// ============================== RESCAN mode (no cooperation needed) ==============================
export function makeDeltaSession(tier) {
    return { tier, idOf: new WeakMap(), next: 1, store: new Map(), peerVer: new Map(), handleOf: new WeakMap(), fields: false, peerSlots: new Map() };
}
// Walk every reachable object, assign/reuse ids, and compute each one's shallow content version.
// Returns reach: sid -> object, and ver: sid -> version. O(reachable).
function scan(session, rootVals) {
    const sidOf = sidOfFn(session), sub = subFn(session);
    const reach = new Map();
    const visit = (v) => { v = sub(v); if (!isObj(v))
        return; const id = sidOf(v); if (reach.has(id))
        return; reach.set(id, v); forEachChild(v, visit); };
    rootVals.forEach(visit);
    const canon = (v) => { v = sub(v); return isObj(v) ? "r" + session.idOf.get(v) : v === undefined ? "u" : typeof v === "bigint" ? "B" + v : typeof v + ":" + v; };
    const ver = new Map();
    for (const [id, v] of reach) {
        const c = isHandle(v) ? "H|" + v.owner + "|" + v.id + "|" + (v.kind || "") + "|" + (v.cls || "")
            : isMap(v) ? "M|" + [...v].map(([k, val]) => canon(k) + "=" + canon(val)).join("|")
                : isSet(v) ? "S|" + [...v].map(canon).join("|")
                    : Array.isArray(v) ? "a|" + v.map(canon).join("|")
                        : "o|" + ownKeys(v).map((k) => k + "=" + canon(v[k])).join("|");
        ver.set(id, fnv(c));
    }
    return { reach, ver };
}
// Encode the continuation as a delta vs what `session` believes the peer holds, detecting change
// by re-hashing the reachable graph. Returns the bytes + reachable/shipped counts.
export function encodeDelta(session, stack, request, opts = {}) {
    const { rootVals, frames, req } = rootsOf(stack, request);
    if (opts.tier)
        exciseBig(session, rootVals, opts.tier, opts.threshold || 64 * 1024);
    const { reach, ver } = scan(session, rootVals);
    const changed = [...reach.keys()].filter((id) => session.peerVer.get(id) !== ver.get(id));
    const bytes = emit(session, rootVals, frames, req, changed);
    for (const [id, vv] of ver)
        session.peerVer.set(id, vv); // the peer will hold these versions
    return { bytes, reachable: reach.size, shipped: changed.length };
}
// Apply a rescan delta. The receiver re-scans to learn the versions it now holds, so an encode
// back to the sender is itself a delta (the return hop of a bounce). O(reachable).
export function applyDelta(session, bytes) {
    const { stack, request, rootVals } = reconstruct(session, parseDelta(bytes));
    const { ver } = scan(session, rootVals);
    for (const [id, vv] of ver)
        session.peerVer.set(id, vv);
    return { stack, request };
}
// =========================== WRITE-TRACKED mode (bump version on write) ==========================
export function makeTrackedSession(tier) {
    return { tier, idOf: new WeakMap(), next: 1, store: new Map(), seen: new Set(), dirty: new Set(), handleOf: new WeakMap(), fields: false, peerSlots: new Map() };
}
// Bump the version of one or more objects: mark them dirty the instant they are mutated. This is
// the hook a compiler write-barrier (the --auto-writeback shape) emits after a member write.
export function touch(session, ...objs) {
    for (const o of objs)
        if (isObj(o))
            session.dirty.add(o);
    return objs[0];
}
// Select the sids to ship WITHOUT hashing the graph: every dirty object, plus every newly-reachable
// object. Found by a walk seeded from the roots AND the dirty set (a dirty object can hang under a
// clean ancestor), recursing only through dirty/new objects and PRUNING at clean, already-shipped
// ones — their whole subgraph is already on the peer. Cost O(changed + frontier), not O(reachable).
// Tradeoff (measured in bench/delta.mjs, not asserted): the pruned walk is exact whenever a mutated
// object stays reachable. If code mutates an object then ORPHANS it in the same run, the orphan ships
// once as a stray — never a wrong reconstruction, and bounded to one hop (dirty is cleared per
// capture; adoptBaseline GCs it on the next full frame). Under realistic oscillation the bench shows
// ZERO orphans, where the exact O(reachable) variant only adds ~5.8× encode time for no benefit — so
// pruned O(changed) is the tuned default; selectDirtyExact ({ exact: true }) is the knob for an
// adversarial mutate-then-orphan-every-hop workload (there, ~85 B/hop of strays vs the walk cost).
function selectDirty(session, rootVals) {
    const sidOf = sidOfFn(session), sub = subFn(session);
    const ship = new Set(), fresh = [];
    let visited = 0;
    const recurse = (v) => {
        v = sub(v);
        if (!isObj(v))
            return;
        visited++;
        const id = sidOf(v);
        const isNew = !session.seen.has(id);
        if (!isNew && !session.dirty.has(v))
            return; // clean & known → prune (subgraph held)
        if (ship.has(id))
            return; // already queued (also breaks cycles)
        ship.add(id);
        if (isNew)
            fresh.push(id);
        forEachChild(v, recurse);
    };
    rootVals.forEach(recurse);
    for (const o of session.dirty)
        recurse(o); // dirty objects under a clean ancestor
    return { changed: [...ship], fresh, visited };
}
// EXACT variant: ship only objects REACHABLE from the roots (no orphans, ever), at the cost of a
// full O(reachable) membership walk instead of O(changed). The pruned selectDirty above is the tuned
// default — bench/delta.mjs measures the tradeoff: realistic oscillation never orphans, so exact only
// adds the walk cost for no benefit; pass { exact: true } when a workload mutates-then-orphans heavily.
function selectDirtyExact(session, rootVals) {
    const sidOf = sidOfFn(session), sub = subFn(session);
    const reach = [], seen = new Set();
    const visit = (v) => { v = sub(v); if (!isObj(v))
        return; const id = sidOf(v); if (seen.has(id))
        return; seen.add(id); reach.push([id, v]); forEachChild(v, visit); };
    rootVals.forEach(visit);
    const ship = [], fresh = [];
    for (const [id, v] of reach) {
        const isNew = !session.seen.has(id);
        if (isNew || session.dirty.has(v)) {
            ship.push(id);
            if (isNew)
                fresh.push(id);
        }
    }
    return { changed: ship, fresh, visited: reach.length };
}
// Compute a delta WITHOUT committing the session state, so a caller weighing min(delta, full) can
// back out and ship the full wire instead. `commit()` finalizes it (peer now holds the new objects;
// the dirty set is cleared). selectDirty has already assigned ids to any new objects either way.
export function planDelta(session, stack, request, opts = {}) {
    const { rootVals, frames, req } = rootsOf(stack, request);
    if (opts.tier)
        exciseBig(session, rootVals, opts.tier, opts.threshold || 64 * 1024);
    const { changed, fresh, visited } = (opts.exact ? selectDirtyExact : selectDirty)(session, rootVals);
    const bytes = emit(session, rootVals, frames, req, changed);
    return { bytes, shipped: changed.length, visited, commit() { for (const id of fresh)
            session.seen.add(id); session.dirty.clear(); } };
}
// Encode by bumped versions: ship the dirty set + newly-reachable objects. O(changed) by default;
// { exact: true } ships only reachable objects (O(reachable), no orphans). The dirty set is cleared
// (those changes are now on the peer); newly-shipped ids join `seen`.
export function encodeDeltaTracked(session, stack, request, opts = {}) {
    const p = planDelta(session, stack, request, opts);
    p.commit();
    return { bytes: p.bytes, shipped: p.shipped, visited: p.visited };
}
// Apply a tracked delta. Only the shipped objects are written, and only their sids join `seen` —
// O(shipped), no re-scan. The applied objects are NOT marked dirty (the change came from the peer,
// who already has it), so an encode back ships only what THIS side then mutates.
export function applyDeltaTracked(session, bytes) {
    const { stack, request, shipped } = reconstruct(session, parseDelta(bytes));
    for (const id of shipped)
        session.seen.add(id);
    return { stack, request };
}
// Establish a SHARED baseline from a full (non-delta) frame. min(delta, full) may ship the compact
// full binary wire instead of a delta — the cold first hop, or a near-total change — and that frame
// carries no ids, so both tiers must re-derive matching ones. Each walks the identical graph in the
// identical DFS pre-order and assigns "@0","@1",… — deterministic, so the two stores agree — then
// marks every object seen. Objects created AFTER adoption get the tier-prefixed id (next++), which
// never collides with an "@n". The store is rebuilt, so objects no longer reachable are dropped
// (this is also where accumulated orphans are collected). After this, the next capture is a delta.
export function adoptBaseline(session, stack, request) {
    const { rootVals } = rootsOf(stack, request);
    const sub = subFn(session); // excised objects appear as their handle leaf
    session.store = new Map();
    session.seen = new Set();
    session.dirty.clear();
    let n = 0;
    const assign = (v) => {
        v = sub(v);
        if (!isObj(v))
            return;
        const prior = session.idOf.get(v);
        if (prior !== undefined && session.store.has(prior))
            return; // already placed in THIS baseline (sharing/cycles)
        const id = "@" + (n++);
        session.idOf.set(v, id);
        session.store.set(id, v);
        session.seen.add(id);
        forEachChild(v, assign);
    };
    rootVals.forEach(assign);
    if (session.fields) {
        session.peerSlots = new Map();
        for (const [id, v] of session.store)
            session.peerSlots.set(id, slotsOf(session.idOf, sub, v));
    } // per-slot baseline, so the next diff can patch
    session.based = true;
}
// Rebuild { stack, request } with every excised object replaced by its §5 handle leaf, for the
// min(delta, full) FULL path: encodeWireBinary then sees handles where the big subgraphs were and
// ships them as leaves — the same handles the delta path uses (both run after exciseBig), so the two
// paths agree on handle ids and adoptBaseline (which also subs) stays deterministic. Order- and
// identity-preserving (a shared object rebuilds once via the memo; cycles are memoized before
// recursion), and the spine is small (the big data is gone), so it is cheap.
export function subForFullWire(session, stack, request, content = null) {
    const sub = subFn(session), memo = new Map();
    const rebuild = (v) => {
        v = sub(v);
        if (!isObj(v) || isHandle(v))
            return v;
        if (content && content.store.hashFor(v) !== undefined)
            return v; // a content-addressed immutable subgraph: keep the original instance so encodeGraph's content option recognizes it by identity and ships it by hash (don't rebuild)
        if (memo.has(v))
            return memo.get(v);
        if (Array.isArray(v)) {
            const a = [];
            memo.set(v, a);
            for (const e of v)
                a.push(rebuild(e));
            return a;
        }
        if (isMap(v)) {
            const m = new Map();
            memo.set(v, m);
            for (const [k, val] of v)
                m.set(rebuild(k), rebuild(val));
            return m;
        }
        if (isSet(v)) {
            const s = new Set();
            memo.set(v, s);
            for (const e of v)
                s.add(rebuild(e));
            return s;
        }
        const o = {};
        memo.set(v, o);
        for (const k of ownKeys(v))
            o[k] = rebuild(v[k]);
        return o;
    };
    const stk = stack.map((f) => { const g = {}; for (const k of Object.keys(f))
        g[k] = (k === "fn" || k === "pc") ? f[k] : rebuild(f[k]); return g; });
    const req = request ? { ...request, args: (request.args || []).map(rebuild) } : null;
    return { stack: stk, request: req };
}
// Populate session.handleOf for a capture (the min(delta,full) caller runs this once, before BOTH the
// full path (subForFullWire) and the delta path, so they excise the same objects to the same handles).
export function exciseForCapture(session, stack, request, tier, threshold = 64 * 1024, content = null) {
    exciseBig(session, rootsOf(stack, request).rootVals, tier, threshold, content);
}
// Content-addressing composes with the delta via the min(delta, full) FULL arm, not a new delta kind:
// pass a { store, peer } to exciseForCapture/subForFullWire/encodeWireBinary, and an immutable subgraph
// the peer holds ships by hash on every FULL frame (the cold hop and any re-frame), while WARM deltas
// already never re-ship it (it is clean — immutable — so the dirty/version walk prunes it). So a session
// that re-frames does NOT re-ship immutable code/config, and the warm path needs no content leaf. Both
// arms stay id-consistent because neither subForFullWire nor adoptBaseline collapses the subgraph to a
// leaf — they walk it in full, exactly as the receiver does after resolving the hash to its cached copy.
// ================= §5 write-back AS a delta =====================================================
// A write-back is a delta whose target is the §5 master: ship the objects that changed in the reader's
// snapshot to the holder of the prior version, applied in place. The codec is content-based (it diffs
// the RESULT, not the operation), so a member assignment, an array push, a Map set, and a Set add are
// all handled uniformly — only the changed objects travel, never the whole snapshot. Stable ids come
// from adoptBaseline's deterministic DFS: the reader baselines the snapshot it fetched and the owner
// baselines its (still-identical, CAS-checked) master, so the two agree without coordinating ids.
const snapStack = (v) => [{ fn: "@snap", pc: 0, v }];
// Reader side: open a session over a freshly-fetched snapshot, recording the baseline so a later diff
// ships only what changed since.
export function openSnapshot(tierId, value) {
    const session = makeTrackedSession(tierId);
    session.fields = true; // per-field/element granularity: a write-back ships only the slots that changed
    adoptBaseline(session, snapStack(value), null); // deterministic ids + per-slot baseline, shared with the owner's baseline
    session.peerVer = new Map();
    const { ver } = scan(session, [value]); // baseline content versions (per object)
    for (const [id, vv] of ver)
        session.peerVer.set(id, vv);
    return session;
}
// Reader side: has the snapshot changed since its baseline? Pure query — unlike diffSnapshot it does
// NOT advance the baseline, so a retention policy can ask it repeatedly (an entry with an unshipped
// mutation must not be evicted; see coherence.mjs).
export function dirtySnapshot(session, value) {
    const { reach, ver } = scan(session, [value]);
    for (const id of reach.keys())
        if (session.peerVer.get(id) !== ver.get(id))
            return true;
    return false;
}
// Reader side: diff the (now-mutated) snapshot against its baseline and emit the changed objects. The
// baseline advances, so a second write-back from the same snapshot ships only what changed since the first.
export function diffSnapshot(session, value) {
    const { reach, ver } = scan(session, [value]);
    const changed = [...reach.keys()].filter((id) => session.peerVer.get(id) !== ver.get(id));
    const bytes = emit(session, [value], [{ fn: "@snap", pc: 0, keys: ["v"], b0: 0 }], null, changed);
    for (const [id, vv] of ver)
        session.peerVer.set(id, vv);
    return bytes;
}
// Reader side: encode the WHOLE snapshot (every reachable object) under the SAME fetch-anchored
// baseline the delta arm and the owner's applySnapshot use, so the caller can take min(delta, whole)
// and either arm lands on the right master shells. It MUST reuse the session, not re-baseline over the
// mutated value: a fresh DFS renumbers @ids the moment a mutation changes the graph's pre-order shape,
// so a whole built that way drops records on the wrong shell (an array record onto an object, etc.).
// With the shared baseline a "whole" really is just a delta in which every reachable object changed.
export function wholeSnapshot(session, value) {
    const { reach } = scan(session, [value]);
    return emit(session, [value], [{ fn: "@snap", pc: 0, keys: ["v"], b0: 0 }], null, [...reach.keys()], true); // full=true
}
// Owner side: apply a snapshot delta onto the master IN PLACE. Baselines the master (matching ids — it
// is unchanged since the reader fetched, guaranteed by the CAS the caller already checked), then mutates
// only the shipped objects; unchanged objects resolve to the master's own instances (identity preserved).
export function applySnapshot(tierId, master, bytes) {
    const session = makeTrackedSession(tierId);
    adoptBaseline(session, snapStack(master), null);
    reconstruct(session, parseDelta(bytes));
    return master;
}

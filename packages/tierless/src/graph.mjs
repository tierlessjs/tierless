// Tierless — identity-preserving, cycle-safe graph codec for continuation state.
//
// The naive wire format (per-value JSON) loses object identity (shared refs
// become separate copies) and throws on cycles — see test/probes/heap.mjs. A real
// continuation references an object graph with sharing and cycles, so the wire
// format must encode the GRAPH, not each value independently.
//
// encodeGraph(values, {tier, threshold}) walks all values reachable from the
// roots, assigns each distinct object/array an id, and emits a flat table where
// every reference is an {k:"r", id}. That:
//   - preserves identity   : the same object is one table entry, referenced by id
//   - survives cycles      : an object's id is reserved before its fields recurse
//   - keeps continuations small : a subgraph bigger than `threshold` becomes a §5
//     handle into the owning tier's heap (a leaf — it stays tier-local)
// The encoded form is acyclic and JSON-safe; decodeGraph rebuilds the graph,
// pre-creating each object so cycles and sharing are restored exactly.
export function isHandle(x) {
    return x !== null && typeof x === "object" && x.__tierless_handle__ === true;
}
// Host standard-library globals exposed to compiled code. They are code/identity,
// not data: a GLOBAL op pushes them, and the codec ships them BY REFERENCE (a
// {k:"glob"} tag re-bound per tier) — never deep-copied. Matches how closures and
// class objects travel.
export const GLOBALS = { Math, JSON, Object, Array, Number, String, Boolean, parseInt, parseFloat, isNaN, isFinite, console, Date, Symbol };
const GLOBAL_NAME = new Map(Object.entries(GLOBALS).map(([k, v]) => [v, k]));
const WELLKNOWN = new Map(Object.getOwnPropertyNames(Symbol).filter((k) => typeof Symbol[k] === "symbol").map((k) => [Symbol[k], k])); // Symbol.iterator, .asyncIterator, ...
// Cycle-safe, early-exiting size estimate (never JSON.stringify a cyclic graph).
export function approxExceeds(root, limit) {
    let total = 0;
    const seen = new Set();
    const stack = [root];
    while (stack.length) {
        const x = stack.pop();
        if (x === null || typeof x !== "object") {
            total += typeof x === "string" ? x.length : 8;
            if (total > limit)
                return true;
            continue;
        }
        if (seen.has(x))
            continue;
        seen.add(x);
        total += 16;
        if (total > limit)
            return true;
        if (Array.isArray(x)) {
            for (const e of x)
                stack.push(e);
        }
        else if (x instanceof Map) {
            total += 16 * x.size;
            if (total > limit)
                return true;
            for (const [k, v] of x) {
                stack.push(k);
                stack.push(v);
            }
        } // entries aren't enumerable own keys — traverse them or a huge Map looks ~empty and wrongly ships inline
        else if (x instanceof Set) {
            total += 16 * x.size;
            if (total > limit)
                return true;
            for (const e of x)
                stack.push(e);
        }
        else
            for (const k of Object.keys(x)) {
                total += k.length;
                stack.push(x[k]);
            }
    }
    return false;
}
export function encodeGraph(values, { tier = null, threshold = 64 * 1024, content = null } = {}) {
    const objs = []; // id -> { k:"a"|"o"|"H"|"c", ... }
    const idOf = new Map(); // object -> id (identity + cycle handling)
    function enc(v) {
        let cah; // set if v is a registered immutable subgraph shipped inline this once (tags its slot for the receiver to cache)
        if (v === undefined)
            return { k: "u" };
        if (typeof v === "bigint")
            return { k: "big", v: v.toString() }; // BigInt isn't JSON-safe
        if (typeof v === "symbol") { // well-known by name; Symbol.for by key; unique by graph node (identity within a round-trip)
            if (WELLKNOWN.has(v))
                return { k: "symw", name: WELLKNOWN.get(v) };
            const key = Symbol.keyFor(v);
            if (key !== undefined)
                return { k: "symf", key };
            if (idOf.has(v))
                return { k: "r", id: idOf.get(v) };
            const id = objs.length;
            idOf.set(v, id);
            objs.push({ k: "symu", d: v.description });
            return { k: "r", id };
        }
        if (GLOBAL_NAME.has(v))
            return { k: "glob", name: GLOBAL_NAME.get(v) }; // host global -> by reference
        if (v === null || typeof v !== "object")
            return { k: "p", v };
        if (idOf.has(v))
            return { k: "r", id: idOf.get(v) };
        if (isHandle(v)) {
            const id = objs.length;
            idOf.set(v, id);
            objs.push({ k: "H", h: v });
            return { k: "r", id };
        }
        if (content) { // content-addressed immutable subgraph (code / class shapes / config)
            const h = content.store.hashFor(v);
            if (h !== undefined) {
                if (content.peer.has(h)) {
                    const id = objs.length;
                    idOf.set(v, id);
                    objs.push({ k: "c", h });
                    return { k: "r", id };
                } // peer holds it -> ship the hash, not the bytes
                content.peer.add(h);
                cah = h; // first time: ship inline once and tag so the receiver caches it by hash
            }
        }
        // big subgraph -> §5 handle into the owning tier's heap (stays tier-local)
        if (tier && approxExceeds(v, threshold)) {
            const id = objs.length;
            idOf.set(v, id);
            objs.push({ k: "H", h: { __tierless_handle__: true, owner: tier.id, id: tier.heapPut(v), kind: Array.isArray(v) ? "array" : "object" } });
            return { k: "r", id };
        }
        const id = objs.length;
        idOf.set(v, id); // reserve id BEFORE recursing (cycle-safe)
        if (v instanceof Map) {
            const slot = { k: "map", e: [] };
            objs.push(slot);
            if (cah !== undefined)
                slot.cah = cah;
            for (const [mk, mv] of v)
                slot.e.push([enc(mk), enc(mv)]);
            return { k: "r", id };
        }
        if (v instanceof Set) {
            const slot = { k: "set", e: [] };
            objs.push(slot);
            if (cah !== undefined)
                slot.cah = cah;
            for (const sv of v)
                slot.e.push(enc(sv));
            return { k: "r", id };
        }
        if (Array.isArray(v)) {
            const slot = { k: "a", e: [] };
            objs.push(slot);
            if (cah !== undefined)
                slot.cah = cah;
            for (let i = 0; i < v.length; i++)
                slot.e.push(enc(v[i]));
            return { k: "r", id };
        } // by index: holes -> undefined
        const slot = { k: "o", f: {} };
        objs.push(slot);
        if (cah !== undefined)
            slot.cah = cah;
        for (const key of Object.getOwnPropertyNames(v)) { // include non-enumerable (instance methods/tags) so behavior survives the wire
            const desc = Object.getOwnPropertyDescriptor(v, key);
            if (!("value" in desc))
                continue; // skip host getters/setters (not our data)
            if (key === "__proto__")
                continue; // strip: a __proto__ data key is an injection vector, and `slot.f[key]=` would corrupt the slot's prototype
            slot.f[key] = enc(v[key]);
            if (!desc.enumerable)
                (slot.h || (slot.h = {}))[key] = 1; // remember which keys to restore as non-enumerable
        }
        for (const sym of Object.getOwnPropertySymbols(v)) { // symbol-keyed properties (o[Symbol(...)] = ...)
            const desc = Object.getOwnPropertyDescriptor(v, sym);
            if (!("value" in desc))
                continue;
            (slot.sf || (slot.sf = [])).push([enc(sym), enc(v[sym]), desc.enumerable ? 1 : 0]);
        }
        return { k: "r", id };
    }
    return { roots: values.map(enc), objs };
}
// A bigint crosses the wire as a decimal string; a hostile peer can send a non-numeric one.
// Bare BigInt() throws SyntaxError, which would escape the reader's "clean RangeError on bad
// input" contract (see wire-binary.mts) — normalize it here, at the §7 trust boundary.
export function toBigInt(s) {
    try {
        return BigInt(s);
    }
    catch {
        throw new RangeError("wire: invalid bigint literal");
    }
}
export function decodeGraph({ roots, objs }, { content = null } = {}) {
    const built = objs.map((s) => (s.k === "a" ? [] : s.k === "o" ? {} : s.k === "map" ? new Map() : s.k === "set" ? new Set() : s.k === "symu" ? Symbol(s.d) : s.k === "c" ? (content && content.store.get(s.h)) : s.h)); // pre-create for cycles/sharing; k:"c" resolves to the held immutable subgraph
    const dec = (n) => (n.k === "u" ? undefined : n.k === "big" ? toBigInt(n.v) : n.k === "glob" ? GLOBALS[n.name] : n.k === "symw" ? Symbol[n.name] : n.k === "symf" ? Symbol.for(n.key) : n.k === "p" ? n.v : built[n.id]);
    objs.forEach((s, i) => {
        if (s.k === "a")
            for (const n of s.e)
                built[i].push(dec(n));
        else if (s.k === "o") {
            for (const key in s.f) {
                const val = dec(s.f[key]);
                if ((s.h && s.h[key]) || key === "__proto__")
                    Object.defineProperty(built[i], key, { value: val, writable: true, enumerable: !(s.h && s.h[key]), configurable: true });
                else
                    built[i][key] = val;
            }
            if (s.sf)
                for (const [kn, vn, en] of s.sf) {
                    const key = dec(kn), val = dec(vn);
                    if (en)
                        built[i][key] = val;
                    else
                        Object.defineProperty(built[i], key, { value: val, writable: true, enumerable: false, configurable: true });
                }
        }
        else if (s.k === "map")
            for (const [kn, vn] of s.e)
                built[i].set(dec(kn), dec(vn));
        else if (s.k === "set")
            for (const vn of s.e)
                built[i].add(dec(vn));
        // k:"H" -> built[i] is already the handle object; k:"c" -> already resolved to the held subgraph
        if (content && s.cah !== undefined)
            content.store.put(s.cah, built[i]); // first arrival of an immutable subgraph: cache it by hash for later hash-only refs
    });
    return roots.map(dec);
}

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
/** Does v reach a function through plain containers? Bounded; deep or odd shapes count as
 *  holding one (they stay home rather than ship a lossy image). */
function holdsFunction(v, depth = 0) {
    if (typeof v === "function")
        return true;
    if (v === null || typeof v !== "object")
        return false;
    if (depth > 4)
        return true;
    return Object.values(v).some((x) => holdsFunction(x, depth + 1));
}
// ---- classes that cross by value --------------------------------------------------------
// A value copied across tiers loses its prototype: an error thrown by a twin on the gateway
// and caught by compiled code that finishes at home arrived as a plain object, so the app's
// `instanceof NetworkError` (and even `instanceof Error`) said no — Keycloak's console then
// showed no alert at all. Built-in errors keep their prototype by name; an app class keeps
// its own when BOTH tiers registered it with shareClass (a port's twins module does, since
// the browser and the gateway each load it). An unregistered Error subclass still decodes
// as an Error. Nothing else changes prototype: only registered classes are ever restored.
const SHARED = new Map();
const BUILTIN_ERRORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"]);
/** Stamp a class's identity and register it on THIS tier, so its instances keep their class
 *  when copied across tiers — and, as a §5 handle's `cls`, can dispatch to a session twin. */
/** Share a FUNCTION by name, the shareClass of plain helpers: register the same name on
 *  each tier (the app's twins module), and a closure that captured it (an imported helper
 *  such as a form-values converter) can call it wherever the run is — off-tier its caps
 *  view carries the name, and this tier's registered copy stands in. Only for functions
 *  that behave the same on every tier: pure, or reading only what both tiers have. */
const SHARED_FN = new Map(), FN_NAME = new WeakMap();
export function shareFunction(name, fn) {
    SHARED_FN.set(name, fn);
    FN_NAME.set(fn, name);
}
export function shareClass(name, cls) {
    cls.prototype.__tierless_cls = name;
    SHARED.set(name, cls.prototype);
}
/** The class a structurally-copied object carries: a stamped name, or "!<BuiltinError>". */
function classOf(v) {
    const p = Object.getPrototypeOf(v);
    if (p === Object.prototype || p === null)
        return null;
    const err = v instanceof Error;
    const stamp = Object.prototype.hasOwnProperty.call(p, "__tierless_cls") ? p.__tierless_cls : undefined;
    if (typeof stamp === "string")
        return { cls: stamp, err };
    if (err) {
        const n = v.constructor?.name;
        return { cls: "!" + (n && BUILTIN_ERRORS.has(n) ? n : "Error"), err };
    }
    return null;
}
export function protoFor(cls, err) {
    if (cls.startsWith("!")) {
        const n = cls.slice(1);
        return BUILTIN_ERRORS.has(n) ? globalThis[n].prototype : Error.prototype;
    }
    return SHARED.get(cls) ?? (err ? Error.prototype : undefined);
}
// ---- views: a caps object off its home tier -------------------------------------------
// A compiled closure's caps excise whole (writes stay home), which used to make EVERY caps
// read a reason to go home — so a dependent chain that reads a borrowed `id` between calls
// bounced back to the browser mid-chain. Primitives are immutable, so they can travel: off
// its home tier an excised caps decodes as a VIEW — primitive members in place, every
// other member a MEMBER handle (stamped ones carry their class and state, for twins). The
// stop rule reads members precisely (compiler slot refs "args[0].id"), so touching a
// primitive stays put and touching anything else still goes home.
export const VIEW = Symbol("tierless.view");
// a HYDRATED view member (runtime.mts hydrateViews): the session twin standing in for a
// borrowed member on this tier. Encoded, it is the member handle it replaced — home gets
// its own live object back, never a copy of the twin.
const HYDRATED = new WeakMap();
export function hydrated(twin, handle) { HYDRATED.set(twin, handle); }
/** The home handle of a twin on this tier (a session twin hydrated into a view, or a value
 *  twin a shipped closure brought), or undefined for any other object. */
export function twinOf(o) { return HYDRATED.get(o); }
function isPrimitive(x) {
    return x === null || typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x));
}
const VIEW_DEPTH = 3, VIEW_KEYS = 64;
function viewData(v, depth) {
    const d = { p: {}, c: {}, s: {}, f: {}, n: {}, o: [] };
    for (const [k, x] of Object.entries(v)) {
        if (x === undefined)
            continue; // absent and undefined read the same
        if (isPrimitive(x)) {
            d.p[k] = x;
            continue;
        }
        if (typeof x === "function") {
            const name = FN_NAME.get(x);
            if (name)
                d.f[k] = name;
            else
                d.o.push(k);
            continue;
        }
        const cls = stampOf(x);
        if (cls) {
            d.c[k] = cls;
            const data = {};
            for (const [f, fv] of Object.entries(x)) {
                if (holdsFunction(fv))
                    continue; // behavior, not state: {} after JSON would clobber the twin's own
                try {
                    const j = JSON.stringify(fv);
                    if (j !== undefined)
                        data[f] = JSON.parse(j);
                }
                catch { /* circular or unserializable: stays home */ }
            }
            d.s[k] = data;
            continue;
        }
        const proto = Object.getPrototypeOf(x);
        if ((proto === Object.prototype || proto === null) && depth + 1 < VIEW_DEPTH && Object.keys(x).length <= VIEW_KEYS)
            d.n[k] = viewData(x, depth + 1);
        else
            d.o.push(k);
    }
    return d;
}
function viewOf(v) { return JSON.stringify(viewData(v, 0)); }
// Built from the data, with VIEW naming the handle this level came from (the caps handle,
// or a member handle for a nested level): encoded, a view goes home as that handle, and
// any whole-object use of it (a write, a call with it as `this`) finds the handle and
// parks home — only a member-precise read of a primitive stays.
function viewBuild(d, h) {
    const v = {};
    Object.defineProperty(v, VIEW, { value: h });
    const member = (k) => ({ __tierless_handle__: true, owner: h.owner, id: h.id, path: [...(h.path ?? []), k] });
    for (const [k, x] of Object.entries(d.p))
        v[k] = x;
    for (const [k, cls] of Object.entries(d.c))
        v[k] = { ...member(k), cls, ...(d.s[k] ? { state: d.s[k] } : {}) };
    for (const [k, name] of Object.entries(d.f))
        v[k] = SHARED_FN.get(name) ?? member(k); // this tier's own copy, if registered here
    for (const [k, nd] of Object.entries(d.n))
        v[k] = viewBuild(nd, member(k));
    for (const k of d.o)
        v[k] = member(k);
    return v;
}
function viewFrom(h) {
    const { view: _v, ...handle } = h; // nested levels' handles carry no view of their own
    return viewBuild(JSON.parse(h.view), h.path ? handle : h);
}
function stampOf(v) {
    const proto = v && typeof v === "object" ? Object.getPrototypeOf(v) : null;
    const cls = proto && Object.prototype.hasOwnProperty.call(proto, "__tierless_cls") ? proto.__tierless_cls : undefined;
    return typeof cls === "string" ? cls : undefined;
}
export const isCompiledFn = (v) => typeof v === "function" && v.__tierless_sync === true
    && typeof v.__tierless_program === "string" && typeof v.__tierless_caps === "function";
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
/** `claimed` (the encoder's excise predicate) marks values that ship as a handle whatever
 *  their size: they cost a handle here, and their graph is not walked. Without it a small
 *  frame args array holding a borrowed service ([caps, first, max]) measured the service's
 *  whole reachable graph — Keycloak's admin client is far over 8 KB — and the ARGS ARRAY
 *  itself was excised, so the far side saw F.args as a handle and F.args[0] as undefined. */
export function approxExceeds(root, limit, claimed) {
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
        if (claimed && x !== root && claimed(x)) {
            total += 32;
            if (total > limit)
                return true;
            continue;
        }
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
export function encodeGraph(values, { tier = null, threshold = 64 * 1024, content = null, excise = null } = {}) {
    const objs = []; // id -> { k:"a"|"o"|"H"|"c", ... }
    const idOf = new Map(); // object -> id (identity + cycle handling)
    // §5 excision: park v in the local heap, emit the handle leaf (identity-deduped).
    // The class stamp rides ONLY for DIRECT instances of the stamped class: a subclass
    // may override the very method a far-side dispatch would resolve to the BASE machine,
    // silently running the wrong code. Subclass instances stay unstamped — their calls
    // park home (or hit a session twin, which constructs the real subclass and is exact).
    const exciseTo = (v, owned) => {
        const id = objs.length;
        idOf.set(v, id);
        const cls = stampOf(v);
        const proto = v && typeof v === "object" ? Object.getPrototypeOf(v) : undefined;
        // an OWNED plain object (not one excised for size — that one's contents are the point
        // of keeping it home) describes its members for the far side's view
        const view = owned && (proto === Object.prototype || proto === null) ? viewOf(v) : undefined;
        const slot = { k: "H", h: { __tierless_handle__: true, owner: tier.id, id: tier.heapPut(v), kind: Array.isArray(v) ? "array" : "object", ...(cls ? { cls } : {}), ...(view ? { view } : {}) } };
        objs.push(slot);
        // a view's compiled sync closures (a captured `t`) ship as graph values beside it:
        // the far side's view gets a callable member, not a member handle
        if (view)
            for (const [k, x] of Object.entries(v))
                if (isCompiledFn(x))
                    (slot.m ??= {})[k] = enc(x);
        return { k: "r", id };
    };
    // VALUE TWINS — the engine's move-the-data-or-the-stack choice for a shipped sync
    // closure's instance (its `this`, a library object such as an i18n instance). Ownership
    // would excise it as a unit; inside a closure's caps a stamped instance instead ships
    // WHOLE when it holds only data (no function, host object or handle anywhere in it) and
    // fits the threshold — the same two tests a plain object passes — tagged with its home
    // identity (slot "o" + tw). The far side rebuilds it with its class (the module's
    // shareClass stamps), tracks it as a twin (writes ride home as twin deltas, runtime.mts
    // hydrateViews) and sends it home as its handle. Over the threshold, or holding behavior,
    // it excises as before, and the stop rule parks the calling segment home.
    let inCaps = 0;
    const holdsOwned = (root) => {
        const seen = new Set(), work = [root];
        while (work.length) {
            const x = work.pop();
            if (typeof x === "function") {
                if (isCompiledFn(x)) {
                    work.push(x.__tierless_caps());
                    continue;
                }
                return true;
            } // a compiled closure is a value — complete only if its caps are; any other function is behavior
            if (x === null || typeof x !== "object" || seen.has(x))
                continue;
            seen.add(x);
            if (x instanceof Date || x instanceof Uint8Array || GLOBAL_NAME.has(x))
                continue;
            if (isHandle(x) || HYDRATED.has(x) || x[VIEW])
                return true; // another tier's object: a copy can't carry it
            if (!stampOf(x) && excise(x))
                return true;
            if (Array.isArray(x)) {
                for (const e of x)
                    work.push(e);
            }
            else if (x instanceof Map) {
                for (const [k, e] of x) {
                    work.push(k);
                    work.push(e);
                }
            }
            else if (x instanceof Set) {
                for (const e of x)
                    work.push(e);
            }
            else
                for (const k of [...Object.getOwnPropertyNames(x), ...Object.getOwnPropertySymbols(x)]) {
                    const d = Object.getOwnPropertyDescriptor(x, k);
                    if (!("value" in d))
                        return true;
                    work.push(d.value);
                } // an own accessor computes from anything: behavior
        }
        return false;
    };
    const valueTwin = (v) => inCaps > 0 && stampOf(v) !== undefined && !holdsOwned(v) && !approxExceeds(v, threshold, null);
    function enc(v) {
        let cah; // set if v is a registered immutable subgraph shipped inline this once (tags its slot for the receiver to cache)
        if (v === undefined)
            return { k: "u" };
        if (typeof v === "bigint")
            return { k: "big", v: v.toString() }; // BigInt isn't JSON-safe
        if (typeof v === "function" && isCompiledFn(v)) { // a compiled sync closure: program + caps, callable wherever the program is
            if (idOf.has(v))
                return { k: "r", id: idOf.get(v) };
            const fh = HYDRATED.get(v); // a stub this tier decoded: it goes back as its home handle
            if (fh) {
                const id = objs.length;
                idOf.set(v, id);
                objs.push({ k: "H", h: fh });
                return { k: "r", id };
            }
            const id = objs.length;
            idOf.set(v, id);
            // hm: the closure's home identity — it comes home as itself, and a tier without its
            // program sees an opaque handle (the stop rule parks the touching segment home)
            const slot = { k: "fn", p: v.__tierless_program, c: null, f: {}, ...(tier ? { hm: { owner: tier.id, id: tier.heapPut(v) } } : {}) };
            objs.push(slot); // registered first: the caps may name the closure itself
            inCaps++;
            try {
                const caps = v.__tierless_caps();
                // the compiled builder returns a fresh plain object (nothing at home aliases it, so
                // it needs no excision of its own); anything else takes the ordinary path
                const fresh = caps !== null && typeof caps === "object" && (Object.getPrototypeOf(caps) === Object.prototype || Object.getPrototypeOf(caps) === null) && !isHandle(caps) && !caps[VIEW] && !HYDRATED.has(caps);
                slot.c = fresh ? encData(caps) : enc(caps);
            }
            finally {
                inCaps--;
            }
            for (const k of Object.keys(v))
                if (!k.startsWith("__tierless_"))
                    slot.f[k] = enc(v[k]);
            return { k: "r", id };
        }
        if (typeof v === "function" && tier && excise && excise(v)) { // a function's effect lives in this heap — keep its identity home
            if (idOf.has(v))
                return { k: "r", id: idOf.get(v) };
            return exciseTo(v, true);
        }
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
            const { state: _s, ...h } = v;
            objs.push({ k: "H", h });
            return { k: "r", id };
        }
        const hh = HYDRATED.get(v);
        if (hh) {
            const id = objs.length;
            idOf.set(v, id);
            objs.push({ k: "H", h: hh });
            return { k: "r", id };
        }
        // a VIEW goes back as the handle it was decoded from: home gets its own live object
        const vh = v[VIEW];
        if (vh) {
            if (idOf.has(vh))
                return { k: "r", id: idOf.get(vh) };
            const id = objs.length;
            idOf.set(vh, id);
            idOf.set(v, id);
            objs.push({ k: "H", h: vh });
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
        // §5 handle into the owning tier's heap (stays tier-local): claimed by ownership
        // (the migrate arm's live instances/host objects) or simply too big to ship
        if (tier && excise && excise(v))
            return valueTwin(v) ? encData(v, { owner: tier.id, id: tier.heapPut(v) }) : exciseTo(v, true);
        if (tier && approxExceeds(v, threshold, excise))
            return exciseTo(v, false);
        return encData(v, undefined, cah);
    }
    // a container or object by value (tw: a value twin's home identity)
    function encData(v, tw, cah) {
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
        if (tw)
            slot.tw = tw;
        const kc = classOf(v);
        if (kc) {
            slot.cls = kc.cls;
            if (kc.err)
                slot.err = 1;
        }
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
// input" contract (see wire-io.mts) — normalize it here, at the §7 trust boundary.
export function toBigInt(s) {
    try {
        return BigInt(s);
    }
    catch {
        throw new RangeError("wire: invalid bigint literal");
    }
}
export function decodeGraph({ roots, objs }, { content = null, tier = null, programs = null } = {}) {
    const mkStub = (s, run) => {
        const stub = Object.assign((...a) => {
            if (!run)
                throw new Error("tierless: compiled closure " + s.p + " is not available on this tier");
            return run(stub.__tierless_caps(), a);
        }, { __tierless_program: s.p, __tierless_sync: true, __tierless_caps: () => undefined });
        return stub;
    };
    // a shipped closure (slot "fn"): coming home, the live closure itself; off-tier, a stub
    // over this tier's program — or, without the program here, its opaque handle, so the
    // stop rule parks the segment that would call it home (a stub that throws is the last
    // resort, for a graph encoded with no tier)
    const fnOwn = (s) => !!(tier && s.hm && s.hm.owner === tier.id);
    const fnShell = (s) => {
        if (fnOwn(s))
            return home({ __tierless_handle__: true, owner: s.hm.owner, id: s.hm.id });
        const run = programs?.(s.p);
        if (!run && s.hm)
            return { __tierless_handle__: true, owner: s.hm.owner, id: s.hm.id, kind: "function" };
        const stub = mkStub(s, run);
        if (s.hm)
            HYDRATED.set(stub, { __tierless_handle__: true, owner: s.hm.owner, id: s.hm.id, kind: "function" });
        return stub;
    };
    // A copy (value twin) must hold no handle and no closure this tier can't run: a native
    // method over the copy would reach them with no stop rule in between. The encoder
    // promises that, but this side is a trust boundary (§7), so the promise is CHECKED here
    // over the slot graph: a copy that would break it decodes as its handle instead.
    const copyOk = new Map();
    const fnRunnable = (s) => fnOwn(s) || !!programs?.(s.p);
    const refsOf = (n, out) => { if (n && typeof n === "object" && n.k === "r")
        out.push(n.id); };
    const slotRefs = (s) => {
        const out = [];
        if (s.k === "a" || s.k === "set")
            for (const e of s.e)
                refsOf(e, out);
        else if (s.k === "map")
            for (const [kn, vn] of s.e) {
                refsOf(kn, out);
                refsOf(vn, out);
            }
        else if (s.k === "o") {
            for (const key in s.f)
                refsOf(s.f[key], out);
            if (s.sf)
                for (const [kn, vn] of s.sf) {
                    refsOf(kn, out);
                    refsOf(vn, out);
                }
        }
        else if (s.k === "fn") {
            refsOf(s.c, out);
            for (const key in s.f)
                refsOf(s.f[key], out);
        }
        else if (s.k === "H" && s.m)
            for (const key in s.m)
                refsOf(s.m[key], out);
        return out;
    };
    const twinOk = (root) => {
        const known = copyOk.get(root);
        if (known !== undefined)
            return known;
        copyOk.set(root, true); // provisional, for cycles
        const seen = new Set([root]), work = [root];
        let ok = true;
        while (ok && work.length) {
            const i = work.pop(), s = objs[i];
            if (s.k === "H")
                ok = !!(tier && s.h.owner === tier.id); // a foreign handle: the copy would hide it
            else if (s.k === "fn") {
                ok = fnRunnable(s);
                if (fnOwn(s))
                    continue;
            } // a live closure of ours holds what it holds
            else if (s.k === "o" && s.tw && i !== root) {
                if (tier && s.tw.owner === tier.id)
                    continue;
                ok = twinOk(i);
            } // a nested copy stands or falls on its own
            if (!ok)
                break;
            for (const j of slotRefs(s))
                if (!seen.has(j)) {
                    seen.add(j);
                    work.push(j);
                }
        }
        copyOk.set(root, ok);
        return ok;
    };
    const home = (h) => {
        if (!tier || h.owner !== tier.id)
            return h.view ? viewFrom(h) : h;
        let v = tier.heapGet(h.id);
        if (v === undefined)
            throw new RangeError("wire: unknown local handle " + h.id);
        for (const k of h.path ?? [])
            v = v[k]; // a member handle: that member of the live object
        return v;
    };
    // a value twin (slot "o" + tw): coming home, the live instance itself; off-tier, a copy
    // with its class — or, where the class isn't registered, its handle (the stop rule then
    // parks the touching segment home rather than run methods a copy wouldn't have)
    const twinHandle = (s) => ({ __tierless_handle__: true, owner: s.tw.owner, id: s.tw.id, kind: "object", ...(s.cls ? { cls: s.cls } : {}) });
    const twinShell = (s, i) => (tier && s.tw.owner === tier.id ? home(twinHandle(s)) : s.cls && protoFor(s.cls, !!s.err) && twinOk(i) ? {} : twinHandle(s));
    const built = objs.map((s, i) => (s.k === "a" ? [] : s.k === "o" ? (s.tw ? twinShell(s, i) : {}) : s.k === "map" ? new Map() : s.k === "set" ? new Set() : s.k === "symu" ? Symbol(s.d) : s.k === "fn" ? fnShell(s) : s.k === "c" ? (content && content.store.get(s.h)) : home(s.h))); // pre-create for cycles/sharing; k:"c" resolves to the held immutable subgraph
    const dec = (n) => (n.k === "u" ? undefined : n.k === "big" ? toBigInt(n.v) : n.k === "glob" ? GLOBALS[n.name] : n.k === "symw" ? Symbol[n.name] : n.k === "symf" ? Symbol.for(n.key) : n.k === "p" ? n.v : built[n.id]);
    objs.forEach((s, i) => {
        if (s.k === "a")
            for (const n of s.e)
                built[i].push(dec(n));
        else if (s.k === "o" && s.tw && (isHandle(built[i]) || (tier && s.tw.owner === tier.id))) { /* the handle, or the live instance: its fields are not the copy's */ }
        // a data slot never decodes into a handle's shape (handles are slots of their own), nor rebuilds a hostile __proto__ key
        else if (s.k === "o") {
            if (s.cls) {
                const p = protoFor(s.cls, !!s.err);
                if (p)
                    Object.setPrototypeOf(built[i], p);
            }
            if (s.tw)
                hydrated(built[i], twinHandle(s));
            for (const key in s.f) {
                if (key === "__proto__" || key === "__tierless_handle__")
                    continue;
                const val = dec(s.f[key]);
                if (s.h && s.h[key])
                    Object.defineProperty(built[i], key, { value: val, writable: true, enumerable: false, configurable: true });
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
        } // drop a hostile __proto__ key (our encoder strips it), consistent with wire-binary/wire-delta — never reconstruct it, even as an own property
        else if (s.k === "map")
            for (const [kn, vn] of s.e)
                built[i].set(dec(kn), dec(vn));
        else if (s.k === "set")
            for (const vn of s.e)
                built[i].add(dec(vn));
        else if (s.k === "fn" && (fnOwn(s) || isHandle(built[i]))) { /* the live closure, or its handle: nothing to fill */ }
        else if (s.k === "fn") {
            const caps = dec(s.c);
            built[i].__tierless_caps = () => caps;
            for (const key in s.f) {
                if (key === "__proto__")
                    continue;
                built[i][key] = dec(s.f[key]);
            }
        }
        else if (s.k === "H" && s.m && built[i] && built[i][VIEW])
            for (const key in s.m) {
                if (key === "__proto__")
                    continue;
                built[i][key] = dec(s.m[key]);
            } // a foreign view's shipped closures (an owned handle resolved to the live object needs nothing)
        // k:"H" -> built[i] is already the handle object; k:"c" -> already resolved to the held subgraph
        if (content && s.cah !== undefined)
            content.store.put(s.cah, built[i]); // first arrival of an immutable subgraph: cache it by hash for later hash-only refs
    });
    return roots.map(dec);
}

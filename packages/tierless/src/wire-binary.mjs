// Binary wire codec — a compact alternative to the JSON graph wire (heap.mjs encodeWire).
// Same logical content and an identical decode result; it just attacks the JSON form's
// structural tax with the three high-leverage levers from the wire deep-dive:
//   - 1-byte TYPE TAGS + LEB128 varints instead of {"k":"r","id":N} ref objects,
//   - a STRING table: every object key and string value is interned, referenced by index,
//   - a SHAPE table: objects sharing a key-set emit the keys ONCE, then just their values.
// It serializes the SAME {frames, req, {roots, objs}} structure encodeWire builds, so it
// reuses encodeGraph's proven graph-building/excision and decodeGraph's cycle-safe
// reconstruction unchanged — only the serialization of that structure is swapped. Browser-
// safe (Uint8Array/DataView/TextEncoder, no Buffer); ships as one binary frame.
import { encodeGraph, decodeGraph } from "./graph.mjs";
import { W, R, isVarInt, writeMagic, checkMagic, makeInterner, writeStrings, readStrings, strAt, rootsOf, rebuildStack, writeFrameHeader, readFrameHeader } from "./wire-io.mjs";
const MAGIC = "SMW1";
// The writer/hardened reader, magic header, string table, and frame flatten/rebuild live in
// wire-io.mts (one copy, shared with the delta wire). This file owns only what is binary-
// format-specific: the shape table, the node/slot tag encodings, and the numeric-array packs.
// node tags: 0 ref, 1 int, 2 float, 3 str, 4 true, 5 false, 6 null, 7 undef, 8 bigint, 9 glob, 10 symw, 11 symf
// slot tags: 0 array, 1 object, 2 map, 3 set, 4 handle, 5 unique-symbol, 6 numeric-array,
//            7 content-ref leaf (peer holds the hash), 8 content-cache wrapper (ship inline once, cache under hash)
const zlen = (x) => { let v = x >= 0 ? x * 2 : -x * 2 - 1, n = 1; while (v >= 128) {
    v = Math.floor(v / 128);
    n++;
} return n; }; // bytes of zigzag varint(x)
// The graph codec's internal wire-node/slot shapes (graph.mts's own enc/dec keep these as
// `any` too) — a handful of tagged-union variants (node: r/u/big/glob/symw/symf/p; slot:
// a/o/map/set/H/symu) that only writeNode/readNode/encodeWireBinary/decodeWireBinary ever
// branch on, so modeling them as a full discriminated union buys nothing over `any` here.
function writeNode(w, n, intern) {
    switch (n.k) {
        case "r":
            w.u8(0);
            w.varu(n.id);
            break;
        case "u":
            w.u8(7);
            break;
        case "big":
            w.u8(8);
            w.varu(intern(n.v));
            break;
        case "glob":
            w.u8(9);
            w.varu(intern(n.name));
            break;
        case "symw":
            w.u8(10);
            w.varu(intern(n.name));
            break;
        case "symf":
            w.u8(11);
            w.varu(intern(n.key));
            break;
        default: { // "p"
            const v = n.v;
            if (v === null)
                w.u8(6);
            else if (v === true)
                w.u8(4);
            else if (v === false)
                w.u8(5);
            else if (typeof v === "string") {
                w.u8(3);
                w.varu(intern(v));
            }
            else if (typeof v === "number") {
                if (isVarInt(v)) {
                    w.u8(1);
                    w.vari(v);
                }
                else {
                    w.u8(2);
                    w.f64(v);
                }
            }
            else
                w.u8(7); // unreachable for valid graphs
        }
    }
}
function readNode(r, S) {
    const t = r.u8();
    switch (t) {
        case 0: return { k: "r", id: r.varu() };
        case 1: return { k: "p", v: r.vari() };
        case 2: return { k: "p", v: r.f64() };
        case 3: return { k: "p", v: S(r.varu()) };
        case 4: return { k: "p", v: true };
        case 5: return { k: "p", v: false };
        case 6: return { k: "p", v: null };
        case 7: return { k: "u" };
        case 8: return { k: "big", v: S(r.varu()) };
        case 9: return { k: "glob", name: S(r.varu()) };
        case 10: return { k: "symw", name: S(r.varu()) };
        case 11: return { k: "symf", key: S(r.varu()) };
        default: throw new RangeError("wire-binary: bad node tag " + t);
    }
}
// Serialize a continuation, mirroring encodeWire's frame-flattening, then writing the
// {frames, req, {roots, objs}} structure as bytes. opts (tier/threshold) drive §5 excision.
export function encodeWireBinary(stack, request, { tier = null, threshold = 8192, content = null, excise = null } = {}) {
    const { rootVals, frames, req } = rootsOf(stack, request);
    const graph = encodeGraph(rootVals, { tier, threshold, content, excise });
    // pass 1: intern strings and collect object shapes ------------------------------------
    const { strs, intern } = makeInterner();
    const shapeMap = new Map(), shapes = []; // sig -> idx; shapes[idx] = [[keyStrIdx, nonEnum], ...]
    const slotShape = new Array(graph.objs.length);
    const internNode = (n) => { if (n.k === "big")
        intern(n.v);
    else if (n.k === "glob" || n.k === "symw")
        intern(n.name);
    else if (n.k === "symf")
        intern(n.key);
    else if (n.k === "p" && typeof n.v === "string")
        intern(n.v); };
    for (const f of frames) {
        intern(f.fn);
        for (const k of f.keys)
            intern(k);
    }
    if (req) {
        intern(req.op);
        intern(req.tier);
        intern(req.name);
    }
    for (const n of graph.roots)
        internNode(n);
    for (let i = 0; i < graph.objs.length; i++) {
        const s = graph.objs[i];
        if (s.cah !== undefined)
            intern(s.cah); // a content-addressed subgraph shipped inline once: intern its hash so the receiver caches it
        if (s.k === "c") {
            intern(s.h);
        } // a content-ref leaf: just the hash crosses
        else if (s.k === "a" || s.k === "set") {
            for (const e of s.e)
                internNode(e);
        }
        else if (s.k === "map") {
            for (const [kn, vn] of s.e) {
                internNode(kn);
                internNode(vn);
            }
        }
        else if (s.k === "o") {
            const keys = Object.keys(s.f);
            const sig = keys.map((k) => intern(k) + ":" + (s.h && s.h[k] ? 1 : 0)).join(",");
            let si = shapeMap.get(sig);
            if (si === undefined) {
                si = shapes.length;
                shapeMap.set(sig, si);
                shapes.push(keys.map((k) => [intern(k), s.h && s.h[k] ? 1 : 0]));
            }
            slotShape[i] = si;
            for (const k of keys)
                internNode(s.f[k]);
            if (s.sf)
                for (const [kn, vn] of s.sf) {
                    internNode(kn);
                    internNode(vn);
                }
        }
        else if (s.k === "H") {
            intern(s.h.owner);
            intern(String(s.h.id));
            if (s.h.kind)
                intern(s.h.kind);
        }
        else if (s.k === "symu") {
            if (s.d !== undefined)
                intern(s.d);
        }
    }
    // pass 2: write ------------------------------------------------------------------------
    const w = new W();
    writeMagic(w, MAGIC);
    writeStrings(w, strs);
    w.varu(shapes.length);
    for (const sh of shapes) {
        w.varu(sh.length);
        for (const [si, ne] of sh) {
            w.varu(si);
            w.u8(ne);
        }
    }
    writeFrameHeader(w, frames, req, intern);
    w.varu(graph.roots.length);
    for (const n of graph.roots)
        writeNode(w, n, intern);
    w.varu(graph.objs.length);
    for (let i = 0; i < graph.objs.length; i++) {
        const s = graph.objs[i];
        if (s.k === "c") {
            w.u8(7);
            w.varu(intern(s.h));
            continue;
        } // content-ref leaf: the peer holds it, so only the hash crosses
        if (s.cah !== undefined) {
            w.u8(8);
            w.varu(intern(s.cah));
        } // wrap: cache the slot that follows under this hash (shipped inline once)
        if (s.k === "a") {
            // typed-array fast path: an array of only number primitives pays no per-element tag.
            const nums = s.e.length && s.e.every((n) => n.k === "p" && typeof n.v === "number") ? s.e.map((n) => n.v) : null;
            if (!nums) {
                w.u8(0);
                w.varu(s.e.length);
                for (const e of s.e)
                    writeNode(w, e, intern);
            } // generic (mixed) array
            else if (!nums.every(isVarInt)) {
                w.u8(6);
                w.varu(nums.length);
                w.u8(1);
                for (const x of nums)
                    w.f64(x);
            } // f64 pack (floats/NaN/Inf/-0/big)
            else { // all small ints: plain varints vs deltas, whichever is smaller
                let plain = 0, delta = 0, prev = 0;
                for (const x of nums) {
                    plain += zlen(x);
                    delta += zlen(x - prev);
                    prev = x;
                }
                w.u8(6);
                w.varu(nums.length);
                if (delta < plain) {
                    w.u8(2);
                    let p = 0;
                    for (const x of nums) {
                        w.vari(x - p);
                        p = x;
                    }
                } // zigzag deltas (wins on id columns)
                else {
                    w.u8(0);
                    for (const x of nums)
                        w.vari(x);
                }
            }
        }
        else if (s.k === "o") {
            w.u8(1);
            w.varu(slotShape[i]);
            for (const k of Object.keys(s.f))
                writeNode(w, s.f[k], intern);
            const sf = s.sf || [];
            w.varu(sf.length);
            for (const [kn, vn, en] of sf) {
                writeNode(w, kn, intern);
                writeNode(w, vn, intern);
                w.u8(en);
            }
        }
        else if (s.k === "map") {
            w.u8(2);
            w.varu(s.e.length);
            for (const [kn, vn] of s.e) {
                writeNode(w, kn, intern);
                writeNode(w, vn, intern);
            }
        }
        else if (s.k === "set") {
            w.u8(3);
            w.varu(s.e.length);
            for (const e of s.e)
                writeNode(w, e, intern);
        }
        else if (s.k === "H") {
            w.u8(4);
            w.varu(intern(s.h.owner));
            w.varu(intern(String(s.h.id)));
            if (s.h.kind) {
                w.u8(1);
                w.varu(intern(s.h.kind));
            }
            else
                w.u8(0);
        }
        else if (s.k === "symu") {
            w.u8(5);
            if (s.d !== undefined) {
                w.u8(1);
                w.varu(intern(s.d));
            }
            else
                w.u8(0);
        }
    }
    return w.done();
}
export function decodeWireBinary(bytes, { content = null, tier = null } = {}) {
    const r = new R(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), "wire-binary");
    checkMagic(r, MAGIC);
    const strs = readStrings(r);
    const S = strAt(strs, "wire-binary");
    const shapes = [];
    {
        const n = r.count();
        for (let i = 0; i < n; i++) {
            const kc = r.count();
            const sh = [];
            for (let j = 0; j < kc; j++) {
                const si = r.varu();
                sh.push([si, r.u8()]);
            }
            shapes.push(sh);
        }
    }
    const SH = (i) => { if (i < 0 || i >= shapes.length)
        throw new RangeError("wire-binary: shape index out of range"); return shapes[i]; };
    const { frames, req } = readFrameHeader(r, S);
    const roots = [];
    {
        const n = r.count();
        for (let i = 0; i < n; i++)
            roots.push(readNode(r, S));
    }
    const readSlot = () => {
        let t = r.u8();
        let cah;
        while (t === 8) {
            cah = S(r.varu());
            t = r.u8();
        } // content-cache wrapper — unwrapped ITERATIVELY so a hostile 0x08 chain can't blow the stack
        let slot;
        if (t === 7)
            slot = { k: "c", h: S(r.varu()) }; // content-ref leaf — decodeGraph resolves it against the content store
        else if (t === 0) {
            const c = r.count(), e = [];
            for (let j = 0; j < c; j++)
                e.push(readNode(r, S));
            slot = { k: "a", e };
        }
        else if (t === 1) {
            const sh = SH(r.varu());
            const f = {}, h = {};
            for (const [si, ne] of sh) {
                const key = S(si);
                const val = readNode(r, S);
                if (key === "__proto__")
                    continue;
                f[key] = val;
                if (ne)
                    h[key] = 1;
            }
            slot = { k: "o", f };
            if (Object.keys(h).length)
                slot.h = h;
            const sfn = r.count();
            if (sfn) {
                slot.sf = [];
                for (let j = 0; j < sfn; j++) {
                    const kn = readNode(r, S), vn = readNode(r, S);
                    slot.sf.push([kn, vn, r.u8()]);
                }
            }
        }
        else if (t === 2) {
            const c = r.count(), e = [];
            for (let j = 0; j < c; j++)
                e.push([readNode(r, S), readNode(r, S)]);
            slot = { k: "map", e };
        }
        else if (t === 3) {
            const c = r.count(), e = [];
            for (let j = 0; j < c; j++)
                e.push(readNode(r, S));
            slot = { k: "set", e };
        }
        else if (t === 4) {
            const owner = S(r.varu()), id = S(r.varu());
            const h = { __tierless_handle__: true, owner, id };
            if (r.u8())
                h.kind = S(r.varu());
            slot = { k: "H", h };
        }
        else if (t === 5) {
            slot = { k: "symu", d: r.u8() ? S(r.varu()) : undefined };
        }
        else if (t === 6) {
            const c = r.count(), sub = r.u8(), e = [];
            if (sub === 0) {
                for (let j = 0; j < c; j++)
                    e.push({ k: "p", v: r.vari() });
            }
            else if (sub === 1) {
                for (let j = 0; j < c; j++)
                    e.push({ k: "p", v: r.f64() });
            }
            else if (sub === 2) {
                let p = 0;
                for (let j = 0; j < c; j++) {
                    p += r.vari();
                    e.push({ k: "p", v: p });
                }
            }
            else
                throw new RangeError("wire-binary: bad numeric-array sub-kind " + sub);
            slot = { k: "a", e };
        }
        else
            throw new RangeError("wire-binary: bad slot tag " + t);
        if (cah !== undefined)
            slot.cah = cah;
        return slot;
    };
    const objs = [];
    {
        const n = r.count();
        for (let i = 0; i < n; i++)
            objs.push(readSlot());
    }
    const vals = decodeGraph({ roots, objs }, { content, tier });
    return rebuildStack(frames, req, vals);
}
// A fresh start ships only the entry args — no continuation and no resource yet. Carry them through
// the same value-root machinery (handles, cycles, and all), rather than hand-rolling a placeholder
// ResourceRequest with a fake op: there is no request, so only `args` round-trips.
export const encodeArgs = (args, opts = {}) => encodeWireBinary([], { op: "", tier: "", name: "", args }, opts);
export const decodeArgs = (bytes) => decodeWireBinary(bytes).request?.args ?? [];

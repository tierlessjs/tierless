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
import { encodeGraph, decodeGraph, applyDeltas } from "./graph.mjs";
import { W, R, isVarInt, writeMagic, checkMagic, makeInterner, writeStrings, readStrings, strAt, rootsOf, rebuildStack, writeFrameHeader, readFrameHeader } from "./wire-io.mjs";
// SMW2: the handle record's flag byte became a bitfield (bit 1 kind, bit 2 cls) — an
// SMW1 decoder would read a flags-3 record as the old boolean form and parse the cls
// bytes as the next field, corrupting the frame. The magic bump makes a version-skewed
// peer fail cleanly at checkMagic instead.
// SMW3: slot tags 10 (a compiled closure: program, home identity, caps, own props) and
// 11 (a value twin's home identity, wrapping an object slot); a handle's flag bit 16
// (shipped closures beside a view). An SMW2 reader would reject tag 10 as a bad slot.
// SMW4: views are graph slots (tag 12: handle + members; tag 13: a shared function by
// name with its member handle); a handle record's flags are kind 1, cls 2, state 4 (a node
// follows), path 8, inst 16. The JSON view string and the handle's beside-members are gone.
// SMW5: a deltas section after the frame header — the writes a run made to views of
// the receiver's objects (runtime.mts viewDelta), each field a graph root — and node tag
// 12, a RegExp by value.
const MAGIC = "SMW5";
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
// `any` too) — a handful of tagged-union variants (node: r/u/big/glob/symw/symf/re/p; slot:
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
        case "re":
            w.u8(12);
            w.varu(intern(n.s));
            w.varu(intern(n.f));
            w.varu(n.li);
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
        case 12: return { k: "re", s: S(r.varu()), f: S(r.varu()), li: r.varu() };
        default: throw new RangeError("wire-binary: bad node tag " + t);
    }
}
// Serialize a continuation, mirroring encodeWire's frame-flattening, then writing the
// {frames, req, {roots, objs}} structure as bytes. opts (tier/threshold) drive §5 excision.
// a handle record: owner, id, flags (kind 1, cls 2, state-follows 4, path 8, inst 16), then the flagged fields
function writeHandle(w, h, intern, st) {
    w.varu(intern(h.owner));
    w.varu(intern(String(h.id)));
    w.u8((h.kind ? 1 : 0) | (h.cls ? 2 : 0) | (st ? 4 : 0) | (h.path ? 8 : 0) | (h.inst ? 16 : 0));
    if (h.kind)
        w.varu(intern(h.kind));
    if (h.cls)
        w.varu(intern(h.cls));
    if (h.path) {
        w.varu(h.path.length);
        for (const k of h.path)
            w.varu(intern(k));
    }
}
function readHandle(r, S) {
    const owner = S(r.varu()), id = S(r.varu());
    const h = { __tierless_handle__: true, owner, id };
    const fl = r.u8();
    if (fl & 1)
        h.kind = S(r.varu());
    if (fl & 2)
        h.cls = S(r.varu());
    if (fl & 8) {
        const c = r.count();
        h.path = [];
        for (let j = 0; j < c; j++)
            h.path.push(S(r.varu()));
    }
    if (fl & 16)
        h.inst = true;
    return { h, st: !!(fl & 4) };
}
const internHandleWith = (intern) => (h) => { intern(h.owner); intern(String(h.id)); if (h.kind)
    intern(h.kind); if (h.cls)
    intern(h.cls); for (const k of h.path ?? [])
    intern(k); };
export function encodeWireBinary(stack, request, { tier = null, threshold = 8192, content = null, excise = null, deltas = [] } = {}) {
    const { rootVals, frames, req } = rootsOf(stack, request);
    // view deltas: each field value is one more root of the same graph (a value shared
    // with a frame slot stays one object at home)
    const dl = deltas.map((d) => { const keys = Object.keys(d.fields); const f0 = rootVals.length; for (const k of keys)
        rootVals.push(d.fields[k]); return { d, keys, f0 }; });
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
    else if (n.k === "re") {
        intern(n.s);
        intern(n.f);
    }
    else if (n.k === "p" && typeof n.v === "string")
        intern(n.v); };
    const internHandle = internHandleWith(intern);
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
    for (const { d, keys } of dl) {
        intern(d.owner);
        intern(String(d.id));
        for (const x of d.path ?? [])
            intern(x);
        for (const k of keys)
            intern(k);
        for (const x of d.gone ?? [])
            intern(x);
    }
    for (const n of graph.roots)
        internNode(n);
    for (let i = 0; i < graph.objs.length; i++) {
        const s = graph.objs[i];
        if (s.cah !== undefined)
            intern(s.cah);
        if (s.cls !== undefined)
            intern(s.cls); // a content-addressed subgraph shipped inline once: intern its hash so the receiver caches it
        if (s.tw !== undefined) {
            intern(s.tw.owner);
            intern(String(s.tw.id));
        }
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
            internHandle(s.h);
            if (s.st !== undefined)
                internNode(s.st);
        }
        else if (s.k === "v") {
            internHandle(s.h);
            if (s.e) {
                for (const e of s.e)
                    internNode(e);
            }
            else
                for (const k of Object.keys(s.f)) {
                    intern(k);
                    internNode(s.f[k]);
                }
        }
        else if (s.k === "sf") {
            intern(s.name);
            internHandle(s.h);
        }
        else if (s.k === "bnd") {
            intern(s.cls);
            intern(s.name);
            intern(s.hm.owner);
            intern(String(s.hm.id));
            internNode(s.s);
            for (const e of s.a)
                internNode(e);
        }
        else if (s.k === "symu") {
            if (s.d !== undefined)
                intern(s.d);
        }
        else if (s.k === "fn") {
            intern(s.p);
            if (s.hm) {
                intern(s.hm.owner);
                intern(String(s.hm.id));
            }
            internNode(s.c);
            for (const k of Object.keys(s.f)) {
                intern(k);
                internNode(s.f[k]);
            }
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
    w.varu(dl.length);
    for (const { d, keys, f0 } of dl) {
        w.varu(intern(d.owner));
        w.varu(intern(String(d.id)));
        const path = d.path ?? [];
        w.varu(path.length);
        for (const x of path)
            w.varu(intern(x));
        w.varu(keys.length);
        for (const k of keys)
            w.varu(intern(k));
        w.varu(f0);
        const gone = d.gone ?? [];
        w.varu(gone.length);
        for (const x of gone)
            w.varu(intern(x));
    }
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
        if (s.cls !== undefined) {
            w.u8(9);
            w.varu(intern(s.cls));
            w.u8(s.err ? 1 : 0);
        } // wrap: the object that follows carries this class (graph.mts shareClass)
        if (s.tw !== undefined) {
            w.u8(11);
            w.varu(intern(s.tw.owner));
            w.varu(intern(String(s.tw.id)));
        } // wrap: the object that follows is a value twin of this home instance
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
            writeHandle(w, s.h, intern, s.st !== undefined);
            if (s.st !== undefined)
                writeNode(w, s.st, intern);
        }
        else if (s.k === "v") {
            w.u8(12);
            writeHandle(w, s.h, intern, false);
            if (s.e) {
                w.u8(1);
                w.varu(s.e.length);
                for (const e of s.e)
                    writeNode(w, e, intern);
            }
            else {
                w.u8(0);
                const ks = Object.keys(s.f);
                w.varu(ks.length);
                for (const k of ks) {
                    w.varu(intern(k));
                    writeNode(w, s.f[k], intern);
                }
            }
        }
        else if (s.k === "sf") {
            w.u8(13);
            w.varu(intern(s.name));
            writeHandle(w, s.h, intern, false);
        }
        else if (s.k === "bnd") {
            w.u8(14);
            w.varu(intern(s.cls));
            w.varu(intern(s.name));
            w.varu(intern(s.hm.owner));
            w.varu(intern(String(s.hm.id)));
            writeNode(w, s.s, intern);
            w.varu(s.a.length);
            for (const e of s.a)
                writeNode(w, e, intern);
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
        else if (s.k === "fn") {
            w.u8(10);
            w.varu(intern(s.p));
            w.u8(s.hm ? 1 : 0);
            if (s.hm) {
                w.varu(intern(s.hm.owner));
                w.varu(intern(String(s.hm.id)));
            }
            writeNode(w, s.c, intern);
            const ks = Object.keys(s.f);
            w.varu(ks.length);
            for (const k of ks) {
                w.varu(intern(k));
                writeNode(w, s.f[k], intern);
            }
        }
    }
    return w.done();
}
export function decodeWireBinary(bytes, { content = null, tier = null, programs = null } = {}) {
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
    const dh = [];
    {
        const n = r.count();
        for (let i = 0; i < n; i++) {
            const owner = S(r.varu()), id = S(r.varu());
            const pc = r.count(), path = [];
            for (let j = 0; j < pc; j++)
                path.push(S(r.varu()));
            const kc = r.count(), keys = [];
            for (let j = 0; j < kc; j++)
                keys.push(S(r.varu()));
            const f0 = r.varu();
            const gc = r.count(), gone = [];
            for (let j = 0; j < gc; j++)
                gone.push(S(r.varu()));
            dh.push({ owner, id, path, keys, f0, gone });
        }
    }
    const roots = [];
    {
        const n = r.count();
        for (let i = 0; i < n; i++)
            roots.push(readNode(r, S));
    }
    const readSlot = () => {
        let t = r.u8();
        let cah;
        let cls, err = 0, tw;
        while (t === 8 || t === 9 || t === 11) {
            if (t === 8)
                cah = S(r.varu());
            else if (t === 9) {
                cls = S(r.varu());
                err = r.u8();
            }
            else {
                const owner = S(r.varu());
                tw = { owner, id: S(r.varu()) };
            }
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
            const { h, st } = readHandle(r, S);
            slot = { k: "H", h };
            if (st)
                slot.st = readNode(r, S);
        }
        else if (t === 12) {
            const { h } = readHandle(r, S);
            const arr = r.u8();
            if (arr) {
                const c = r.count(), e = [];
                for (let j = 0; j < c; j++)
                    e.push(readNode(r, S));
                slot = { k: "v", h, e };
            }
            else {
                const c = r.count(), f = {};
                for (let j = 0; j < c; j++) {
                    const key = S(r.varu());
                    const val = readNode(r, S);
                    if (key === "__proto__")
                        continue;
                    f[key] = val;
                }
                slot = { k: "v", h, f };
            }
        }
        else if (t === 13) {
            const name = S(r.varu());
            const { h } = readHandle(r, S);
            slot = { k: "sf", name, h };
        }
        else if (t === 14) {
            const cls = S(r.varu()), name = S(r.varu()), owner = S(r.varu()), id = S(r.varu());
            const sn = readNode(r, S);
            const c = r.count(), a = [];
            for (let j = 0; j < c; j++)
                a.push(readNode(r, S));
            slot = { k: "bnd", cls, name, hm: { owner, id }, s: sn, a };
        }
        else if (t === 5) {
            slot = { k: "symu", d: r.u8() ? S(r.varu()) : undefined };
        }
        else if (t === 10) {
            const p = S(r.varu());
            const fl = r.u8();
            let hm;
            if (fl & 1) {
                const owner = S(r.varu());
                hm = { owner, id: S(r.varu()) };
            }
            const c = readNode(r, S);
            const n = r.count();
            const f = {};
            for (let j = 0; j < n; j++) {
                const key = S(r.varu());
                const val = readNode(r, S);
                if (key === "__proto__")
                    continue;
                f[key] = val;
            }
            slot = { k: "fn", p, c, f };
            if (hm)
                slot.hm = hm;
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
        if (cls !== undefined && slot.k === "o") {
            slot.cls = cls;
            if (err)
                slot.err = 1;
        }
        if (tw !== undefined && slot.k === "o")
            slot.tw = tw;
        return slot;
    };
    const objs = [];
    {
        const n = r.count();
        for (let i = 0; i < n; i++)
            objs.push(readSlot());
    }
    const vals = decodeGraph({ roots, objs }, { content, tier, programs });
    const deltas = dh.map(({ owner, id, path, keys, f0, gone }) => {
        if (f0 + keys.length > vals.length)
            throw new RangeError("wire-binary: delta field root out of range");
        const fields = {};
        keys.forEach((k, i) => { if (k !== "__proto__")
            fields[k] = vals[f0 + i]; });
        return { owner, id, ...(path.length ? { path } : {}), fields, ...(gone.length ? { gone } : {}) };
    });
    // the writes a run made to views of OUR objects land before anything reads them
    if (tier)
        applyDeltas(tier, deltas);
    return { ...rebuildStack(frames, req, vals), deltas };
}
// A fresh start ships only the entry args — no continuation and no resource yet. Carry them through
// the same value-root machinery (handles, cycles, and all), rather than hand-rolling a placeholder
// ResourceRequest with a fake op: there is no request, so only `args` round-trips.
export const encodeArgs = (args, opts = {}) => encodeWireBinary([], { op: "", tier: "", name: "", args }, opts);
export const decodeArgs = (bytes, opts) => decodeWireBinary(bytes, opts).request?.args ?? [];

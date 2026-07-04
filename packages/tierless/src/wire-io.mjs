const te = new TextEncoder(), td = new TextDecoder();
export class W {
    buf;
    n;
    constructor() { this.buf = new Uint8Array(1024); this.n = 0; }
    ensure(k) { if (this.n + k > this.buf.length) {
        let cap = this.buf.length * 2;
        while (cap < this.n + k)
            cap *= 2;
        const nb = new Uint8Array(cap);
        nb.set(this.buf.subarray(0, this.n));
        this.buf = nb;
    } }
    u8(b) { this.ensure(1); this.buf[this.n++] = b & 0xff; }
    raw(bytes) { this.ensure(bytes.length); this.buf.set(bytes, this.n); this.n += bytes.length; }
    varu(x) { this.ensure(10); let v = x; for (;;) {
        const b = v % 128;
        v = Math.floor(v / 128);
        if (v !== 0)
            this.buf[this.n++] = b | 0x80;
        else {
            this.buf[this.n++] = b;
            break;
        }
    } } // LEB128, safe to 2^53
    vari(x) { this.varu(x >= 0 ? x * 2 : -x * 2 - 1); } // zigzag
    f64(x) { this.ensure(8); new DataView(this.buf.buffer, this.n, 8).setFloat64(0, x, true); this.n += 8; }
    done() { return this.buf.subarray(0, this.n); }
}
export class R {
    buf;
    n;
    len;
    dv;
    label; // which wire is decoding — prefixes every error
    constructor(buf, label) { this.buf = buf; this.n = 0; this.len = buf.length; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); this.label = label; }
    need(k) { if (k < 0 || this.n + k > this.len)
        throw new RangeError(this.label + ": truncated/out-of-bounds read"); }
    u8() { this.need(1); return this.buf[this.n++]; }
    raw(k) { this.need(k); const s = this.buf.subarray(this.n, this.n + k); this.n += k; return s; }
    varu() { let v = 0, shift = 1, b, i = 0; do {
        this.need(1);
        b = this.buf[this.n++];
        v += (b & 0x7f) * shift;
        shift *= 128;
        if (++i > 9)
            throw new RangeError(this.label + ": varint too long");
    } while (b & 0x80); return v; }
    // a count must be representable in the bytes that remain (each item is ≥ 1 byte) — caps work at O(buffer).
    count() { const c = this.varu(); if (c > this.len - this.n)
        throw new RangeError(this.label + ": declared count exceeds buffer"); return c; }
    vari() { const zz = this.varu(); return zz % 2 === 0 ? zz / 2 : -(zz + 1) / 2; }
    f64() { this.need(8); const v = this.dv.getFloat64(this.n, true); this.n += 8; return v; }
}
// integers small enough for a compact zigzag varint travel as `int`; everything else (floats,
// NaN/Infinity/-0, huge ints) travels as an exact 8-byte f64. Both byte codecs share this cut.
export const isVarInt = (v) => Number.isInteger(v) && Math.abs(v) < 0x80000000 && !Object.is(v, -0);
// ---- magic header --------------------------------------------------------------------------
export const writeMagic = (w, magic) => w.raw(te.encode(magic));
export const checkMagic = (r, magic) => { const want = te.encode(magic); if (td.decode(r.raw(want.length)) !== magic)
    throw new RangeError(r.label + ": bad magic"); };
// ---- interned string table -----------------------------------------------------------------
export const makeInterner = () => {
    const map = new Map(), strs = [];
    return { strs, intern: (s) => { let i = map.get(s); if (i === undefined) {
            i = strs.length;
            map.set(s, i);
            strs.push(s);
        } return i; } };
};
export const writeStrings = (w, strs) => { w.varu(strs.length); for (const s of strs) {
    const b = te.encode(s);
    w.varu(b.length);
    w.raw(b);
} };
export const readStrings = (r) => { const strs = []; const n = r.count(); for (let i = 0; i < n; i++)
    strs.push(td.decode(r.raw(r.count()))); return strs; };
export const strAt = (strs, label) => (i) => { if (i < 0 || i >= strs.length)
    throw new RangeError(label + ": string index out of range"); return strs[i]; };
export function rootsOf(stack, request) {
    const rootVals = [];
    const frames = stack.map((f) => { const keys = Object.keys(f).filter((k) => k !== "fn" && k !== "pc"); const b0 = rootVals.length; for (const k of keys)
        rootVals.push(f[k]); return { fn: f.fn, pc: f.pc, keys, b0 }; });
    let req = null;
    if (request) {
        const a0 = rootVals.length;
        for (const a of request.args || [])
            rootVals.push(a);
        req = { op: request.op, tier: request.tier, name: request.name, a0, argc: rootVals.length - a0 };
    }
    return { rootVals, frames, req };
}
// The inverse: resolve each skeleton's keys back to its decoded values. Shared by every decode
// path that has the full value list (wire-binary, heap's JSON wire, the delta's reconstruct).
export function rebuildStack(frames, req, vals) {
    const stack = frames.map((f) => { const fr = { fn: f.fn, pc: f.pc }; f.keys.forEach((k, i) => { fr[k] = vals[f.b0 + i]; }); return fr; });
    const request = req ? { op: req.op, tier: req.tier, name: req.name, args: vals.slice(req.a0, req.a0 + req.argc) } : null;
    return { stack, request };
}
// The byte-wire header segment for the skeletons (both byte codecs write/read it identically).
export function writeFrameHeader(w, frames, req, intern) {
    w.varu(frames.length);
    for (const f of frames) {
        w.varu(intern(f.fn));
        w.varu(f.pc);
        w.varu(f.keys.length);
        for (const k of f.keys)
            w.varu(intern(k));
        w.varu(f.b0);
    }
    w.u8(req ? 1 : 0);
    if (req) {
        w.varu(intern(req.op));
        w.varu(intern(req.tier));
        w.varu(intern(req.name));
        w.varu(req.a0);
        w.varu(req.argc);
    }
}
export function readFrameHeader(r, S) {
    const frames = [];
    {
        const n = r.count();
        for (let i = 0; i < n; i++) {
            const fn = S(r.varu());
            const pc = r.varu();
            const kc = r.count();
            const keys = [];
            for (let j = 0; j < kc; j++)
                keys.push(S(r.varu()));
            frames.push({ fn, pc, keys, b0: r.varu() });
        }
    }
    let req = null;
    if (r.u8()) {
        const op = S(r.varu()), tier = S(r.varu()), name = S(r.varu()), a0 = r.varu(), argc = r.varu();
        req = { op, tier, name, a0, argc };
    }
    return { frames, req };
}

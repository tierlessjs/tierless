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

const te = new TextEncoder(), td = new TextDecoder();
const MAGIC = "SMW1";

// node tags: 0 ref, 1 int, 2 float, 3 str, 4 true, 5 false, 6 null, 7 undef, 8 bigint, 9 glob, 10 symw, 11 symf
// slot tags: 0 array, 1 object, 2 map, 3 set, 4 handle, 5 unique-symbol

class W {
  constructor() { this.buf = new Uint8Array(1024); this.n = 0; }
  ensure(k) { if (this.n + k > this.buf.length) { let cap = this.buf.length * 2; while (cap < this.n + k) cap *= 2; const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.n)); this.buf = nb; } }
  u8(b) { this.ensure(1); this.buf[this.n++] = b & 0xff; }
  raw(bytes) { this.ensure(bytes.length); this.buf.set(bytes, this.n); this.n += bytes.length; }
  varu(x) { this.ensure(10); let v = x; for (;;) { const b = v % 128; v = Math.floor(v / 128); if (v !== 0) this.buf[this.n++] = b | 0x80; else { this.buf[this.n++] = b; break; } } }  // LEB128, safe to 2^53
  vari(x) { this.varu(x >= 0 ? x * 2 : -x * 2 - 1); }                                                                                         // zigzag
  f64(x) { this.ensure(8); new DataView(this.buf.buffer, this.n, 8).setFloat64(0, x, true); this.n += 8; }
  done() { return this.buf.subarray(0, this.n); }
}
class R {
  constructor(buf) { this.buf = buf; this.n = 0; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  u8() { return this.buf[this.n++]; }
  raw(k) { const s = this.buf.subarray(this.n, this.n + k); this.n += k; return s; }
  varu() { let v = 0, shift = 1, b; do { b = this.buf[this.n++]; v += (b & 0x7f) * shift; shift *= 128; } while (b & 0x80); return v; }
  vari() { const zz = this.varu(); return zz % 2 === 0 ? zz / 2 : -(zz + 1) / 2; }
  f64() { const v = this.dv.getFloat64(this.n, true); this.n += 8; return v; }
}

// integers small enough for a compact zigzag varint travel as `int`; everything else (floats,
// NaN/Infinity/-0, huge ints) travels as an exact 8-byte f64.
const isVarInt = (v) => Number.isInteger(v) && Math.abs(v) < 0x80000000 && !Object.is(v, -0);

function writeNode(w, n, intern) {
  switch (n.k) {
    case "r": w.u8(0); w.varu(n.id); break;
    case "u": w.u8(7); break;
    case "big": w.u8(8); w.varu(intern(n.v)); break;
    case "glob": w.u8(9); w.varu(intern(n.name)); break;
    case "symw": w.u8(10); w.varu(intern(n.name)); break;
    case "symf": w.u8(11); w.varu(intern(n.key)); break;
    default: {                                                  // "p"
      const v = n.v;
      if (v === null) w.u8(6);
      else if (v === true) w.u8(4);
      else if (v === false) w.u8(5);
      else if (typeof v === "string") { w.u8(3); w.varu(intern(v)); }
      else if (typeof v === "number") { if (isVarInt(v)) { w.u8(1); w.vari(v); } else { w.u8(2); w.f64(v); } }
      else w.u8(7);                                             // unreachable for valid graphs
    }
  }
}
function readNode(r, strs) {
  const t = r.u8();
  switch (t) {
    case 0: return { k: "r", id: r.varu() };
    case 1: return { k: "p", v: r.vari() };
    case 2: return { k: "p", v: r.f64() };
    case 3: return { k: "p", v: strs[r.varu()] };
    case 4: return { k: "p", v: true };
    case 5: return { k: "p", v: false };
    case 6: return { k: "p", v: null };
    case 7: return { k: "u" };
    case 8: return { k: "big", v: strs[r.varu()] };
    case 9: return { k: "glob", name: strs[r.varu()] };
    case 10: return { k: "symw", name: strs[r.varu()] };
    case 11: return { k: "symf", key: strs[r.varu()] };
    default: throw new Error("wire-binary: bad node tag " + t);
  }
}

// Serialize a continuation, mirroring encodeWire's frame-flattening, then writing the
// {frames, req, {roots, objs}} structure as bytes. opts (tier/threshold) drive §5 excision.
export function encodeWireBinary(stack, request, { tier = null, threshold = 8192 } = {}) {
  const rootsVals = [];
  const frames = stack.map((f) => {
    const keys = Object.keys(f).filter((k) => k !== "fn" && k !== "pc");
    const b0 = rootsVals.length; for (const k of keys) rootsVals.push(f[k]);
    return { fn: f.fn, pc: f.pc, keys, b0 };
  });
  let req = null;
  if (request) { const a0 = rootsVals.length; for (const a of request.args || []) rootsVals.push(a); req = { op: request.op, tier: request.tier, name: request.name, a0, argc: (request.args || []).length }; }
  const graph = encodeGraph(rootsVals, { tier, threshold });

  // pass 1: intern strings and collect object shapes ------------------------------------
  const strMap = new Map(), strs = [];
  const intern = (s) => { let i = strMap.get(s); if (i === undefined) { i = strs.length; strMap.set(s, i); strs.push(s); } return i; };
  const shapeMap = new Map(), shapes = [];                       // sig -> idx; shapes[idx] = [[keyStrIdx, nonEnum], ...]
  const slotShape = new Array(graph.objs.length);
  const internNode = (n) => { if (n.k === "big") intern(n.v); else if (n.k === "glob" || n.k === "symw") intern(n.name); else if (n.k === "symf") intern(n.key); else if (n.k === "p" && typeof n.v === "string") intern(n.v); };
  for (const f of frames) { intern(f.fn); for (const k of f.keys) intern(k); }
  if (req) { intern(req.op); intern(req.tier); intern(req.name); }
  for (const n of graph.roots) internNode(n);
  for (let i = 0; i < graph.objs.length; i++) {
    const s = graph.objs[i];
    if (s.k === "a" || s.k === "set") { for (const e of s.e) internNode(e); }
    else if (s.k === "map") { for (const [kn, vn] of s.e) { internNode(kn); internNode(vn); } }
    else if (s.k === "o") {
      const keys = Object.keys(s.f);
      const sig = keys.map((k) => intern(k) + ":" + (s.h && s.h[k] ? 1 : 0)).join(",");
      let si = shapeMap.get(sig); if (si === undefined) { si = shapes.length; shapeMap.set(sig, si); shapes.push(keys.map((k) => [intern(k), s.h && s.h[k] ? 1 : 0])); }
      slotShape[i] = si;
      for (const k of keys) internNode(s.f[k]);
      if (s.sf) for (const [kn, vn] of s.sf) { internNode(kn); internNode(vn); }
    } else if (s.k === "H") { intern(s.h.owner); intern(String(s.h.id)); if (s.h.kind) intern(s.h.kind); }
    else if (s.k === "symu") { if (s.d !== undefined) intern(s.d); }
  }

  // pass 2: write ------------------------------------------------------------------------
  const w = new W();
  w.raw(te.encode(MAGIC));
  w.varu(strs.length); for (const s of strs) { const b = te.encode(s); w.varu(b.length); w.raw(b); }
  w.varu(shapes.length); for (const sh of shapes) { w.varu(sh.length); for (const [si, ne] of sh) { w.varu(si); w.u8(ne); } }
  w.varu(frames.length); for (const f of frames) { w.varu(intern(f.fn)); w.varu(f.pc); w.varu(f.keys.length); for (const k of f.keys) w.varu(intern(k)); w.varu(f.b0); }
  w.u8(req ? 1 : 0); if (req) { w.varu(intern(req.op)); w.varu(intern(req.tier)); w.varu(intern(req.name)); w.varu(req.a0); w.varu(req.argc); }
  w.varu(graph.roots.length); for (const n of graph.roots) writeNode(w, n, intern);
  w.varu(graph.objs.length);
  for (let i = 0; i < graph.objs.length; i++) {
    const s = graph.objs[i];
    if (s.k === "a") { w.u8(0); w.varu(s.e.length); for (const e of s.e) writeNode(w, e, intern); }
    else if (s.k === "o") {
      w.u8(1); w.varu(slotShape[i]);
      for (const k of Object.keys(s.f)) writeNode(w, s.f[k], intern);
      const sf = s.sf || []; w.varu(sf.length); for (const [kn, vn, en] of sf) { writeNode(w, kn, intern); writeNode(w, vn, intern); w.u8(en); }
    } else if (s.k === "map") { w.u8(2); w.varu(s.e.length); for (const [kn, vn] of s.e) { writeNode(w, kn, intern); writeNode(w, vn, intern); } }
    else if (s.k === "set") { w.u8(3); w.varu(s.e.length); for (const e of s.e) writeNode(w, e, intern); }
    else if (s.k === "H") { w.u8(4); w.varu(intern(s.h.owner)); w.varu(intern(String(s.h.id))); if (s.h.kind) { w.u8(1); w.varu(intern(s.h.kind)); } else w.u8(0); }
    else if (s.k === "symu") { w.u8(5); if (s.d !== undefined) { w.u8(1); w.varu(intern(s.d)); } else w.u8(0); }
  }
  return w.done();
}

export function decodeWireBinary(bytes) {
  const r = new R(bytes);
  if (td.decode(r.raw(4)) !== MAGIC) throw new Error("wire-binary: bad magic");
  const strs = []; { const n = r.varu(); for (let i = 0; i < n; i++) strs.push(td.decode(r.raw(r.varu()))); }
  const shapes = []; { const n = r.varu(); for (let i = 0; i < n; i++) { const kc = r.varu(); const sh = []; for (let j = 0; j < kc; j++) { const si = r.varu(); sh.push([si, r.u8()]); } shapes.push(sh); } }
  const frames = []; { const n = r.varu(); for (let i = 0; i < n; i++) { const fn = strs[r.varu()]; const pc = r.varu(); const kc = r.varu(); const keys = []; for (let j = 0; j < kc; j++) keys.push(strs[r.varu()]); frames.push({ fn, pc, keys, b0: r.varu() }); } }
  let req = null; if (r.u8()) { const op = strs[r.varu()], tier = strs[r.varu()], name = strs[r.varu()], a0 = r.varu(), argc = r.varu(); req = { op, tier, name, a0, argc }; }
  const roots = []; { const n = r.varu(); for (let i = 0; i < n; i++) roots.push(readNode(r, strs)); }
  const objs = []; { const n = r.varu(); for (let i = 0; i < n; i++) {
    const t = r.u8();
    if (t === 0) { const c = r.varu(), e = []; for (let j = 0; j < c; j++) e.push(readNode(r, strs)); objs.push({ k: "a", e }); }
    else if (t === 1) { const sh = shapes[r.varu()]; const f = {}, h = {}; for (const [si, ne] of sh) { const key = strs[si]; f[key] = readNode(r, strs); if (ne) h[key] = 1; } const slot = { k: "o", f }; if (Object.keys(h).length) slot.h = h; const sfn = r.varu(); if (sfn) { slot.sf = []; for (let j = 0; j < sfn; j++) { const kn = readNode(r, strs), vn = readNode(r, strs); slot.sf.push([kn, vn, r.u8()]); } } objs.push(slot); }
    else if (t === 2) { const c = r.varu(), e = []; for (let j = 0; j < c; j++) e.push([readNode(r, strs), readNode(r, strs)]); objs.push({ k: "map", e }); }
    else if (t === 3) { const c = r.varu(), e = []; for (let j = 0; j < c; j++) e.push(readNode(r, strs)); objs.push({ k: "set", e }); }
    else if (t === 4) { const owner = strs[r.varu()], id = strs[r.varu()]; const h = { __stackmix_handle__: true, owner, id }; if (r.u8()) h.kind = strs[r.varu()]; objs.push({ k: "H", h }); }
    else if (t === 5) { objs.push({ k: "symu", d: r.u8() ? strs[r.varu()] : undefined }); }
    else throw new Error("wire-binary: bad slot tag " + t);
  } }
  const vals = decodeGraph({ roots, objs });
  const stack = frames.map((f) => { const fr = { fn: f.fn, pc: f.pc }; f.keys.forEach((k, i) => { fr[k] = vals[f.b0 + i]; }); return fr; });
  const request = req ? { op: req.op, tier: req.tier, name: req.name, args: vals.slice(req.a0, req.a0 + req.argc) } : null;
  return { stack, request };
}

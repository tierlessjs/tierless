// Delta wire — encode a continuation as a PATCH over what the peer already holds, so a
// capture ships only the objects whose content actually changed. This generalizes the §5
// versioned heap (stable id + version, big objects fetched lazily) to "every object, shipped
// as a coherence delta," and the §6 cost decision picks min(delta, full) per message.
//
// Model: each tier keeps a replicated, stably-identified object store. An object's STABLE ID
// (a WeakMap, tier-prefixed like a §5 handle so the two stores never collide) persists across
// captures. Its VERSION is a SHALLOW content hash — children referenced by id, not recursively
// — so a deep change bumps only that object's version, not its ancestors'. The wire carries
// the root references + only the changed objects; the peer resolves unchanged ids from its
// store and MUTATES changed objects in place, so an unchanged ancestor sees its changed
// descendant's update for free. Bytes are proportional to actual change, not total size.
//
// Prototype scope: plain objects (own enumerable string keys), arrays, number/string/bool/
// null/undefined/bigint, and §5 handles — the common continuation shapes. Map/Set/symbols/
// non-enumerable props extend mechanically (same node table as wire-binary).
import { isHandle } from "./graph.mjs";

const MAGIC = "SMD1";
const te = new TextEncoder(), td = new TextDecoder();
const isObj = (v) => v !== null && typeof v === "object";
const isVarInt = (v) => Number.isInteger(v) && Math.abs(v) < 0x80000000 && !Object.is(v, -0);
function fnv(s) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }

class W {
  constructor() { this.buf = new Uint8Array(256); this.n = 0; }
  ensure(k) { if (this.n + k > this.buf.length) { let c = this.buf.length * 2; while (c < this.n + k) c *= 2; const b = new Uint8Array(c); b.set(this.buf.subarray(0, this.n)); this.buf = b; } }
  u8(b) { this.ensure(1); this.buf[this.n++] = b & 0xff; }
  raw(b) { this.ensure(b.length); this.buf.set(b, this.n); this.n += b.length; }
  varu(x) { this.ensure(10); let v = x; for (;;) { const b = v % 128; v = Math.floor(v / 128); if (v !== 0) this.buf[this.n++] = b | 0x80; else { this.buf[this.n++] = b; break; } } }
  vari(x) { this.varu(x >= 0 ? x * 2 : -x * 2 - 1); }
  f64(x) { this.ensure(8); new DataView(this.buf.buffer, this.n, 8).setFloat64(0, x, true); this.n += 8; }
  done() { return this.buf.subarray(0, this.n); }
}
class R {
  constructor(b) { this.buf = b; this.n = 0; this.len = b.length; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  need(k) { if (this.n + k > this.len) throw new RangeError("wire-delta: truncated"); }
  u8() { this.need(1); return this.buf[this.n++]; }
  raw(k) { this.need(k); const s = this.buf.subarray(this.n, this.n + k); this.n += k; return s; }
  varu() { let v = 0, sh = 1, b, i = 0; do { this.need(1); b = this.buf[this.n++]; v += (b & 0x7f) * sh; sh *= 128; if (++i > 9) throw new RangeError("wire-delta: varint too long"); } while (b & 0x80); return v; }
  count() { const c = this.varu(); if (c > this.len - this.n) throw new RangeError("wire-delta: bad count"); return c; }
  vari() { const z = this.varu(); return z % 2 === 0 ? z / 2 : -(z + 1) / 2; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.n, true); this.n += 8; return v; }
}

export function makeDeltaSession(tier) {
  return { tier, idOf: new WeakMap(), next: 1, store: new Map(), peerVer: new Map() };
}

// Flatten a frame stack + request into the linear list of root values the graph hangs off.
function rootsOf(session, stack, request) {
  const rootVals = [];
  const frames = stack.map((f) => { const keys = Object.keys(f).filter((k) => k !== "fn" && k !== "pc"); const b0 = rootVals.length; for (const k of keys) rootVals.push(f[k]); return { fn: f.fn, pc: f.pc, keys, b0 }; });
  let req = null;
  if (request) { const a0 = rootVals.length; for (const a of request.args || []) rootVals.push(a); req = { op: request.op, tier: request.tier, name: request.name, a0, argc: (request.args || []).length }; }
  return { rootVals, frames, req };
}

// Walk every object reachable from the roots, assign/reuse stable ids, and compute each one's
// SHALLOW content version (children referenced by id, so a deep change bumps only its own object,
// not its ancestors'). Returns reach: sid -> object, and ver: sid -> version. Pure on an already-
// identified graph (the receiver side): it assigns no new ids and mutates no store entry.
function scan(session, rootVals) {
  const sidOf = (v) => { let id = session.idOf.get(v); if (id === undefined) { id = session.tier + "#" + (session.next++); session.idOf.set(v, id); session.store.set(id, v); } return id; };
  const reach = new Map();                                              // sid -> object (reachable this capture)
  const visit = (v) => { if (!isObj(v)) return; const id = sidOf(v); if (reach.has(id)) return; reach.set(id, v); if (Array.isArray(v)) v.forEach(visit); else if (!isHandle(v)) for (const k of Object.keys(v)) visit(v[k]); };
  rootVals.forEach(visit);
  const canon = (v) => (isObj(v) ? "r" + session.idOf.get(v) : v === undefined ? "u" : typeof v === "bigint" ? "B" + v : typeof v + ":" + v);
  const ver = new Map();
  for (const [id, v] of reach) {
    const c = isHandle(v) ? "H|" + v.owner + "|" + v.id + "|" + (v.kind || "")
      : Array.isArray(v) ? "a|" + v.map(canon).join("|")
        : "o|" + Object.keys(v).map((k) => k + "=" + canon(v[k])).join("|");
    ver.set(id, fnv(c));
  }
  return { reach, ver };
}

// Encode the continuation as a delta vs what `session` believes the peer holds. Returns the
// bytes and, for reporting, how many objects were reachable vs actually shipped.
export function encodeDelta(session, stack, request) {
  const { rootVals, frames, req } = rootsOf(session, stack, request);
  const { reach, ver } = scan(session, rootVals);
  const changed = [...reach.keys()].filter((id) => session.peerVer.get(id) !== ver.get(id));

  // intern strings (keys, string/bigint values, sids, fn/req names)
  const strMap = new Map(), strs = [];
  const si = (s) => { let i = strMap.get(s); if (i === undefined) { i = strs.length; strMap.set(s, i); strs.push(s); } return i; };
  const internVal = (v) => { if (isObj(v)) si(session.idOf.get(v)); else if (typeof v === "string") si(v); else if (typeof v === "bigint") si(String(v)); };
  for (const f of frames) { si(f.fn); f.keys.forEach(si); }
  if (req) { si(req.op); si(req.tier); si(req.name); }
  rootVals.forEach(internVal);
  for (const id of changed) { si(id); const v = reach.get(id); if (isHandle(v)) { si(v.owner); si(String(v.id)); if (v.kind) si(v.kind); } else if (Array.isArray(v)) v.forEach(internVal); else for (const k of Object.keys(v)) { si(k); internVal(v[k]); } }

  const w = new W();
  const node = (v) => {                                                 // a value: ref(sid) | int | float | str | bool | null | undef | bigint
    if (isObj(v)) { w.u8(0); w.varu(si(session.idOf.get(v))); }
    else if (v === null) w.u8(6);
    else if (v === true) w.u8(4);
    else if (v === false) w.u8(5);
    else if (v === undefined) w.u8(7);
    else if (typeof v === "string") { w.u8(3); w.varu(si(v)); }
    else if (typeof v === "bigint") { w.u8(8); w.varu(si(String(v))); }
    else if (isVarInt(v)) { w.u8(1); w.vari(v); }
    else { w.u8(2); w.f64(v); }
  };
  w.raw(te.encode(MAGIC));
  w.varu(strs.length); for (const s of strs) { const b = te.encode(s); w.varu(b.length); w.raw(b); }
  w.varu(frames.length); for (const f of frames) { w.varu(si(f.fn)); w.varu(f.pc); w.varu(f.keys.length); for (const k of f.keys) w.varu(si(k)); w.varu(f.b0); }
  w.u8(req ? 1 : 0); if (req) { w.varu(si(req.op)); w.varu(si(req.tier)); w.varu(si(req.name)); w.varu(req.a0); w.varu(req.argc); }
  w.varu(rootVals.length); for (const v of rootVals) node(v);
  w.varu(changed.length);
  for (const id of changed) {
    w.varu(si(id)); const v = reach.get(id);
    if (isHandle(v)) { w.u8(2); w.varu(si(v.owner)); w.varu(si(String(v.id))); if (v.kind) { w.u8(1); w.varu(si(v.kind)); } else w.u8(0); }
    else if (Array.isArray(v)) { w.u8(1); w.varu(v.length); for (const e of v) node(e); }
    else { const ks = Object.keys(v); w.u8(0); w.varu(ks.length); for (const k of ks) { w.varu(si(k)); node(v[k]); } }
  }

  for (const [id, vv] of ver) session.peerVer.set(id, vv);              // the peer will hold these versions after applying
  return { bytes: w.done(), reachable: reach.size, shipped: changed.length };
}

// Apply a delta to `session`, reconstructing { stack, request } and updating the store.
export function applyDelta(session, bytes) {
  const r = new R(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  if (td.decode(r.raw(4)) !== MAGIC) throw new RangeError("wire-delta: bad magic");
  const strs = []; { const n = r.count(); for (let i = 0; i < n; i++) strs.push(td.decode(r.raw(r.count()))); }
  const S = (i) => { if (i < 0 || i >= strs.length) throw new RangeError("wire-delta: string index out of range"); return strs[i]; };
  const frames = []; { const n = r.count(); for (let i = 0; i < n; i++) { const fn = S(r.varu()); const pc = r.varu(); const kc = r.count(); const keys = []; for (let j = 0; j < kc; j++) keys.push(S(r.varu())); frames.push({ fn, pc, keys, b0: r.varu() }); } }
  let req = null; if (r.u8()) { const op = S(r.varu()), tier = S(r.varu()), name = S(r.varu()), a0 = r.varu(), argc = r.varu(); req = { op, tier, name, a0, argc }; }
  const node = () => { const t = r.u8(); switch (t) {
    case 0: return { ref: S(r.varu()) };
    case 1: return { v: r.vari() }; case 2: return { v: r.f64() }; case 3: return { v: S(r.varu()) };
    case 4: return { v: true }; case 5: return { v: false }; case 6: return { v: null }; case 7: return { v: undefined };
    case 8: return { v: BigInt(S(r.varu())) };
    default: throw new RangeError("wire-delta: bad node tag " + t); } };
  const rootNodes = []; { const n = r.count(); for (let i = 0; i < n; i++) rootNodes.push(node()); }

  // read changed objects; pass 1 locate-or-create their store shells (mutate in place to keep ancestor refs valid)
  const changed = []; { const n = r.count(); for (let i = 0; i < n; i++) {
    const sid = S(r.varu()); const kind = r.u8();
    if (kind === 2) { const owner = S(r.varu()), id = S(r.varu()); const h = { __stackmix_handle__: true, owner, id }; if (r.u8()) h.kind = S(r.varu()); changed.push({ sid, kind, handle: h }); }
    else if (kind === 1) { const c = r.count(), e = []; for (let j = 0; j < c; j++) e.push(node()); changed.push({ sid, kind, elems: e }); }
    else { const c = r.count(), fields = []; for (let j = 0; j < c; j++) { const k = S(r.varu()); fields.push([k, node()]); } changed.push({ sid, kind, fields }); }
  } }
  for (const ch of changed) {
    let obj = session.store.get(ch.sid);
    if (!obj) { obj = ch.kind === 1 ? [] : ch.kind === 2 ? ch.handle : {}; session.store.set(ch.sid, obj); session.idOf.set(obj, ch.sid); }
    ch.obj = obj;
  }
  const deref = (nd) => ("ref" in nd ? session.store.get(nd.ref) : nd.v);  // resolve a node -> value (store has every referenced id)
  for (const ch of changed) {                                          // pass 2: fill (mutate in place)
    if (ch.kind === 2) { const h = ch.obj; h.owner = ch.handle.owner; h.id = ch.handle.id; if (ch.handle.kind !== undefined) h.kind = ch.handle.kind; }
    else if (ch.kind === 1) { ch.obj.length = 0; for (const nd of ch.elems) ch.obj.push(deref(nd)); }
    else { for (const k of Object.keys(ch.obj)) delete ch.obj[k]; for (const [k, nd] of ch.fields) ch.obj[k] = deref(nd); }
  }

  const rootVals = rootNodes.map(deref);
  const stack = frames.map((f) => { const fr = { fn: f.fn, pc: f.pc }; f.keys.forEach((k, i) => { fr[k] = rootVals[f.b0 + i]; }); return fr; });
  const request = req ? { op: req.op, tier: req.tier, name: req.name, args: rootVals.slice(req.a0, req.a0 + req.argc) } : null;

  // After applying, the receiver holds the current version of every reachable object — and the
  // sender knows it does. Record that so an encode back to the sender ships only what changes
  // from HERE (the return hop of a migration bounce is itself a delta, not a full re-ship).
  const { ver } = scan(session, rootVals);
  for (const [id, vv] of ver) session.peerVer.set(id, vv);
  return { stack, request };
}

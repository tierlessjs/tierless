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
import { isHandle } from "./graph.mjs";

const MAGIC = "SMD1";
const te = new TextEncoder(), td = new TextDecoder();
const isObj = (v) => v !== null && typeof v === "object";
const isMap = (v) => v instanceof Map;
const isSet = (v) => v instanceof Set;
const isVarInt = (v) => Number.isInteger(v) && Math.abs(v) < 0x80000000 && !Object.is(v, -0);
function fnv(s) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
// The child values of a container, in a stable order (a §5 handle is an opaque leaf — no children).
// One definition shared by every graph walk (reach, version, dirty-select) so they never disagree.
function forEachChild(v, fn) {
  if (Array.isArray(v)) v.forEach(fn);
  else if (isHandle(v)) { /* leaf: stays tier-local */ }
  else if (isMap(v)) for (const [k, val] of v) { fn(k); fn(val); }
  else if (isSet(v)) for (const val of v) fn(val);
  else for (const k of Object.keys(v)) fn(v[k]);
}

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

// Flatten a frame stack + request into the linear list of root values the graph hangs off.
function rootsOf(stack, request) {
  const rootVals = [];
  const frames = stack.map((f) => { const keys = Object.keys(f).filter((k) => k !== "fn" && k !== "pc"); const b0 = rootVals.length; for (const k of keys) rootVals.push(f[k]); return { fn: f.fn, pc: f.pc, keys, b0 }; });
  let req = null;
  if (request) { const a0 = rootVals.length; for (const a of request.args || []) rootVals.push(a); req = { op: request.op, tier: request.tier, name: request.name, a0, argc: (request.args || []).length }; }
  return { rootVals, frames, req };
}

const sidOfFn = (session) => (v) => { let id = session.idOf.get(v); if (id === undefined) { id = session.tier + "#" + (session.next++); session.idOf.set(v, id); session.store.set(id, v); } return id; };

// Serialize { frames, req, roots, changed-objects } to bytes. Shared by both encoders — the wire
// is identical; only the choice of `changed` (the sids to ship) differs. `changed` objects are
// read from session.store (sidOf put every live object there); every value reference is its sid.
function emit(session, rootVals, frames, req, changed) {
  const strMap = new Map(), strs = [];
  const si = (s) => { let i = strMap.get(s); if (i === undefined) { i = strs.length; strMap.set(s, i); strs.push(s); } return i; };
  const internVal = (v) => { if (isObj(v)) si(session.idOf.get(v)); else if (typeof v === "string") si(v); else if (typeof v === "bigint") si(String(v)); };
  for (const f of frames) { si(f.fn); f.keys.forEach(si); }
  if (req) { si(req.op); si(req.tier); si(req.name); }
  rootVals.forEach(internVal);
  for (const id of changed) {
    si(id); const v = session.store.get(id);
    if (isHandle(v)) { si(v.owner); si(String(v.id)); if (v.kind) si(v.kind); }
    else if (isMap(v) || isSet(v) || Array.isArray(v)) forEachChild(v, internVal);
    else for (const k of Object.keys(v)) { si(k); internVal(v[k]); }
  }

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
    w.varu(si(id)); const v = session.store.get(id);
    if (isHandle(v)) { w.u8(2); w.varu(si(v.owner)); w.varu(si(String(v.id))); if (v.kind) { w.u8(1); w.varu(si(v.kind)); } else w.u8(0); }
    else if (isMap(v)) { w.u8(3); w.varu(v.size); for (const [k, val] of v) { node(k); node(val); } }
    else if (isSet(v)) { w.u8(4); w.varu(v.size); for (const val of v) node(val); }
    else if (Array.isArray(v)) { w.u8(1); w.varu(v.length); for (const e of v) node(e); }
    else { const ks = Object.keys(v); w.u8(0); w.varu(ks.length); for (const k of ks) { w.varu(si(k)); node(v[k]); } }
  }
  return w.done();
}

// Parse a delta to a plain structure (no session, no store mutation) — the hardened reader.
function parseDelta(bytes) {
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
  const changed = []; { const n = r.count(); for (let i = 0; i < n; i++) {
    const sid = S(r.varu()); const kind = r.u8();
    if (kind === 2) { const owner = S(r.varu()), id = S(r.varu()); const h = { __stackmix_handle__: true, owner, id }; if (r.u8()) h.kind = S(r.varu()); changed.push({ sid, kind, handle: h }); }
    else if (kind === 3) { const c = r.count(), entries = []; for (let j = 0; j < c; j++) { const k = node(); entries.push([k, node()]); } changed.push({ sid, kind, entries }); }
    else if (kind === 4) { const c = r.count(), vals = []; for (let j = 0; j < c; j++) vals.push(node()); changed.push({ sid, kind, vals }); }
    else if (kind === 1) { const c = r.count(), e = []; for (let j = 0; j < c; j++) e.push(node()); changed.push({ sid, kind, elems: e }); }
    else { const c = r.count(), fields = []; for (let j = 0; j < c; j++) { const k = S(r.varu()); fields.push([k, node()]); } changed.push({ sid, kind, fields }); }
  } }
  return { frames, req, rootNodes, changed };
}

// Apply a parsed delta against `session.store`, MUTATING changed objects in place (so an ancestor
// that still references them sees the update). Returns the reconstructed stack/request, the root
// values (for a receiver that wants to re-scan), and the list of shipped sids.
function reconstruct(session, parsed) {
  const { frames, req, rootNodes, changed } = parsed;
  const shell = (k, h) => (k === 1 ? [] : k === 2 ? h : k === 3 ? new Map() : k === 4 ? new Set() : {});
  for (const ch of changed) {                                            // pass 1: locate-or-create shells
    let obj = session.store.get(ch.sid);
    if (!obj) { obj = shell(ch.kind, ch.handle); session.store.set(ch.sid, obj); session.idOf.set(obj, ch.sid); }
    ch.obj = obj;
  }
  const deref = (nd) => ("ref" in nd ? session.store.get(nd.ref) : nd.v);  // store has every referenced id
  for (const ch of changed) {                                            // pass 2: fill (mutate in place)
    if (ch.kind === 2) { const h = ch.obj; h.owner = ch.handle.owner; h.id = ch.handle.id; if (ch.handle.kind !== undefined) h.kind = ch.handle.kind; }
    else if (ch.kind === 3) { ch.obj.clear(); for (const [kn, vn] of ch.entries) ch.obj.set(deref(kn), deref(vn)); }
    else if (ch.kind === 4) { ch.obj.clear(); for (const vn of ch.vals) ch.obj.add(deref(vn)); }
    else if (ch.kind === 1) { ch.obj.length = 0; for (const nd of ch.elems) ch.obj.push(deref(nd)); }
    else { for (const k of Object.keys(ch.obj)) delete ch.obj[k]; for (const [k, nd] of ch.fields) ch.obj[k] = deref(nd); }
  }
  const rootVals = rootNodes.map(deref);
  const stack = frames.map((f) => { const fr = { fn: f.fn, pc: f.pc }; f.keys.forEach((k, i) => { fr[k] = rootVals[f.b0 + i]; }); return fr; });
  const request = req ? { op: req.op, tier: req.tier, name: req.name, args: rootVals.slice(req.a0, req.a0 + req.argc) } : null;
  return { stack, request, rootVals, shipped: changed.map((c) => c.sid) };
}

// ============================== RESCAN mode (no cooperation needed) ==============================

export function makeDeltaSession(tier) {
  return { tier, idOf: new WeakMap(), next: 1, store: new Map(), peerVer: new Map() };
}

// Walk every reachable object, assign/reuse ids, and compute each one's shallow content version.
// Returns reach: sid -> object, and ver: sid -> version. O(reachable).
function scan(session, rootVals) {
  const sidOf = sidOfFn(session);
  const reach = new Map();
  const visit = (v) => { if (!isObj(v)) return; const id = sidOf(v); if (reach.has(id)) return; reach.set(id, v); forEachChild(v, visit); };
  rootVals.forEach(visit);
  const canon = (v) => (isObj(v) ? "r" + session.idOf.get(v) : v === undefined ? "u" : typeof v === "bigint" ? "B" + v : typeof v + ":" + v);
  const ver = new Map();
  for (const [id, v] of reach) {
    const c = isHandle(v) ? "H|" + v.owner + "|" + v.id + "|" + (v.kind || "")
      : isMap(v) ? "M|" + [...v].map(([k, val]) => canon(k) + "=" + canon(val)).join("|")
        : isSet(v) ? "S|" + [...v].map(canon).join("|")
          : Array.isArray(v) ? "a|" + v.map(canon).join("|")
            : "o|" + Object.keys(v).map((k) => k + "=" + canon(v[k])).join("|");
    ver.set(id, fnv(c));
  }
  return { reach, ver };
}

// Encode the continuation as a delta vs what `session` believes the peer holds, detecting change
// by re-hashing the reachable graph. Returns the bytes + reachable/shipped counts.
export function encodeDelta(session, stack, request) {
  const { rootVals, frames, req } = rootsOf(stack, request);
  const { reach, ver } = scan(session, rootVals);
  const changed = [...reach.keys()].filter((id) => session.peerVer.get(id) !== ver.get(id));
  const bytes = emit(session, rootVals, frames, req, changed);
  for (const [id, vv] of ver) session.peerVer.set(id, vv);              // the peer will hold these versions
  return { bytes, reachable: reach.size, shipped: changed.length };
}

// Apply a rescan delta. The receiver re-scans to learn the versions it now holds, so an encode
// back to the sender is itself a delta (the return hop of a bounce). O(reachable).
export function applyDelta(session, bytes) {
  const { stack, request, rootVals } = reconstruct(session, parseDelta(bytes));
  const { ver } = scan(session, rootVals);
  for (const [id, vv] of ver) session.peerVer.set(id, vv);
  return { stack, request };
}

// =========================== WRITE-TRACKED mode (bump version on write) ==========================

export function makeTrackedSession(tier) {
  return { tier, idOf: new WeakMap(), next: 1, store: new Map(), seen: new Set(), dirty: new Set() };
}

// Bump the version of one or more objects: mark them dirty the instant they are mutated. This is
// the hook a compiler write-barrier (the --auto-writeback shape) emits after a member write.
export function touch(session, ...objs) {
  for (const o of objs) if (isObj(o)) session.dirty.add(o);
  return objs[0];
}

// Select the sids to ship WITHOUT hashing the graph: every dirty object, plus every newly-reachable
// object. Found by a walk seeded from the roots AND the dirty set (a dirty object can hang under a
// clean ancestor), recursing only through dirty/new objects and PRUNING at clean, already-shipped
// ones — their whole subgraph is already on the peer. Cost O(changed + frontier), not O(reachable).
// Contract: a mutated object is assumed to stay reachable (true for continuation edits). If code
// mutates an object and then orphans it within one uninterrupted run, the orphan still ships — a
// harmless extra (the peer never references it from the roots), never a wrong reconstruction.
function selectDirty(session, rootVals) {
  const sidOf = sidOfFn(session);
  const ship = new Set(), fresh = [];
  let visited = 0;
  const recurse = (v) => {
    if (!isObj(v)) return;
    visited++;
    const id = sidOf(v);
    const isNew = !session.seen.has(id);
    if (!isNew && !session.dirty.has(v)) return;                        // clean & known → prune (subgraph held)
    if (ship.has(id)) return;                                          // already queued (also breaks cycles)
    ship.add(id);
    if (isNew) fresh.push(id);
    forEachChild(v, recurse);
  };
  rootVals.forEach(recurse);
  for (const o of session.dirty) recurse(o);                            // dirty objects under a clean ancestor
  return { changed: [...ship], fresh, visited };
}

// Encode by bumped versions: ship the dirty set + newly-reachable objects. O(changed). The dirty
// set is cleared (those changes are now on the peer); newly-shipped ids join `seen`.
export function encodeDeltaTracked(session, stack, request) {
  const { rootVals, frames, req } = rootsOf(stack, request);
  const { changed, fresh, visited } = selectDirty(session, rootVals);
  const bytes = emit(session, rootVals, frames, req, changed);
  for (const id of fresh) session.seen.add(id);                        // peer now holds these new objects
  session.dirty.clear();
  return { bytes, shipped: changed.length, visited };
}

// Apply a tracked delta. Only the shipped objects are written, and only their sids join `seen` —
// O(shipped), no re-scan. The applied objects are NOT marked dirty (the change came from the peer,
// who already has it), so an encode back ships only what THIS side then mutates.
export function applyDeltaTracked(session, bytes) {
  const { stack, request, shipped } = reconstruct(session, parseDelta(bytes));
  for (const id of shipped) session.seen.add(id);
  return { stack, request };
}

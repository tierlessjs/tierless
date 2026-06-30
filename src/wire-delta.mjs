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
import { isHandle, approxExceeds } from "./graph.mjs";

const MAGIC = "SMD1";
const te = new TextEncoder(), td = new TextDecoder();
const isObj = (v) => v !== null && typeof v === "object";
const isMap = (v) => v instanceof Map;
const isSet = (v) => v instanceof Set;
// Own enumerable string keys, minus __proto__ — never ship it, so a round-trip can't set a
// reconstructed object's prototype from the wire (the decoder skips it too, defending a hostile peer).
const ownKeys = (v) => Object.keys(v).filter((k) => k !== "__proto__");
const isVarInt = (v) => Number.isInteger(v) && Math.abs(v) < 0x80000000 && !Object.is(v, -0);
function fnv(s) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
// The child values of a container, in a stable order (a §5 handle is an opaque leaf — no children).
// One definition shared by every graph walk (reach, version, dirty-select) so they never disagree.
function forEachChild(v, fn) {
  if (Array.isArray(v)) v.forEach(fn);
  else if (isHandle(v)) { /* leaf: stays tier-local */ }
  else if (isMap(v)) for (const [k, val] of v) { fn(k); fn(val); }
  else if (isSet(v)) for (const val of v) fn(val);
  else for (const k of ownKeys(v)) fn(v[k]);
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
// Substitute an excised object with its §5 handle, so every graph walk (reach, version, ship, emit)
// sees the small handle leaf the wire carries, never the big subgraph that stayed home.
const subFn = (session) => { const h = session.handleOf; return h ? (v) => (isObj(v) && h.has(v) ? h.get(v) : v) : (v) => v; };

// §5 excision for the delta path: a big NEW subgraph stays tier-local as a handle. Walk the roots; the
// first time an object's subgraph exceeds `threshold`, put it in `tier.heap` and remember a stable
// handle (session.handleOf) so the wire carries that handle leaf in its place and the big data never
// crosses unless the peer derefs it. The mapping persists across hops — a §5 handle is a leaf the delta
// ships once — so a big immutable dataset rides every later capture for free, only UI deltas crossing.
function exciseBig(session, rootVals, tier, threshold, content) {
  const handleOf = session.handleOf, seen = new Set();
  const walk = (v) => {
    if (!isObj(v) || isHandle(v) || handleOf.has(v) || seen.has(v)) return;
    seen.add(v);
    if (content && content.store.hashFor(v) !== undefined) return;       // content-addressed immutable subgraph: ship it by hash, never excise it (content beats excision; don't descend)
    if (approxExceeds(v, threshold)) { handleOf.set(v, { __stackmix_handle__: true, owner: tier.id, id: tier.heapPut(v), kind: Array.isArray(v) ? "array" : "object" }); return; }  // excise; don't descend
    forEachChild(v, walk);
  };
  rootVals.forEach(walk);
}

// Serialize { frames, req, roots, changed-objects } to bytes. Shared by both encoders — the wire
// is identical; only the choice of `changed` (the sids to ship) differs. `changed` objects are
// read from session.store (sidOf put every live object there); every value reference is its sid.
function emit(session, rootVals, frames, req, changed) {
  const sub = subFn(session);
  const strMap = new Map(), strs = [];
  const si = (s) => { let i = strMap.get(s); if (i === undefined) { i = strs.length; strMap.set(s, i); strs.push(s); } return i; };
  const internVal = (v) => { v = sub(v); if (isObj(v)) si(session.idOf.get(v)); else if (typeof v === "string") si(v); else if (typeof v === "bigint") si(String(v)); };
  for (const f of frames) { si(f.fn); f.keys.forEach(si); }
  if (req) { si(req.op); si(req.tier); si(req.name); }
  rootVals.forEach(internVal);
  for (const id of changed) {
    si(id); const v = session.store.get(id);
    if (isHandle(v)) { si(v.owner); si(String(v.id)); if (v.kind) si(v.kind); }
    else if (isMap(v) || isSet(v) || Array.isArray(v)) forEachChild(v, internVal);
    else for (const k of ownKeys(v)) { si(k); internVal(v[k]); }
  }

  const w = new W();
  const node = (v) => {                                                 // a value: ref(sid) | int | float | str | bool | null | undef | bigint
    v = sub(v);
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
    else { const ks = ownKeys(v); w.u8(0); w.varu(ks.length); for (const k of ks) { w.varu(si(k)); node(v[k]); } }
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
    else { for (const k of Object.keys(ch.obj)) delete ch.obj[k]; for (const [k, nd] of ch.fields) if (k !== "__proto__") ch.obj[k] = deref(nd); }   // skip __proto__: a hostile peer must not set a reconstructed object's prototype
  }
  const rootVals = rootNodes.map(deref);
  const stack = frames.map((f) => { const fr = { fn: f.fn, pc: f.pc }; f.keys.forEach((k, i) => { fr[k] = rootVals[f.b0 + i]; }); return fr; });
  const request = req ? { op: req.op, tier: req.tier, name: req.name, args: rootVals.slice(req.a0, req.a0 + req.argc) } : null;
  return { stack, request, rootVals, shipped: changed.map((c) => c.sid) };
}

// ============================== RESCAN mode (no cooperation needed) ==============================

export function makeDeltaSession(tier) {
  return { tier, idOf: new WeakMap(), next: 1, store: new Map(), peerVer: new Map(), handleOf: new WeakMap() };
}

// Walk every reachable object, assign/reuse ids, and compute each one's shallow content version.
// Returns reach: sid -> object, and ver: sid -> version. O(reachable).
function scan(session, rootVals) {
  const sidOf = sidOfFn(session), sub = subFn(session);
  const reach = new Map();
  const visit = (v) => { v = sub(v); if (!isObj(v)) return; const id = sidOf(v); if (reach.has(id)) return; reach.set(id, v); forEachChild(v, visit); };
  rootVals.forEach(visit);
  const canon = (v) => { v = sub(v); return isObj(v) ? "r" + session.idOf.get(v) : v === undefined ? "u" : typeof v === "bigint" ? "B" + v : typeof v + ":" + v; };
  const ver = new Map();
  for (const [id, v] of reach) {
    const c = isHandle(v) ? "H|" + v.owner + "|" + v.id + "|" + (v.kind || "")
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
  if (opts.tier) exciseBig(session, rootVals, opts.tier, opts.threshold || 64 * 1024);
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
  return { tier, idOf: new WeakMap(), next: 1, store: new Map(), seen: new Set(), dirty: new Set(), handleOf: new WeakMap() };
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

// EXACT variant: ship only objects REACHABLE from the roots (no orphans, ever), at the cost of a
// full O(reachable) membership walk instead of O(changed). The pruned selectDirty above is the tuned
// default — bench/delta.mjs measures the tradeoff: realistic oscillation never orphans, so exact only
// adds the walk cost for no benefit; pass { exact: true } when a workload mutates-then-orphans heavily.
function selectDirtyExact(session, rootVals) {
  const sidOf = sidOfFn(session), sub = subFn(session);
  const reach = [], seen = new Set();
  const visit = (v) => { v = sub(v); if (!isObj(v)) return; const id = sidOf(v); if (seen.has(id)) return; seen.add(id); reach.push([id, v]); forEachChild(v, visit); };
  rootVals.forEach(visit);
  const ship = [], fresh = [];
  for (const [id, v] of reach) { const isNew = !session.seen.has(id); if (isNew || session.dirty.has(v)) { ship.push(id); if (isNew) fresh.push(id); } }
  return { changed: ship, fresh, visited: reach.length };
}

// Compute a delta WITHOUT committing the session state, so a caller weighing min(delta, full) can
// back out and ship the full wire instead. `commit()` finalizes it (peer now holds the new objects;
// the dirty set is cleared). selectDirty has already assigned ids to any new objects either way.
export function planDelta(session, stack, request, opts = {}) {
  const { rootVals, frames, req } = rootsOf(stack, request);
  if (opts.tier) exciseBig(session, rootVals, opts.tier, opts.threshold || 64 * 1024);
  const { changed, fresh, visited } = (opts.exact ? selectDirtyExact : selectDirty)(session, rootVals);
  const bytes = emit(session, rootVals, frames, req, changed);
  return { bytes, shipped: changed.length, visited, commit() { for (const id of fresh) session.seen.add(id); session.dirty.clear(); } };
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
  for (const id of shipped) session.seen.add(id);
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
  const sub = subFn(session);                                          // excised objects appear as their handle leaf
  session.store = new Map();
  session.seen = new Set();
  session.dirty.clear();
  let n = 0;
  const assign = (v) => {
    v = sub(v);
    if (!isObj(v)) return;
    const prior = session.idOf.get(v);
    if (prior !== undefined && session.store.has(prior)) return;        // already placed in THIS baseline (sharing/cycles)
    const id = "@" + (n++);
    session.idOf.set(v, id); session.store.set(id, v); session.seen.add(id);
    forEachChild(v, assign);
  };
  rootVals.forEach(assign);
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
    if (!isObj(v) || isHandle(v)) return v;
    if (content && content.store.hashFor(v) !== undefined) return v;     // a content-addressed immutable subgraph: keep the original instance so encodeGraph's content option recognizes it by identity and ships it by hash (don't rebuild)
    if (memo.has(v)) return memo.get(v);
    if (Array.isArray(v)) { const a = []; memo.set(v, a); for (const e of v) a.push(rebuild(e)); return a; }
    if (isMap(v)) { const m = new Map(); memo.set(v, m); for (const [k, val] of v) m.set(rebuild(k), rebuild(val)); return m; }
    if (isSet(v)) { const s = new Set(); memo.set(v, s); for (const e of v) s.add(rebuild(e)); return s; }
    const o = {}; memo.set(v, o); for (const k of ownKeys(v)) o[k] = rebuild(v[k]); return o;
  };
  const stk = stack.map((f) => { const g = {}; for (const k of Object.keys(f)) g[k] = (k === "fn" || k === "pc") ? f[k] : rebuild(f[k]); return g; });
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
  adoptBaseline(session, snapStack(value), null);                       // deterministic ids, shared with the owner's baseline
  session.peerVer = new Map();
  const { ver } = scan(session, [value]);                               // baseline content versions
  for (const [id, vv] of ver) session.peerVer.set(id, vv);
  return session;
}

// Reader side: diff the (now-mutated) snapshot against its baseline and emit the changed objects. The
// baseline advances, so a second write-back from the same snapshot ships only what changed since the first.
export function diffSnapshot(session, value) {
  const { reach, ver } = scan(session, [value]);
  const changed = [...reach.keys()].filter((id) => session.peerVer.get(id) !== ver.get(id));
  const bytes = emit(session, [value], [{ fn: "@snap", pc: 0, keys: ["v"], b0: 0 }], null, changed);
  for (const [id, vv] of ver) session.peerVer.set(id, vv);
  return bytes;
}

// Reader side: encode the WHOLE snapshot (every reachable object) in the same wire, so the caller can
// take min(delta, whole) — the write-back can never be larger than shipping the whole object did before.
// applySnapshot decodes it identically (a "whole" is just a delta in which everything changed).
export function wholeSnapshot(tierId, value) {
  const session = makeTrackedSession(tierId);
  adoptBaseline(session, snapStack(value), null);
  const { reach } = scan(session, [value]);
  return emit(session, [value], [{ fn: "@snap", pc: 0, keys: ["v"], b0: 0 }], null, [...reach.keys()]);
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

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

export interface Handle {
  __tierless_handle__: true;
  owner: string;
  id: string;
  kind?: "array" | "object";
  /** Class identity of an excised compiled-class instance (the __tierless_cls stamp):
   *  what a dynamic call park dispatches on without the live object (migrate-arm.md). */
  cls?: string;
  /** An ownership-excised PLAIN object (a compiled closure's caps): how the far side may see
   *  it, as JSON { p: primitive members by value, c: stamped members' classes, s: those
   *  members' data fields, o: every other member's name }. The object still excises whole —
   *  writes to its members only ever happen at home — but off-tier it decodes as a VIEW
   *  (decodeGraph): primitives readable in place, other members as member handles. */
  view?: string;
  /** A MEMBER handle (one of a view's non-primitive members): its path from the handle's
   *  object. Resolves at home to heapGet(id)[path…]. */
  path?: string[];
  /** A stamped member handle's data fields as they shipped, for its twin. Not re-encoded. */
  state?: Record<string, unknown>;
}

/** Does v reach a function through plain containers? Bounded; deep or odd shapes count as
 *  holding one (they stay home rather than ship a lossy image). */
function holdsFunction(v: unknown, depth = 0): boolean {
  if (typeof v === "function") return true;
  if (v === null || typeof v !== "object") return false;
  if (depth > 4) return true;
  return Object.values(v as object).some((x) => holdsFunction(x, depth + 1));
}

// ---- classes that cross by value --------------------------------------------------------
// A value copied across tiers loses its prototype: an error thrown by a twin on the gateway
// and caught by compiled code that finishes at home arrived as a plain object, so the app's
// `instanceof NetworkError` (and even `instanceof Error`) said no — Keycloak's console then
// showed no alert at all. Built-in errors keep their prototype by name; an app class keeps
// its own when BOTH tiers registered it with shareClass (a port's twins module does, since
// the browser and the gateway each load it). An unregistered Error subclass still decodes
// as an Error. Nothing else changes prototype: only registered classes are ever restored.
const SHARED = new Map<string, object>();
const BUILTIN_ERRORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"]);
/** Stamp a class's identity and register it on THIS tier, so its instances keep their class
 *  when copied across tiers — and, as a §5 handle's `cls`, can dispatch to a session twin. */
export function shareClass(name: string, cls: { prototype: object }): void {
  (cls.prototype as { __tierless_cls?: string }).__tierless_cls = name;
  SHARED.set(name, cls.prototype);
}
/** The class a structurally-copied object carries: a stamped name, or "!<BuiltinError>". */
function classOf(v: object): { cls: string; err: boolean } | null {
  const p = Object.getPrototypeOf(v);
  if (p === Object.prototype || p === null) return null;
  const err = v instanceof Error;
  const stamp = Object.prototype.hasOwnProperty.call(p, "__tierless_cls") ? (p as { __tierless_cls?: unknown }).__tierless_cls : undefined;
  if (typeof stamp === "string") return { cls: stamp, err };
  if (err) { const n = (v as Error).constructor?.name; return { cls: "!" + (n && BUILTIN_ERRORS.has(n) ? n : "Error"), err }; }
  return null;
}
export function protoFor(cls: string, err: boolean): object | undefined {
  if (cls.startsWith("!")) { const n = cls.slice(1); return BUILTIN_ERRORS.has(n) ? (globalThis as unknown as Record<string, { prototype: object }>)[n].prototype : Error.prototype; }
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
const HYDRATED = new WeakMap<object, Handle>();
export function hydrated(twin: object, handle: Handle): void { HYDRATED.set(twin, handle); }
function isPrimitive(x: unknown): boolean {
  return x === null || typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x));
}
function viewOf(v: object): string {
  const p: Record<string, unknown> = {}, c: Record<string, string> = {}, s: Record<string, Record<string, unknown>> = {}, o: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue;                                 // absent and undefined read the same
    if (isPrimitive(x)) { p[k] = x; continue; }
    const cls = stampOf(x);
    if (!cls) { o.push(k); continue; }
    c[k] = cls;
    const data: Record<string, unknown> = {};
    for (const [f, fv] of Object.entries(x as object)) {
      if (holdsFunction(fv)) continue;                             // behavior, not state: {} after JSON would clobber the twin's own
      try { const j = JSON.stringify(fv); if (j !== undefined) data[f] = JSON.parse(j); } catch { /* circular or unserializable: stays home */ }
    }
    s[k] = data;
  }
  return JSON.stringify({ p, c, s, o });
}
function viewFrom(h: Handle): Record<string, unknown> {
  const d = JSON.parse(h.view!) as { p: Record<string, unknown>; c: Record<string, string>; s: Record<string, Record<string, unknown>>; o: string[] };
  const v: Record<string, unknown> = {};
  Object.defineProperty(v, VIEW, { value: h });
  for (const [k, x] of Object.entries(d.p)) v[k] = x;
  const member = (k: string): Handle => ({ __tierless_handle__: true, owner: h.owner, id: h.id, path: [k] });
  for (const [k, cls] of Object.entries(d.c)) v[k] = { ...member(k), cls, ...(d.s[k] ? { state: d.s[k] } : {}) };
  for (const k of d.o) v[k] = member(k);
  return v;
}
function stampOf(v: unknown): string | undefined {
  const proto = v && typeof v === "object" ? Object.getPrototypeOf(v) : null;
  const cls = proto && Object.prototype.hasOwnProperty.call(proto, "__tierless_cls") ? (proto as { __tierless_cls?: unknown }).__tierless_cls : undefined;
  return typeof cls === "string" ? cls : undefined;
}

export function isHandle(x: unknown): x is Handle {
  return x !== null && typeof x === "object" && (x as Handle).__tierless_handle__ === true;
}

// Host standard-library globals exposed to compiled code. They are code/identity,
// not data: a GLOBAL op pushes them, and the codec ships them BY REFERENCE (a
// {k:"glob"} tag re-bound per tier) — never deep-copied. Matches how closures and
// class objects travel.
export const GLOBALS: Record<string, unknown> = { Math, JSON, Object, Array, Number, String, Boolean, parseInt, parseFloat, isNaN, isFinite, console, Date, Symbol };
const GLOBAL_NAME = new Map(Object.entries(GLOBALS).map(([k, v]) => [v, k]));
const WELLKNOWN = new Map(Object.getOwnPropertyNames(Symbol).filter((k) => typeof (Symbol as any)[k] === "symbol").map((k) => [(Symbol as any)[k], k])); // Symbol.iterator, .asyncIterator, ...

// Cycle-safe, early-exiting size estimate (never JSON.stringify a cyclic graph).
/** `claimed` (the encoder's excise predicate) marks values that ship as a handle whatever
 *  their size: they cost a handle here, and their graph is not walked. Without it a small
 *  frame args array holding a borrowed service ([caps, first, max]) measured the service's
 *  whole reachable graph — Keycloak's admin client is far over 8 KB — and the ARGS ARRAY
 *  itself was excised, so the far side saw F.args as a handle and F.args[0] as undefined. */
export function approxExceeds(root: unknown, limit: number, claimed?: ((v: unknown) => boolean) | null): boolean {
  let total = 0;
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const x = stack.pop();
    if (x === null || typeof x !== "object") { total += typeof x === "string" ? x.length : 8; if (total > limit) return true; continue; }
    if (seen.has(x)) continue;
    seen.add(x);
    if (claimed && x !== root && claimed(x)) { total += 32; if (total > limit) return true; continue; }
    total += 16; if (total > limit) return true;
    if (Array.isArray(x)) { for (const e of x) stack.push(e); }
    else if (x instanceof Map) { total += 16 * x.size; if (total > limit) return true; for (const [k, v] of x) { stack.push(k); stack.push(v); } } // entries aren't enumerable own keys — traverse them or a huge Map looks ~empty and wrongly ships inline
    else if (x instanceof Set) { total += 16 * x.size; if (total > limit) return true; for (const e of x) stack.push(e); }
    else for (const k of Object.keys(x)) { total += k.length; stack.push((x as Record<string, unknown>)[k]); }
  }
  return false;
}

export interface EncodeTier {
  id: string;
  heapPut(v: unknown): string;
}
export interface ContentStoreView {
  hashFor(v: object): string | undefined;
  get(h: string): unknown;
  put(h: string, v: unknown): void;
}
export interface ContentPeerView {
  has(h: string): boolean;
  add(h: string): void;
}
export interface EncodeOptions {
  tier?: EncodeTier | null;
  threshold?: number;
  content?: { store: ContentStoreView; peer: ContentPeerView } | null;
  /** §5 excision by OWNERSHIP, not size: a value this predicate claims stays home as a
   *  handle regardless of its size (functions always consult it — they otherwise cross
   *  as undefined). The migrate arm passes an ownsValues-style scan here so live
   *  instances and callbacks keep their identity across a round trip. Needs `tier`. */
  excise?: ((v: unknown) => boolean) | null;
}
export interface DecodeOptions {
  content?: { store: ContentStoreView } | null;
  /** Resolve handles OWNED HERE back to the live object (master in place): a stack
   *  coming home gets its excised locals back by identity. Foreign handles stay opaque.
   *  An owned handle the heap no longer holds throws — a corrupt session, never a
   *  silently different object. */
  tier?: { id: string; heapGet(hid: string): unknown } | null;
}
export interface EncodedGraph {
  roots: unknown[];
  objs: unknown[];
}

export function encodeGraph(values: unknown[], { tier = null, threshold = 64 * 1024, content = null, excise = null }: EncodeOptions = {}): EncodedGraph {
  const objs: any[] = [];          // id -> { k:"a"|"o"|"H"|"c", ... }
  const idOf = new Map<unknown, number>();   // object -> id (identity + cycle handling)

  // §5 excision: park v in the local heap, emit the handle leaf (identity-deduped).
  // The class stamp rides ONLY for DIRECT instances of the stamped class: a subclass
  // may override the very method a far-side dispatch would resolve to the BASE machine,
  // silently running the wrong code. Subclass instances stay unstamped — their calls
  // park home (or hit a session twin, which constructs the real subclass and is exact).
  const exciseTo = (v: unknown, owned: boolean): any => {
    const id = objs.length; idOf.set(v, id);
    const cls = stampOf(v);
    const proto = v && typeof v === "object" ? Object.getPrototypeOf(v) : undefined;
    // an OWNED plain object (not one excised for size — that one's contents are the point
    // of keeping it home) describes its members for the far side's view
    const view = owned && (proto === Object.prototype || proto === null) ? viewOf(v as object) : undefined;
    objs.push({ k: "H", h: { __tierless_handle__: true, owner: tier!.id, id: tier!.heapPut(v), kind: Array.isArray(v) ? "array" : "object", ...(cls ? { cls } : {}), ...(view ? { view } : {}) } });
    return { k: "r", id };
  };

  function enc(v: unknown): any {
    let cah: string | undefined;                                      // set if v is a registered immutable subgraph shipped inline this once (tags its slot for the receiver to cache)
    if (v === undefined) return { k: "u" };
    if (typeof v === "bigint") return { k: "big", v: v.toString() };   // BigInt isn't JSON-safe
    if (typeof v === "function" && tier && excise && excise(v)) {      // a function's effect lives in this heap — keep its identity home
      if (idOf.has(v)) return { k: "r", id: idOf.get(v) };
      return exciseTo(v, true);
    }
    if (typeof v === "symbol") {                                       // well-known by name; Symbol.for by key; unique by graph node (identity within a round-trip)
      if (WELLKNOWN.has(v)) return { k: "symw", name: WELLKNOWN.get(v) };
      const key = Symbol.keyFor(v); if (key !== undefined) return { k: "symf", key };
      if (idOf.has(v)) return { k: "r", id: idOf.get(v) }; const id = objs.length; idOf.set(v, id); objs.push({ k: "symu", d: v.description }); return { k: "r", id };
    }
    if (GLOBAL_NAME.has(v)) return { k: "glob", name: GLOBAL_NAME.get(v) }; // host global -> by reference
    if (v === null || typeof v !== "object") return { k: "p", v };
    if (idOf.has(v)) return { k: "r", id: idOf.get(v) };
    if (isHandle(v)) { const id = objs.length; idOf.set(v, id); const { state: _s, ...h } = v; objs.push({ k: "H", h }); return { k: "r", id }; }
    const hh = HYDRATED.get(v as object);
    if (hh) { const id = objs.length; idOf.set(v, id); objs.push({ k: "H", h: hh }); return { k: "r", id }; }
    // a VIEW goes back as the handle it was decoded from: home gets its own live object
    const vh = (v as { [VIEW]?: Handle })[VIEW];
    if (vh) { if (idOf.has(vh)) return { k: "r", id: idOf.get(vh) }; const id = objs.length; idOf.set(vh, id); idOf.set(v, id); objs.push({ k: "H", h: vh }); return { k: "r", id }; }
    if (content) {                                                    // content-addressed immutable subgraph (code / class shapes / config)
      const h = content.store.hashFor(v);
      if (h !== undefined) {
        if (content.peer.has(h)) { const id = objs.length; idOf.set(v, id); objs.push({ k: "c", h }); return { k: "r", id }; } // peer holds it -> ship the hash, not the bytes
        content.peer.add(h); cah = h;                                 // first time: ship inline once and tag so the receiver caches it by hash
      }
    }
    // §5 handle into the owning tier's heap (stays tier-local): claimed by ownership
    // (the migrate arm's live instances/host objects) or simply too big to ship
    if (tier && excise && excise(v)) return exciseTo(v, true);
    if (tier && approxExceeds(v, threshold, excise)) return exciseTo(v, false);
    const id = objs.length; idOf.set(v, id);              // reserve id BEFORE recursing (cycle-safe)
    if (v instanceof Map) { const slot: any = { k: "map", e: [] }; objs.push(slot); if (cah !== undefined) slot.cah = cah; for (const [mk, mv] of v) slot.e.push([enc(mk), enc(mv)]); return { k: "r", id }; }
    if (v instanceof Set) { const slot: any = { k: "set", e: [] }; objs.push(slot); if (cah !== undefined) slot.cah = cah; for (const sv of v) slot.e.push(enc(sv)); return { k: "r", id }; }
    if (Array.isArray(v)) { const slot: any = { k: "a", e: [] }; objs.push(slot); if (cah !== undefined) slot.cah = cah; for (let i = 0; i < v.length; i++) slot.e.push(enc(v[i])); return { k: "r", id }; } // by index: holes -> undefined
    const slot: any = { k: "o", f: {} }; objs.push(slot); if (cah !== undefined) slot.cah = cah;
    const kc = classOf(v as object); if (kc) { slot.cls = kc.cls; if (kc.err) slot.err = 1; }
    for (const key of Object.getOwnPropertyNames(v)) {           // include non-enumerable (instance methods/tags) so behavior survives the wire
      const desc = Object.getOwnPropertyDescriptor(v, key)!;
      if (!("value" in desc)) continue;                          // skip host getters/setters (not our data)
      if (key === "__proto__") continue;                         // strip: a __proto__ data key is an injection vector, and `slot.f[key]=` would corrupt the slot's prototype
      slot.f[key] = enc((v as Record<string, unknown>)[key]);
      if (!desc.enumerable) (slot.h || (slot.h = {}))[key] = 1;  // remember which keys to restore as non-enumerable
    }
    for (const sym of Object.getOwnPropertySymbols(v)) {         // symbol-keyed properties (o[Symbol(...)] = ...)
      const desc = Object.getOwnPropertyDescriptor(v, sym)!; if (!("value" in desc)) continue;
      (slot.sf || (slot.sf = [])).push([enc(sym), enc((v as Record<symbol, unknown>)[sym]), desc.enumerable ? 1 : 0]);
    }
    return { k: "r", id };
  }

  return { roots: values.map(enc), objs };
}

// A bigint crosses the wire as a decimal string; a hostile peer can send a non-numeric one.
// Bare BigInt() throws SyntaxError, which would escape the reader's "clean RangeError on bad
// input" contract (see wire-io.mts) — normalize it here, at the §7 trust boundary.
export function toBigInt(s: string): bigint {
  try { return BigInt(s); } catch { throw new RangeError("wire: invalid bigint literal"); }
}

export function decodeGraph({ roots, objs }: EncodedGraph, { content = null, tier = null }: DecodeOptions = {}): unknown[] {
  const home = (h: Handle): unknown => {   // an owned handle resolves to the live object; foreign ones stay opaque leaves (or a VIEW)
    if (!tier || h.owner !== tier.id) return h.view ? viewFrom(h) : h;
    let v = tier.heapGet(h.id);
    if (v === undefined) throw new RangeError("wire: unknown local handle " + h.id);
    for (const k of h.path ?? []) v = (v as Record<string, unknown>)[k];   // a member handle: that member of the live object
    return v;
  };
  const built: any[] = (objs as any[]).map((s) => (s.k === "a" ? [] : s.k === "o" ? {} : s.k === "map" ? new Map() : s.k === "set" ? new Set() : s.k === "symu" ? Symbol(s.d) : s.k === "c" ? (content && content.store.get(s.h)) : home(s.h))); // pre-create for cycles/sharing; k:"c" resolves to the held immutable subgraph
  const dec = (n: any): any => (n.k === "u" ? undefined : n.k === "big" ? toBigInt(n.v) : n.k === "glob" ? GLOBALS[n.name] : n.k === "symw" ? (Symbol as any)[n.name] : n.k === "symf" ? Symbol.for(n.key) : n.k === "p" ? n.v : built[n.id]);
  (objs as any[]).forEach((s, i) => {
    if (s.k === "a") for (const n of s.e) built[i].push(dec(n));
    else if (s.k === "o") { if (s.cls) { const p = protoFor(s.cls, !!s.err); if (p) Object.setPrototypeOf(built[i], p); } for (const key in s.f) { if (key === "__proto__") continue; const val = dec(s.f[key]); if (s.h && s.h[key]) Object.defineProperty(built[i], key, { value: val, writable: true, enumerable: false, configurable: true }); else built[i][key] = val; } if (s.sf) for (const [kn, vn, en] of s.sf) { const key = dec(kn), val = dec(vn); if (en) built[i][key] = val; else Object.defineProperty(built[i], key, { value: val, writable: true, enumerable: false, configurable: true }); } }   // drop a hostile __proto__ key (our encoder strips it), consistent with wire-binary/wire-delta — never reconstruct it, even as an own property
    else if (s.k === "map") for (const [kn, vn] of s.e) built[i].set(dec(kn), dec(vn));
    else if (s.k === "set") for (const vn of s.e) built[i].add(dec(vn));
    // k:"H" -> built[i] is already the handle object; k:"c" -> already resolved to the held subgraph
    if (content && s.cah !== undefined) content.store.put(s.cah, built[i]);   // first arrival of an immutable subgraph: cache it by hash for later hash-only refs
  });
  return roots.map(dec);
}

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
  kind?: "array" | "object" | "function";
  /** Class identity of an excised compiled-class instance (the __tierless_cls stamp):
   *  what a dynamic call park dispatches on without the live object (migrate-arm.md). */
  cls?: string;
  /** A class instance's view (plain objects' and arrays' views are complete about their own
   *  members; an instance's is not — a member it lacks may be a prototype getter, so a read
   *  of it parks home instead of reading undefined). */
  inst?: true;
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
/** Share a FUNCTION by name, the shareClass of plain helpers: register the same name on
 *  each tier (the app's twins module), and a closure that captured it (an imported helper
 *  such as a form-values converter) can call it wherever the run is — off-tier its caps
 *  view carries the name, and this tier's registered copy stands in. Only for functions
 *  that behave the same on every tier: pure, or reading only what both tiers have. */
const SHARED_FN = new Map<string, Function>(), FN_NAME = new WeakMap<Function, string>();
export function shareFunction(name: string, fn: Function): void {
  SHARED_FN.set(name, fn);
  FN_NAME.set(fn, name);
}
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

// ---- views: an excised object, readable off its home tier --------------------------
// An excised object (a closure's caps, a borrowed library instance, a big plain value)
// keeps its identity and its writes at home, but off-tier it decodes as a VIEW: a plain
// object (or array) carrying the handle it stands for under the VIEW symbol, whose members
// are the object's own data as it shipped — primitives by value, nested objects as nested
// views (each with its member path), functions registered with shareFunction as this tier's
// own copy, compiled closures as shipped closures — and every other member (a function, a
// host object, anything over the view's byte budget) a MEMBER handle. Reads of what the
// view carries stay; any touch of what it doesn't, and any whole-object use (a write, a
// call with it as `this`, passing it on), finds a handle and parks home: the stop rule
// (runtime.mts parkHome) sees the VIEW symbol's handle among the object's own properties.
// A class instance's view is marked `inst`: a member it lacks is unknown (a prototype
// getter, say), so reading it parks too. Going home a view encodes as its handle.
export const VIEW = Symbol("tierless.view");
// a HYDRATED view member (runtime.mts hydrateViews): the session twin standing in for a
// borrowed member on this tier, or a value twin a shipped closure brought. Encoded, it
// is the handle it replaced — home gets its own live object back, never a copy of the twin.
const HYDRATED = new WeakMap<object, Handle>();
export function hydrated(twin: object, handle: Handle): void { HYDRATED.set(twin, handle); }
/** The home handle of a twin on this tier (a session twin hydrated into a view, or a value
 *  twin a shipped closure brought), or undefined for any other object. */
export function twinOf(o: object): Handle | undefined { return HYDRATED.get(o); }
/** What an excised object's view can be built from: an ordinary object, array or class
 *  instance. Host objects with internal state (Map, Set, Date, typed arrays, promises,
 *  DOM nodes…) have no own-property picture worth reading: they stay member handles. */
function viewable(x: unknown): x is object {
  if (x === null || typeof x !== "object") return false;
  if (Array.isArray(x)) return true;
  if (x instanceof Map || x instanceof Set || x instanceof WeakMap || x instanceof WeakSet || x instanceof Date || x instanceof RegExp || x instanceof Promise || x instanceof ArrayBuffer || ArrayBuffer.isView(x)) return false;
  if (typeof Node !== "undefined" && x instanceof Node) return false;
  return true;
}
/** A stamped member handle's data fields as they shipped, for a session twin (JSON images,
 *  fields holding a function skipped: behavior, not state). */
function twinState(x: object): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = {};
  let any = false;
  for (const [f, fv] of Object.entries(x)) {
    if (holdsFunction(fv)) continue;
    try { const j = JSON.stringify(fv); if (j !== undefined) { data[f] = JSON.parse(j); any = true; } } catch { /* circular or unserializable: stays home */ }
  }
  return any ? data : undefined;
}
function stampOf(v: unknown): string | undefined {
  const proto = v && typeof v === "object" ? Object.getPrototypeOf(v) : null;
  const cls = proto && Object.prototype.hasOwnProperty.call(proto, "__tierless_cls") ? (proto as { __tierless_cls?: unknown }).__tierless_cls : undefined;
  return typeof cls === "string" ? cls : undefined;
}

// A compiled SYNC closure (transform.cts syncClosures): its stub carries the program
// name, a caps builder, and the sync mark. Shipped as program + caps (graph slot "fn"),
// it decodes to a stub that runs the receiving tier's copy of the program — the
// mechanism that moves a method's stack, applied to a function VALUE (a translator a
// component captured, built by a library's factory method). Async stubs (store and
// component functions) keep their own dispatch and don't ship this way.
interface CompiledFn { __tierless_program: string; __tierless_caps: () => unknown; __tierless_sync: true }
export const isCompiledFn = (v: unknown): v is CompiledFn => typeof v === "function" && (v as { __tierless_sync?: unknown }).__tierless_sync === true
  && typeof (v as { __tierless_program?: unknown }).__tierless_program === "string" && typeof (v as { __tierless_caps?: unknown }).__tierless_caps === "function";

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
  /** This tier's compiled programs, for a shipped sync closure (slot "fn"): a runner for
   *  the named program, or undefined when this tier's bundle doesn't hold it (the stub
   *  then throws when called). */
  programs?: ((name: string) => ((caps: unknown, args: unknown[]) => unknown) | undefined) | null;
}
export interface EncodedGraph {
  roots: unknown[];
  objs: unknown[];
}

export function encodeGraph(values: unknown[], { tier = null, threshold = 64 * 1024, content = null, excise = null }: EncodeOptions = {}): EncodedGraph {
  const objs: any[] = [];          // id -> { k:"a"|"o"|"H"|"c", ... }
  const idOf = new Map<unknown, number>();   // object -> id (identity + cycle handling)

  // §5 excision: park v in the local heap and emit its VIEW (above) — or, for what has no
  // view (a function), the bare handle. The class stamp rides ONLY for DIRECT instances of
  // the stamped class: a subclass may override the very method a far-side dispatch would
  // resolve to the BASE machine, silently running the wrong code. Subclass instances stay
  // unstamped — their calls park home (or hit a session twin, which constructs the real
  // subclass and is exact).
  const onPath = new Set<unknown>();                                  // the view being built, root to here: a back-edge is a member handle
  const approxSize = (root: unknown, limit: number): number => {   // approxExceeds's accounting, as a number (capped just past limit)
    let total = 0; const seen = new Set<unknown>(), stack: unknown[] = [root];
    while (stack.length && total <= limit) {
      const x = stack.pop();
      if (x === null || typeof x !== "object") { total += typeof x === "string" ? x.length : 8; continue; }
      if (seen.has(x)) continue; seen.add(x); total += 16;
      if (Array.isArray(x)) { for (const e of x) stack.push(e); }
      else if (x instanceof Map) { total += 16 * x.size; for (const [k, v] of x) { stack.push(k); stack.push(v); } }
      else if (x instanceof Set) { total += 16 * x.size; for (const e of x) stack.push(e); }
      else for (const k of Object.keys(x)) { total += k.length; stack.push((x as Record<string, unknown>)[k]); }
    }
    return Math.min(total, limit + 1);
  };
  const handleFor = (v: object, h: Omit<Handle, "__tierless_handle__">): Handle => {
    const cls = stampOf(v);
    const proto = Object.getPrototypeOf(v);
    return { __tierless_handle__: true, ...h, kind: Array.isArray(v) ? "array" : "object", ...(cls ? { cls } : {}), ...(!Array.isArray(v) && proto !== Object.prototype && proto !== null ? { inst: true as const } : {}) };
  };
  const refH = (h: Handle, st?: unknown): any => { const id = objs.length; objs.push({ k: "H", h, ...(st !== undefined ? { st } : {}) }); return { k: "r", id }; };
  // the view of v under handle h: own data members by the rules above, within `budget` bytes
  const viewSlot = (v: object, h: Handle, depth: number, budget: { left: number }): any => {
    const id = objs.length; idOf.set(v, id);
    const arr = Array.isArray(v);
    const slot: any = { k: "v", h, ...(arr ? { e: [] } : { f: {} }) };
    objs.push(slot);
    const member = (k: string): Handle => ({ __tierless_handle__: true, owner: h.owner, id: h.id, path: [...(h.path ?? []), k] });
    const encMember = (k: string, x: unknown): any => {
      if (x === undefined) return h.inst ? { k: "u" } : null;         // a plain view omits what is undefined; an instance's says so
      if (typeof x === "string") { if (x.length > budget.left) return refH(member(k)); budget.left -= x.length; return enc(x); }   // a string pays its length; an oversized one stays home
      if (x === null || (typeof x !== "object" && typeof x !== "function")) { budget.left -= 8; return enc(x); }   // other primitives, bigint, symbols
      if (typeof x === "function") {
        if (isCompiledFn(x)) return enc(x);
        const name = FN_NAME.get(x); if (name) { const sid = objs.length; objs.push({ k: "sf", name, h: member(k) }); return { k: "r", id: sid }; }
        return refH(member(k));
      }
      if (isHandle(x) || HYDRATED.has(x) || (x as { [VIEW]?: unknown })[VIEW] || GLOBAL_NAME.has(x)) return enc(x);   // another tier's object, or a twin/view/global here
      if (idOf.has(x) && objs[idOf.get(x)!].k === "v") return { k: "r", id: idOf.get(x) };   // the same object's view again (never a data copy: a view parks writes, a copy would lose them)
      if (viewable(x) && depth < 8 && !onPath.has(x)) {
        const size = approxSize(x, budget.left);
        if (size <= budget.left) { budget.left -= size; onPath.add(x); const r = viewSlot(x, handleFor(x, member(k)), depth + 1, budget); onPath.delete(x); return r; }
      }
      const mh = handleFor(x, member(k));                              // a member handle: class and data fields ride for a session twin
      const st = mh.cls ? twinState(x) : undefined;
      return refH(mh, st !== undefined ? enc(st) : undefined);
    };
    if (arr) { for (let i = 0; i < (v as unknown[]).length; i++) slot.e.push(encMember(String(i), (v as unknown[])[i]) ?? { k: "u" }); }
    else for (const key of Object.keys(v)) { if (key === "__proto__") continue; const n = encMember(key, (v as Record<string, unknown>)[key]); if (n !== null) slot.f[key] = n; }
    return { k: "r", id };
  };
  // `owned`: excised by ownership (a closure's caps, a live instance) — its view ships;
  // excised for SIZE only — a bare handle: the §5 heap fetches it on deref and keeps its
  // writes coherent (heap.mts), and its contents are the point of keeping it home
  const exciseTo = (v: unknown, owned: boolean): any => {
    const h = v !== null && typeof v === "object" ? handleFor(v, { owner: tier!.id, id: tier!.heapPut(v) }) : { __tierless_handle__: true as const, owner: tier!.id, id: tier!.heapPut(v), kind: "object" as const };
    if (owned && viewable(v)) { onPath.add(v); const r = viewSlot(v, h, 0, { left: threshold }); onPath.delete(v); return r; }
    const id = objs.length; idOf.set(v, id); objs.push({ k: "H", h }); return { k: "r", id };
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
  const holdsOwned = (root: object): boolean => {
    const seen = new Set<unknown>(), work: unknown[] = [root];
    while (work.length) {
      const x = work.pop();
      if (typeof x === "function") { if (isCompiledFn(x)) { work.push(x.__tierless_caps()); continue; } return true; }   // a compiled closure is a value — complete only if its caps are; any other function is behavior
      if (x === null || typeof x !== "object" || seen.has(x)) continue;
      seen.add(x);
      if (x instanceof Date || x instanceof Uint8Array || GLOBAL_NAME.has(x)) continue;
      if (isHandle(x) || HYDRATED.has(x) || (x as { [VIEW]?: unknown })[VIEW]) return true;   // another tier's object: a copy can't carry it
      if (!stampOf(x) && excise!(x)) return true;
      if (Array.isArray(x)) { for (const e of x) work.push(e); }
      else if (x instanceof Map) { for (const [k, e] of x) { work.push(k); work.push(e); } }
      else if (x instanceof Set) { for (const e of x) work.push(e); }
      else for (const k of [...Object.getOwnPropertyNames(x), ...Object.getOwnPropertySymbols(x)]) { const d = Object.getOwnPropertyDescriptor(x, k)!; if (!("value" in d)) return true; work.push(d.value); }   // an own accessor computes from anything: behavior
    }
    return false;
  };
  const valueTwin = (v: object): boolean => inCaps > 0 && stampOf(v) !== undefined && !holdsOwned(v) && !approxExceeds(v, threshold, null);

  function enc(v: unknown): any {
    let cah: string | undefined;                                      // set if v is a registered immutable subgraph shipped inline this once (tags its slot for the receiver to cache)
    if (v === undefined) return { k: "u" };
    if (typeof v === "bigint") return { k: "big", v: v.toString() };   // BigInt isn't JSON-safe
    if (typeof v === "function" && isCompiledFn(v)) {               // a compiled sync closure: program + caps, callable wherever the program is
      if (idOf.has(v)) return { k: "r", id: idOf.get(v) };
      const fh = HYDRATED.get(v);                                     // a stub this tier decoded: it goes back as its home handle
      if (fh) { const id = objs.length; idOf.set(v, id); objs.push({ k: "H", h: fh }); return { k: "r", id }; }
      const id = objs.length; idOf.set(v, id);
      // hm: the closure's home identity — it comes home as itself, and a tier without its
      // program sees an opaque handle (the stop rule parks the touching segment home)
      const slot: { k: "fn"; p: string; c: unknown; f: Record<string, unknown>; hm?: { owner: string; id: string } } = { k: "fn", p: v.__tierless_program, c: null, f: {}, ...(tier ? { hm: { owner: tier.id, id: tier.heapPut(v) } } : {}) };
      objs.push(slot);                                               // registered first: the caps may name the closure itself
      inCaps++;
      try {
        const caps = v.__tierless_caps();
        // the compiled builder returns a fresh plain object (nothing at home aliases it, so
        // it needs no excision of its own); anything else takes the ordinary path
        const fresh = caps !== null && typeof caps === "object" && (Object.getPrototypeOf(caps) === Object.prototype || Object.getPrototypeOf(caps) === null) && !isHandle(caps) && !(caps as { [VIEW]?: unknown })[VIEW] && !HYDRATED.has(caps);
        slot.c = fresh ? encData(caps) : enc(caps);
      } finally { inCaps--; }
      for (const k of Object.keys(v)) if (!k.startsWith("__tierless_")) slot.f[k] = enc((v as unknown as Record<string, unknown>)[k]);
      return { k: "r", id };
    }
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
    if (tier && excise && excise(v)) return valueTwin(v) ? encData(v, { owner: tier.id, id: tier.heapPut(v) }) : exciseTo(v, true);
    if (tier && approxExceeds(v, threshold, excise)) return exciseTo(v, false);
    return encData(v, undefined, cah);
  }

  // a container or object by value (tw: a value twin's home identity)
  function encData(v: object, tw?: { owner: string; id: string }, cah?: string): any {
    const id = objs.length; idOf.set(v, id);              // reserve id BEFORE recursing (cycle-safe)
    if (v instanceof Map) { const slot: any = { k: "map", e: [] }; objs.push(slot); if (cah !== undefined) slot.cah = cah; for (const [mk, mv] of v) slot.e.push([enc(mk), enc(mv)]); return { k: "r", id }; }
    if (v instanceof Set) { const slot: any = { k: "set", e: [] }; objs.push(slot); if (cah !== undefined) slot.cah = cah; for (const sv of v) slot.e.push(enc(sv)); return { k: "r", id }; }
    if (Array.isArray(v)) { const slot: any = { k: "a", e: [] }; objs.push(slot); if (cah !== undefined) slot.cah = cah; for (let i = 0; i < v.length; i++) slot.e.push(enc(v[i])); return { k: "r", id }; } // by index: holes -> undefined
    const slot: any = { k: "o", f: {} }; objs.push(slot); if (cah !== undefined) slot.cah = cah; if (tw) slot.tw = tw;
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

export function decodeGraph({ roots, objs }: EncodedGraph, { content = null, tier = null, programs = null }: DecodeOptions = {}): unknown[] {
  const mkStub = (s: { p: string }, run: ((caps: unknown, args: unknown[]) => unknown) | undefined): Function => {
    const stub = Object.assign((...a: unknown[]) => {
      if (!run) throw new Error("tierless: compiled closure " + s.p + " is not available on this tier");
      return run(stub.__tierless_caps(), a);
    }, { __tierless_program: s.p, __tierless_sync: true as const, __tierless_caps: (): unknown => undefined });
    return stub;
  };
  // a shipped closure (slot "fn"): coming home, the live closure itself; off-tier, a stub
  // over this tier's program — or, without the program here, its opaque handle, so the
  // stop rule parks the segment that would call it home (a stub that throws is the last
  // resort, for a graph encoded with no tier)
  const fnOwn = (s: { hm?: { owner: string; id: string } }): boolean => !!(tier && s.hm && s.hm.owner === tier.id);
  const fnShell = (s: { p: string; hm?: { owner: string; id: string } }): unknown => {
    if (fnOwn(s)) return home({ __tierless_handle__: true, owner: s.hm!.owner, id: s.hm!.id });
    const run = programs?.(s.p);
    if (!run && s.hm) return { __tierless_handle__: true, owner: s.hm.owner, id: s.hm.id, kind: "function" } as Handle;
    const stub = mkStub(s, run);
    if (s.hm) HYDRATED.set(stub, { __tierless_handle__: true, owner: s.hm.owner, id: s.hm.id, kind: "function" });
    return stub;
  };
  // A copy (value twin) must hold no handle and no closure this tier can't run: a native
  // method over the copy would reach them with no stop rule in between. The encoder
  // promises that, but this side is a trust boundary (§7), so the promise is CHECKED here
  // over the slot graph: a copy that would break it decodes as its handle instead.
  const copyOk = new Map<number, boolean>();
  const fnRunnable = (s: { p: string; hm?: { owner: string; id: string } }): boolean => fnOwn(s) || !!programs?.(s.p);
  const refsOf = (n: any, out: number[]): void => { if (n && typeof n === "object" && n.k === "r") out.push(n.id); };
  const slotRefs = (s: any): number[] => {
    const out: number[] = [];
    if (s.k === "a" || s.k === "set") for (const e of s.e) refsOf(e, out);
    else if (s.k === "map") for (const [kn, vn] of s.e) { refsOf(kn, out); refsOf(vn, out); }
    else if (s.k === "o") { for (const key in s.f) refsOf(s.f[key], out); if (s.sf) for (const [kn, vn] of s.sf) { refsOf(kn, out); refsOf(vn, out); } }
    else if (s.k === "fn") { refsOf(s.c, out); for (const key in s.f) refsOf(s.f[key], out); }
    else if (s.k === "v") { if (s.e) for (const e of s.e) refsOf(e, out); else for (const key in s.f) refsOf(s.f[key], out); }
    return out;
  };
  const twinOk = (root: number): boolean => {
    const known = copyOk.get(root); if (known !== undefined) return known;
    copyOk.set(root, true);                                           // provisional, for cycles
    const seen = new Set<number>([root]), work = [root];
    let ok = true;
    while (ok && work.length) {
      const i = work.pop()!, s: any = objs[i];
      if (s.k === "H" || s.k === "v") ok = !!(tier && s.h.owner === tier.id);        // a foreign handle or view: the copy would hide it
      else if (s.k === "sf") ok = SHARED_FN.has(s.name) || !!(tier && s.h.owner === tier.id);
      else if (s.k === "fn") { ok = fnRunnable(s); if (fnOwn(s)) continue; }   // a live closure of ours holds what it holds
      else if (s.k === "o" && s.tw && i !== root) { if (tier && s.tw.owner === tier.id) continue; ok = twinOk(i); }   // a nested copy stands or falls on its own
      if (!ok) break;
      for (const j of slotRefs(s)) if (!seen.has(j)) { seen.add(j); work.push(j); }
    }
    copyOk.set(root, ok);
    return ok;
  };
  const home = (h: Handle): unknown => {   // an owned handle resolves to the live object; foreign ones stay opaque leaves
    if (!tier || h.owner !== tier.id) return h;
    let v = tier.heapGet(h.id);
    if (v === undefined) throw new RangeError("wire: unknown local handle " + h.id);
    for (const k of h.path ?? []) v = (v as Record<string, unknown>)[k];   // a member handle: that member of the live object
    return v;
  };
  // a value twin (slot "o" + tw): coming home, the live instance itself; off-tier, a copy
  // with its class — or, where the class isn't registered, its handle (the stop rule then
  // parks the touching segment home rather than run methods a copy wouldn't have)
  const twinHandle = (s: { tw: { owner: string; id: string }; cls?: string }): Handle => ({ __tierless_handle__: true, owner: s.tw.owner, id: s.tw.id, kind: "object", ...(s.cls ? { cls: s.cls } : {}) });
  const twinShell = (s: { tw: { owner: string; id: string }; cls?: string; err?: number }, i: number): unknown => (tier && s.tw.owner === tier.id ? home(twinHandle(s)) : s.cls && protoFor(s.cls, !!s.err) && twinOk(i) ? {} : twinHandle(s));
  // a view (slot "v"): coming home, the live object it stands for; off-tier, a plain object
  // or array carrying its handle under VIEW. A shared function (slot "sf"): this tier's
  // registered copy, else the member handle it would be (the stop rule parks on it)
  const viewOwn = (s: { h: Handle }): boolean => !!(tier && s.h.owner === tier.id);
  const viewShell = (s: { h: Handle; e?: unknown[] }): unknown => { if (viewOwn(s)) return home(s.h); const base: object = s.e ? [] : {}; Object.defineProperty(base, VIEW, { value: s.h }); return base; };
  const built: any[] = (objs as any[]).map((s, i) => (s.k === "a" ? [] : s.k === "o" ? (s.tw ? twinShell(s, i) : {}) : s.k === "v" ? viewShell(s) : s.k === "sf" ? (SHARED_FN.get(s.name) ?? home(s.h)) : s.k === "map" ? new Map() : s.k === "set" ? new Set() : s.k === "symu" ? Symbol(s.d) : s.k === "fn" ? fnShell(s) : s.k === "c" ? (content && content.store.get(s.h)) : home(s.h))); // pre-create for cycles/sharing; k:"c" resolves to the held immutable subgraph
  const dec = (n: any): any => (n.k === "u" ? undefined : n.k === "big" ? toBigInt(n.v) : n.k === "glob" ? GLOBALS[n.name] : n.k === "symw" ? (Symbol as any)[n.name] : n.k === "symf" ? Symbol.for(n.key) : n.k === "p" ? n.v : built[n.id]);
  (objs as any[]).forEach((s, i) => {
    if (s.k === "a") for (const n of s.e) built[i].push(dec(n));
    else if (s.k === "o" && s.tw && (isHandle(built[i]) || (tier && s.tw.owner === tier.id))) { /* the handle, or the live instance: its fields are not the copy's */ }
    // a data slot never decodes into a handle's shape (handles are slots of their own), nor rebuilds a hostile __proto__ key
    else if (s.k === "o") { if (s.cls) { const p = protoFor(s.cls, !!s.err); if (p) Object.setPrototypeOf(built[i], p); } if (s.tw) hydrated(built[i], twinHandle(s)); for (const key in s.f) { if (key === "__proto__" || key === "__tierless_handle__") continue; const val = dec(s.f[key]); if (s.h && s.h[key]) Object.defineProperty(built[i], key, { value: val, writable: true, enumerable: false, configurable: true }); else built[i][key] = val; } if (s.sf) for (const [kn, vn, en] of s.sf) { const key = dec(kn), val = dec(vn); if (en) built[i][key] = val; else Object.defineProperty(built[i], key, { value: val, writable: true, enumerable: false, configurable: true }); } }   // drop a hostile __proto__ key (our encoder strips it), consistent with wire-binary/wire-delta — never reconstruct it, even as an own property
    else if (s.k === "map") for (const [kn, vn] of s.e) built[i].set(dec(kn), dec(vn));
    else if (s.k === "set") for (const vn of s.e) built[i].add(dec(vn));
    else if (s.k === "fn" && (fnOwn(s) || isHandle(built[i]))) { /* the live closure, or its handle: nothing to fill */ }
    else if (s.k === "fn") { const caps = dec(s.c); built[i].__tierless_caps = () => caps; for (const key in s.f) { if (key === "__proto__") continue; built[i][key] = dec(s.f[key]); } }
    else if (s.k === "v" && !viewOwn(s)) { if (s.e) { for (const n of s.e) built[i].push(dec(n)); } else for (const key in s.f) { if (key === "__proto__" || key === "__tierless_handle__") continue; built[i][key] = dec(s.f[key]); } }
    else if (s.k === "H" && s.st !== undefined && isHandle(built[i])) built[i].state = dec(s.st);   // a stamped member handle's data fields, for a session twin
    // k:"H" -> built[i] is already the handle object; k:"c" -> already resolved to the held subgraph; an own "v" is the live object
    if (content && s.cah !== undefined) content.store.put(s.cah, built[i]);   // first arrival of an immutable subgraph: cache it by hash for later hash-only refs
  });
  return roots.map(dec);
}

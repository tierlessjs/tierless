// Tier-agnostic continuation runtime. A compiled bundle (emitted by transform.cjs — no
// hand-written state machine) exposes PROGRAMS: each entry is a step function that
// advances one frame's state machine and either keeps going, returns a value, or yields
// a tier-pinned resource request.
//
// `makePump(bundle)` binds the driver to a bundle and returns `pump`, which runs the
// continuation ON THE LOCAL TIER: it executes every resource this tier owns inline and
// STOPS at the first resource it doesn't, handing the caller a {stack, request} to ship
// to the owning tier. The same pump runs on both tiers — only `ownsHere`/`execHere`
// differ — so one continuation flows back and forth across the wire, finishing wherever
// the last resource lands. The {stack, request} it hands back is serialized for the
// socket by the binary wire codec (wire-binary.mjs); host.mjs assembles that loop.

import { isHandle, VIEW, hydrated, twinOf } from "./graph.mjs";
import type { Bundle, Frame, Exec, ResourceRequest, HomePark, Pump, TwinDelta } from "./types.mjs";

// ---- twins' state, diffed ------------------------------------------------------------
// A twin's observable state change ships home on the same crossing so the awaiting code
// reads its writes (docs/migrate-arm.md "twins and correctness"): own enumerable data
// fields, shallow-diffed. Snapshots are JSON IMAGES, not references: this.items.push(x)
// mutates in place, so a reference diff would ship nothing.
type TwinWhere = { owner: string; id: string; path?: string[] };
const image = (v: unknown): string | undefined => { try { return JSON.stringify(v); } catch { return undefined; } };
const dataFields = (o: object): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v !== "function") out[k] = v;
  return out;
};
export function twinImage(twin: object): Record<string, string | undefined> {
  const pre: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(dataFields(twin))) pre[k] = image(v);
  return pre;
}
export function twinDelta(pre: Record<string, string | undefined>, twin: object, where: TwinWhere): TwinDelta | null {
  const fields: Record<string, unknown> = {};
  const post = dataFields(twin);
  for (const [k, v] of Object.entries(post)) {
    const img = image(v);
    // ship the JSON IMAGE's value, not the live reference: the delta rides a JSON-encoded
    // reply, so a circular/unserializable change can't cross — skip it
    if (img !== undefined && img !== pre[k]) fields[k] = JSON.parse(img);
  }
  const gone = Object.keys(pre).filter((k) => !(k in post));   // deletions: assignment can't express them
  return Object.keys(fields).length || gone.length ? { owner: where.owner, id: where.id, ...(where.path ? { path: where.path } : {}), fields, ...(gone.length ? { gone } : {}) } : null;
}

/** The plain data a view carries (primitives, nested views and plain containers; handles,
 *  functions and host objects left out): what a session twin may take as its state. */
function viewImage(o: object): Record<string, unknown> {
  // a field holding behavior anywhere (a function's member handle, a foreign object) is
  // left out WHOLE — an emptied {} would clobber the twin's own
  const BEHAVIOR = Symbol("behavior");
  const img = (v: unknown, depth: number): unknown => {
    if (typeof v === "function") return BEHAVIOR;
    if (v === null || typeof v !== "object") return v;
    if (isHandle(v) || depth > 8) return BEHAVIOR;
    if (Array.isArray(v)) { const a = v.map((x) => img(x, depth + 1)); return a.some((x) => x === BEHAVIOR) ? BEHAVIOR : a; }
    const p = Object.getPrototypeOf(v);
    if (p !== Object.prototype && p !== null) return BEHAVIOR;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) { const y = img(x, depth + 1); if (y === BEHAVIOR) return BEHAVIOR; if (y !== undefined) out[k] = y; }
    return out;
  };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) { const y = img(x, 1); if (y !== BEHAVIOR && y !== undefined) out[k] = y; }
  return out;
}

/** HYDRATE a migrated stack: every caps VIEW member that is a stamped member handle with
 *  a session twin here becomes the twin itself. Plain code the machine runs on this tier —
 *  an inline `async x => await client.find(x)` handed to Promise.all — then calls the
 *  twin natively, and the stop rule sees a live object, not a handle, so the run stays.
 *  Returns each twin with its snapshot: the caller diffs them once per crossing (no
 *  per-call hook exists for plain code). Going home, the encoder writes a hydrated twin
 *  back as its handle (graph.mts `hydrated`). */
export function hydrateViews(stack: Frame[], twins: NonNullable<PumpOpts["twins"]>): Array<{ twin: object; where: TwinWhere; pre: Record<string, string | undefined> }> {
  const out: Array<{ twin: object; where: TwinWhere; pre: Record<string, string | undefined> }> = [];
  const seen = new Set<object>();
  const add = (twin: object, h: { owner: string; id: string; path?: string[] }): void => {
    if (seen.has(twin)) return;
    seen.add(twin);
    out.push({ twin, where: { owner: h.owner, id: h.id, ...(h.path ? { path: h.path } : {}) }, pre: twinImage(twin) });
  };
  // the walk reaches what the codec built: plain containers, views (nested ones too), a
  // shipped sync closure's caps (graph.mts "fn") and value twins — a copied instance a
  // shipped closure brought (graph.mts twinOf), tracked like a session twin so its writes
  // ride home, and walked for the value twins it holds in turn
  const visited = new Set<unknown>(), work: unknown[] = [];
  for (const f of stack) for (const v of [...(Array.isArray(f.args) ? f.args : []), ...Object.values(f)]) work.push(v);
  while (work.length) {
    const v = work.pop();
    if (v === null || (typeof v !== "object" && typeof v !== "function") || visited.has(v)) continue;
    visited.add(v);
    if (typeof v === "function") { const c = v as { __tierless_sync?: boolean; __tierless_caps?: () => unknown }; if (c.__tierless_sync && typeof c.__tierless_caps === "function") work.push(c.__tierless_caps()); continue; }
    const vt = twinOf(v as object);
    if (vt) { add(v as object, vt); for (const x of Object.values(v as object)) work.push(x); continue; }
    if ((v as { [VIEW]?: unknown })[VIEW]) {
      const view = v as Record<string, unknown>;
      for (const [k, h] of Object.entries(view)) {
        if (!isHandle(h)) {
          // a nested view of a stamped instance: its class and the data it carries, for a twin
          const vh = h !== null && typeof h === "object" ? (h as { [VIEW]?: Handle })[VIEW] : undefined;
          if (vh?.cls) {
            const twin = twins(vh.cls, { id: vh.id, owner: vh.owner, ...(vh.path ? { path: vh.path } : {}), state: viewImage(h as object) });
            if (twin) { view[k] = twin; hydrated(twin, vh); add(twin, vh); continue; }
          }
          work.push(h); continue;
        }
        if (!h.cls) continue;
        const twin = twins(h.cls, { id: h.id, owner: h.owner, ...(h.path ? { path: h.path } : {}), ...(h.state ? { state: h.state } : {}) });
        if (!twin) continue;
        view[k] = twin;
        const { state: _s, ...handle } = h;
        hydrated(twin, handle);
        add(twin, handle);
      }
      continue;
    }
    if (Array.isArray(v)) { for (const x of v) work.push(x); }
    else if (v instanceof Map) { for (const [k, x] of v) { work.push(k); work.push(x); } }
    else if (v instanceof Set) { for (const x of v) work.push(x); }
    else { const p = Object.getPrototypeOf(v); if (p === Object.prototype || p === null) for (const x of Object.values(v as object)) work.push(x); }
  }
  return out;
}
import type { Handle } from "./graph.mjs";

export type { Bundle, Frame, MachineResult, ResourceRequest, HomePark, PumpRequest, Exec, Peer, Host } from "./types.mjs";

export const initialStack = (fn: string, args: unknown[] = []): Frame[] => [{ fn, pc: 0, args }];

export interface PumpOpts {
  /** Session twin registry (docs/migrate-arm.md slice 3): resolves a class-stamped §5
   *  handle to a LOCAL instance of that class, so a dynamic call park runs the real
   *  method — its own interceptors, its own state — on this tier. Opt-in per class:
   *  return undefined and the park falls through to a machine push or a home park.
   *  `handle` carries the receiver's identity (owner tier + heap id): a registry serving
   *  stateful per-instance classes must key on it, or two distinct home instances would
   *  share one twin's state. Keying by class alone is right only for singletons. */
  twins?: (cls: string, handle?: { id: string; owner: string; path?: string[]; state?: Record<string, unknown> }) => object | undefined;
}

/** The tier an OFFERED park ships to: whichever peer answers this host's runLocal.
 *  Never a tier any host owns, so the pump always hands it back to the caller. */
const PEER = "peer";
const isPlain = (v: unknown): boolean => {
  if (v === null || typeof v !== "object") return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
/** The __tierless_cls stamp of a DIRECT instance of a stamped class (the codec's rule). */
const stampOf = (v: unknown): string | undefined => {
  const p = v !== null && typeof v === "object" ? Object.getPrototypeOf(v) : null;
  const c = p && Object.prototype.hasOwnProperty.call(p, "__tierless_cls") ? (p as { __tierless_cls?: unknown }).__tierless_cls : undefined;
  return typeof c === "string" ? c : undefined;
};

export function makePump(bundle: Bundle, { twins }: PumpOpts = {}): Pump {
  const { PROGRAMS, __unwind } = bundle;
  const slots = bundle.__slots as Record<string, Record<number, string[]>> | undefined;

  // §5 stop rule (docs/migrate-arm.md): a machine segment is plain JS — it cannot suspend
  // mid-flight, so a segment that touches an excised local must not START on a tier where
  // that slot is a handle. The compiler emits, per program per state, the frame slots the
  // segment entered there references; if any currently holds a handle, park the stack to
  // the handle's owner BEFORE stepping. "args" means the unpack block reads F.args — its
  // elements are checked too (a nested call can pass a handle as an argument).
  // Every handle is minted by decodeGraph, and every container the decoder builds is a
  // plain object, Array, Map, or Set — so a wire handle is only ever reachable through
  // that chain of shapes ([svc], {service: h}, a Map of services). Descend EXACTLY those,
  // reading own data properties the way the codec does (non-enumerable and symbol keys
  // included); stop at anything live (a class instance, a DOM node, a reactive graph) —
  // the codec excises those as a unit, so a handle can't hide inside one. A LOCAL frame's
  // slot can hold an app object graph of unbounded depth (a captured store reaches the
  // whole component tree), so the walk is iterative — no graph shape can blow the stack.
  const dataProps = (v: object, out: unknown[]): void => {
    for (const k of [...Object.getOwnPropertyNames(v), ...Object.getOwnPropertySymbols(v)]) {
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if ("value" in d) out.push(d.value);
    }
  };
  const findHandle = (root: unknown): { owner: string } | null => {
    const seen = new Set<object>(), work = [root];
    while (work.length) {
      const v = work.pop();
      if (isHandle(v)) return v;
      if (v === null || (typeof v !== "object" && typeof v !== "function") || seen.has(v)) continue;
      seen.add(v);
      // a shipped sync closure (graph.mts "fn") is as real as its caps: a handle in them
      // (its library instance was excised for size) means calling it here would fail,
      // so the segment that calls it goes home — the engine's move-the-data-or-the-stack
      // choice, made per value by the codec's threshold, enforced here
      if (typeof v === "function") { const c = (v as { __tierless_caps?: () => unknown; __tierless_sync?: boolean }); if (c.__tierless_sync && typeof c.__tierless_caps === "function") work.push(c.__tierless_caps()); continue; }
      if (Array.isArray(v)) { const vh = (v as { [VIEW]?: { owner: string } })[VIEW]; if (vh) return vh; for (const x of v) work.push(x); }
      else if (v instanceof Map) for (const [k, x] of v) { work.push(k); work.push(x); }
      else if (v instanceof Set) for (const x of v) work.push(x);
      else { const p = Object.getPrototypeOf(v); if (p === Object.prototype || p === null) dataProps(v, work); }
    }
    return null;
  };
  // what a DYNAMIC key may reach: a view is complete when nothing it carries, at any
  // depth, is a handle — a member handle, a foreign object, or an instance view's unknown
  // members (view markers of complete nested views are not handles here)
  const incomplete = (root: unknown): { owner: string } | null => {
    const seen = new Set<object>(), work = [root];
    while (work.length) {
      const v = work.pop();
      if (isHandle(v)) return v;
      if (v === null || (typeof v !== "object" && typeof v !== "function") || seen.has(v)) continue;
      seen.add(v);
      if (typeof v === "function") { const c = v as { __tierless_caps?: () => unknown; __tierless_sync?: boolean }; if (c.__tierless_sync && typeof c.__tierless_caps === "function") work.push(c.__tierless_caps()); continue; }
      const vh = (v as { [VIEW]?: { owner: string; inst?: true } })[VIEW];
      if (vh?.inst) return vh;
      if (Array.isArray(v)) { for (const x of v) work.push(x); }
      else if (v instanceof Map) { for (const [k, x] of v) { work.push(k); work.push(x); } }
      else if (v instanceof Set) { for (const x of v) work.push(x); }
      else { const p = Object.getPrototypeOf(v); if (p === Object.prototype || p === null) for (const k of [...Object.getOwnPropertyNames(v), ...Object.getOwnPropertySymbols(v)]) { if (k === VIEW) continue; const d = Object.getOwnPropertyDescriptor(v, k)!; if ("value" in d) work.push(d.value); } }
    }
    return null;
  };
  const parkHome = (top: Frame): HomePark | null => {
    const need = slots?.[top.fn]?.[top.pc];
    if (!need) return null;
    for (const ref of need) {
      // "slot" or "slot.m1.m2…": the compiler records a plain member read as its chain, so
      // a VIEW's primitives (nested ones too) don't send the run home. A trailing "=" is a
      // read that only MOVES into a frame slot (the slot's later uses are checked by their
      // own refs): the chain must walk, the value may be anything. "[]=" moves the result
      // of a computed access: the object reached must be complete. Anything else is a
      // value read: a view used as a value parks (its own handle), a primitive stays.
      const base = ref.endsWith("[]="), move = base || ref.endsWith("=");
      const [k, ...chain] = (base ? ref.slice(0, -3) : move ? ref.slice(0, -1) : ref).split(".");
      let v = k === "args" ? top.args
        : k.startsWith("args[") ? (Array.isArray(top.args) ? top.args[Number(k.slice(5, -1))] : top.args)
        : (top as Record<string, unknown>)[k];
      let broke = false;
      for (const m of chain) {
        if (v === null || typeof v !== "object" || isHandle(v)) { broke = true; break; }
        const d = Object.getOwnPropertyDescriptor(v, m);
        const vh = (v as { [VIEW]?: { inst?: true } })[VIEW];
        // an own DATA member is exactly what the read gets; a plain view omits only
        // undefined members; an instance view's missing member is unknown, and a getter
        // or inherited member could reach anything — those check the object itself
        if (d && "value" in d) v = d.value;
        else if (!d && vh && !vh.inst) v = undefined;
        else { broke = true; break; }
      }
      const h = broke ? findHandle(v) : base ? incomplete(v) : move ? null : findHandle(v);
      if (h) return { op: "home", tier: h.owner, name: k, args: [] };
    }
    return null;
  };

  // Run a resource and route a failure into the continuation: if a try/catch is active in
  // any frame on the stack (__unwind walks frames), jump to its catch/finally; otherwise
  // the throw escapes the continuation. This is what lets a resource that fails ON ANOTHER
  // TIER be caught by a try/catch in the migrated code — even one frame up the call stack.
  async function service(stack: Frame[], req: ResourceRequest, execHere: Exec): Promise<void> {
    try { stack[stack.length - 1].ret = await execHere(req); }
    catch (err) { if (!__unwind(stack, err)) throw err; }
  }


  return async function pump(stack, ownsHere, execHere, incoming = null, sink, offer) {
    // the dynamic call park (docs/migrate-arm.md slice 3), resolved in dispatch order:
    // twin method on a class-stamped handle / nested machine / plain promise settled
    // here. Settled promises route rejections like any resource error; a handle with no
    // local meaning parks the stack to its owner — the machine has ALREADY advanced past
    // the park (pc sits at the resume state), so the park must CARRY THE CALL
    // (name "dyn:<member>", args [recv, ...callArgs]) and the owner re-dispatches it
    // here before stepping on, or the resume would read a stale ret.
    // Returns a park to ship, or null when the call settled (ret set / frame pushed / unwound).
    const dispatchDyn = async (stack: Frame[], r: { recv: unknown; path?: string[]; member: string; args: unknown[] }, offer?: (req: { name: string; args: unknown[] }, migratable?: boolean) => boolean): Promise<HomePark | null> => {
      const top = stack[stack.length - 1];
      // a THUNK, invoked inside the try: a synchronous throw from the member call
      // itself (a getter, a sync method body) unwinds exactly like a rejection —
      // the compiled try/catch around the await must see both
      const settle = async (call: () => unknown): Promise<void> => {
        try { top.ret = await call(); } catch (err) { if (!__unwind(stack, err)) throw err; }
      };
      // run the member on a twin (or on an object reached through one), and ship the
      // twin's own data-field changes home so the awaiting code reads its writes
      const onTwin = async (twin: object, target: unknown, where: TwinWhere): Promise<void> => {
        const pre = twinImage(twin);
        try {
          await settle(() => (target as Record<string, (...a: unknown[]) => unknown>)[r.member](...r.args));
        } finally {
          // diff in a FINALLY: plain JS keeps mutations made before a throw, so an
          // uncaught error (settle rethrows) must still ship them home
          const d = sink && twinDelta(pre, twin, where);
          if (d) sink!.twinDelta(d);
        }
      };
      // a receiver PATH off a frame slot (compiler: caps.adminClient.clientScopes): walk
      // it live. Meeting a handle (a view's member handle, or an excised object) means the
      // object lives on another tier: a stamped one may have a session twin here that
      // takes the rest of the path, otherwise the call goes home WITH the rest of its path
      // so the owner walks it live.
      const path = r.path ?? [];
      let recv = r.recv;
      let i = 0;
      try { for (; i < path.length && !isHandle(recv); i++) recv = (recv as Record<string, unknown> | null | undefined)?.[path[i]]; }
      catch (err) { if (!__unwind(stack, err)) throw err; return null; }
      // HOME with the live object in hand: a borrowed STAMPED member of a plain object
      // is exactly what a peer's session twin can stand in for, so the caller may ship
      // the stack there instead of settling this call (and the chain behind it) here.
      const offerable = !!offer && path.length > 0 && !isHandle(r.recv) && isPlain(r.recv) && !!stampOf((r.recv as Record<string, unknown>)[path[0]]);
      if (offerable) {
        const name = "dyn:" + [...path, r.member].join(".");
        if (offer!({ name, args: r.args })) return { op: "home", tier: PEER, name, args: [r.recv, ...r.args] };
      }
      if (isHandle(recv)) {
        const h = recv, rest = path.slice(i);
        // the member's data fields as they were when the stack shipped (h.state): the
        // registry applies what it trusts (realmName yes; a browser-side baseUrl no)
        const twin = h.cls && twins ? twins(h.cls, { id: h.id, owner: h.owner, ...(h.path ? { path: h.path } : {}), ...(h.state ? { state: h.state } : {}) }) : undefined;
        if (twin) {
          let target: unknown = twin;
          try { for (const p of rest) target = (target as Record<string, unknown> | null | undefined)?.[p]; }
          catch (err) { if (!__unwind(stack, err)) throw err; return null; }
          await onTwin(twin, target, { owner: h.owner, id: h.id, ...(h.path ? { path: h.path } : {}) });
          return null;
        }
        const prog = !rest.length && h.cls && PROGRAMS[h.cls + "$" + r.member] ? h.cls + "$" + r.member : null;
        if (prog) stack.push({ fn: prog, pc: 0, args: [h, ...r.args] });
        else return { op: "home", tier: h.owner, name: "dyn:" + [...rest, r.member].join("."), args: [h, ...r.args] };
      } else {
        // a VIEW receiver lacking the member: a method of its class — this tier's program
        // over the view (step 3: compiled library classes), else the call goes home with
        // the view, which decodes to the live object there
        const vh = recv !== null && typeof recv === "object" ? (recv as { [VIEW]?: Handle })[VIEW] : undefined;
        if (vh) {
          const d = Object.getOwnPropertyDescriptor(recv as object, r.member);
          if (!d || !("value" in d)) {
            // a session twin of the view's class takes the call, as it would a handle's
            const twin = vh.cls && twins ? twins(vh.cls, { id: vh.id, owner: vh.owner, ...(vh.path ? { path: vh.path } : {}), state: viewImage(recv as object) }) : undefined;
            if (twin) { await onTwin(twin, twin, { owner: vh.owner, id: vh.id, ...(vh.path ? { path: vh.path } : {}) }); return null; }
            const prog = vh.cls && PROGRAMS[vh.cls + "$" + r.member] ? vh.cls + "$" + r.member : null;
            if (prog) { stack.push({ fn: prog, pc: 0, args: [recv, ...r.args] }); return null; }
            return { op: "home", tier: vh.owner, name: "dyn:" + [...path, r.member].join("."), args: [r.recv, ...r.args] };
          }
        }
        // the member LOOKUP itself can throw (a getter) — that's part of the awaited
        // expression, so it unwinds into the compiled catch exactly like the call would
        let f: ((...a: unknown[]) => unknown) & { __tierless_program?: string; __tierless_caps?: () => object } | undefined;
        try { f = (recv as Record<string, unknown> | null | undefined)?.[r.member] as typeof f; }
        catch (err) { if (!__unwind(stack, err)) throw err; return null; }
        // frame arg 0 differs by kind: a CLASS method's is its receiver (this park's
        // recv — correct as-is); a STORE function's is its OWN caps, which only its
        // closure can build — the compiler stamps the builder for exactly this dispatch
        // (recv here is the CALLER's caps, the wrong frame for the sibling).
        // a member HANDLE: a caps view's borrowed function (`await save(x)` off a migrated
        // closure's caps). It runs where it lives — park home with the call, the view
        // as receiver (it decodes back to the live caps there)
        if (isHandle(f)) return { op: "home", tier: (f as Handle).owner, name: "dyn:" + [...path, r.member].join("."), args: [r.recv, ...r.args] };
        if (f && typeof f.__tierless_program === "string") stack.push({ fn: f.__tierless_program, pc: 0, args: [f.__tierless_caps ? f.__tierless_caps() : recv, ...r.args] });
        else {
          if (!offerable) offer?.({ name: "dyn:" + [...path, r.member].join("."), args: r.args }, false);   // a touch to record, not a migrate point
          await settle(() => f!.apply(recv as object, r.args));
        }
      }
      return null;
    };
    // an op:"home" incoming is a park marker, not a resource. The stop rule's (a slot
    // name) carries nothing — the value is already in the frame's ret; a DYNAMIC park
    // ("dyn:<member>") carries the call, whose receiver decoded to the LIVE local
    // instance here — dispatch it before stepping (the frame's pc is past the park).
    if (incoming && incoming.op !== "home") await service(stack, incoming, execHere);
    else if (incoming && incoming.op === "home" && incoming.name.startsWith("dyn:")) {
      const [recv, ...args] = incoming.args;
      const path = incoming.name.slice(4).split(".");
      const member = path.pop()!;
      const park = await dispatchDyn(stack, { recv, ...(path.length ? { path } : {}), member, args });
      if (park) return { done: false, request: park, stack };   // still no meaning here: park onward (misrouted stack)
    }
    for (;;) {
      const top = stack[stack.length - 1];
      const home = parkHome(top);
      if (home && !ownsHere(home.tier)) return { done: false, request: home, stack };
      const r = PROGRAMS[top.fn](top);
      if (r.op === "return") {
        stack.pop();
        if (!stack.length) return { done: true, value: r.value };
        stack[stack.length - 1].ret = r.value;            // return into the caller frame
      } else if (r.op === "call") {
        stack.push({ fn: r.fn, pc: 0, args: r.args });    // suspendable call: push a sub-frame and run it
      } else if (r.op === "dyn") {
        const park = await dispatchDyn(stack, r, offer);
        if (park) {
          // a handle owned HERE that still has no local meaning cannot be dispatched
          // anywhere — parking it to ourselves would loop, so fail with the member name
          if (ownsHere(park.tier)) throw new Error("tierless: dynamic call on a handle owned here has no local meaning: " + park.name);
          return { done: false, request: park, stack };
        }
      } else if (r.op === "check") {
        continue;
      } else if (r.op === "throw") {
        stack.pop();
        if (!__unwind(stack, r.value)) throw r.value;     // uncaught after unwinding all frames
      } else if (ownsHere(r.tier)) {
        await service(stack, r, execHere);                // owned resource: run it (routing any error), resume locally
      } else {
        return { done: false, request: r, stack };        // foreign resource: migrate to r.tier
      }
    }
  };
}

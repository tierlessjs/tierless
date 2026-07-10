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

import { isHandle } from "./graph.mjs";
import type { Bundle, Frame, Exec, ResourceRequest, HomePark, Pump } from "./types.mjs";

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
  twins?: (cls: string, handle?: { id: string; owner: string }) => object | undefined;
}

export function makePump(bundle: Bundle, { twins }: PumpOpts = {}): Pump {
  const { PROGRAMS, __unwind } = bundle;
  const slots = bundle.__slots as Record<string, Record<number, string[]>> | undefined;

  // §5 stop rule (docs/migrate-arm.md): a machine segment is plain JS — it cannot suspend
  // mid-flight, so a segment that touches an excised local must not START on a tier where
  // that slot is a handle. The compiler emits, per program per state, the frame slots the
  // segment entered there references; if any currently holds a handle, park the stack to
  // the handle's owner BEFORE stepping. "args" means the unpack block reads F.args — its
  // elements are checked too (a nested call can pass a handle as an argument).
  const parkHome = (top: Frame): HomePark | null => {
    const need = slots?.[top.fn]?.[top.pc];
    if (!need) return null;
    for (const k of need) {
      const v = k === "args" ? (Array.isArray(top.args) ? top.args.find(isHandle) : top.args)
        : k.startsWith("args[") ? (Array.isArray(top.args) ? top.args[Number(k.slice(5, -1))] : top.args)
        : (top as Record<string, unknown>)[k];
      if (isHandle(v)) return { op: "home", tier: v.owner, name: k, args: [] };
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

  // a twin call's observable state change, shipped home on the same crossing so the
  // awaiting code reads its writes (docs/migrate-arm.md "twins and correctness"): own
  // enumerable data fields, shallow-diffed around the call
  const dataFields = (o: object): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v !== "function") out[k] = v;
    return out;
  };

  return async function pump(stack, ownsHere, execHere, incoming = null, sink) {
    // an op:"home" incoming is the stop rule's park marker, not a resource — the value it
    // carried home is already in the frame's ret; pump straight on from it
    if (incoming && incoming.op !== "home") await service(stack, incoming, execHere);
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
        // the dynamic call park (docs/migrate-arm.md slice 3), resolved in dispatch order:
        // twin method on a class-stamped handle / nested machine / plain promise settled
        // here. Settled promises route rejections like any resource error; a handle with
        // no local meaning parks the stack to its owner and re-dispatches live there.
        const recv = r.recv;
        // a THUNK, invoked inside the try: a synchronous throw from the member call
        // itself (a getter, a sync method body) unwinds exactly like a rejection —
        // the compiled try/catch around the await must see both
        const settle = async (call: () => unknown): Promise<void> => {
          try { top.ret = await call(); } catch (err) { if (!__unwind(stack, err)) throw err; }
        };
        if (isHandle(recv)) {
          const cls = (recv as { cls?: string }).cls;
          const twin = cls && twins ? twins(cls, { id: recv.id, owner: recv.owner }) : undefined;
          const prog = cls && PROGRAMS[cls + "$" + r.member] ? cls + "$" + r.member : null;
          if (twin) {
            // snapshot JSON IMAGES, not references: this.items.push(x) mutates in place,
            // so Object.is(pre, post) is true and a reference diff ships nothing
            const image = (v: unknown): string | undefined => { try { return JSON.stringify(v); } catch { return undefined; } };
            const pre: Record<string, string | undefined> = {};
            for (const [k, v] of Object.entries(dataFields(twin))) pre[k] = image(v);
            try {
              await settle(() => (twin as Record<string, (...a: unknown[]) => unknown>)[r.member](...r.args));
            } finally {
              // diff in a FINALLY: plain JS keeps mutations made before a throw, so an
              // uncaught error (settle rethrows) must still ship them home
              if (sink) {
                const fields: Record<string, unknown> = {};
                const post = dataFields(twin);
                for (const [k, v] of Object.entries(post)) {
                  const img = image(v);
                  // ship the JSON IMAGE's value, not the live reference: the delta rides a
                  // JSON-encoded reply, so a circular/unserializable field would crash the
                  // whole session at encode time — unserializable changes can't cross, skip
                  if (img !== undefined && img !== pre[k]) fields[k] = JSON.parse(img);
                }
                const gone = Object.keys(pre).filter((k) => !(k in post));   // deletions: assignment can't express them
                if (Object.keys(fields).length || gone.length) sink.twinDelta({ owner: recv.owner, id: recv.id, fields, ...(gone.length ? { gone } : {}) });
              }
            }
          }
          else if (prog) stack.push({ fn: prog, pc: 0, args: [recv, ...r.args] });
          else return { done: false, request: { op: "home", tier: recv.owner, name: r.member, args: [] }, stack };
        } else {
          // the member LOOKUP itself can throw (a getter) — that's part of the awaited
          // expression, so it unwinds into the compiled catch exactly like the call would
          let f: ((...a: unknown[]) => unknown) & { __tierless_program?: string } | undefined;
          try { f = (recv as Record<string, unknown> | null | undefined)?.[r.member] as typeof f; }
          catch (err) { if (!__unwind(stack, err)) throw err; continue; }
          if (f && typeof f.__tierless_program === "string") stack.push({ fn: f.__tierless_program, pc: 0, args: [recv, ...r.args] });
          else await settle(() => f!.apply(recv as object, r.args));
        }
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

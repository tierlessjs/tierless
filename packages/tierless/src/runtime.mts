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
import type { Bundle, Frame, Exec, ResourceRequest, Pump } from "./types.mjs";

export type { Bundle, Frame, MachineResult, ResourceRequest, Exec, Peer, Host } from "./types.mjs";

export const initialStack = (fn: string, args: unknown[] = []): Frame[] => [{ fn, pc: 0, args }];

export function makePump(bundle: Bundle): Pump {
  const { PROGRAMS, __unwind } = bundle;
  const slots = bundle.__slots as Record<string, Record<number, string[]>> | undefined;

  // §5 stop rule (docs/migrate-arm.md): a machine segment is plain JS — it cannot suspend
  // mid-flight, so a segment that touches an excised local must not START on a tier where
  // that slot is a handle. The compiler emits, per program per state, the frame slots the
  // segment entered there references; if any currently holds a handle, park the stack to
  // the handle's owner BEFORE stepping. "args" means the unpack block reads F.args — its
  // elements are checked too (a nested call can pass a handle as an argument).
  const parkHome = (top: Frame): ResourceRequest | null => {
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

  return async function pump(stack, ownsHere, execHere, incoming = null) {
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
      } else if (r.op === "await") {
        // an uncompiled callee's promise: settle it HERE (it was created here this very
        // step — promises never ride a wire) and route a rejection like any resource error
        try { top.ret = await (r.value as Promise<unknown>); }
        catch (err) { if (!__unwind(stack, err)) throw err; }
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

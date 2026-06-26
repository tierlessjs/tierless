// Tier-agnostic continuation runtime. The compiled app (app/bundle.gen.mjs, emitted
// by transform.cjs — no hand-written state machine) exposes PROGRAMS: each entry is a
// step function that advances one frame's state machine and either keeps going,
// returns a value, or yields a tier-pinned resource request.
//
// `pump` runs the continuation ON THE LOCAL TIER: it executes every resource this tier
// owns inline and STOPS at the first resource it doesn't, handing the caller a
// {stack, request} to ship to the owning tier. The same pump runs on both tiers — only
// `ownsHere`/`execHere` differ — so one continuation flows back and forth across the
// wire, finishing wherever the last resource lands.
//
// The wire codec is the project's own identity/cycle-preserving graph codec
// (src/runtime/heap.mjs), the same one the interpreter uses for §5 handles.
import { PROGRAMS, __unwind } from "./app/bundle.gen.mjs";
import { encodeGraph, decodeGraph } from "../../src/runtime/heap.mjs";

export const initialStack = (fn, args = []) => [{ fn, pc: 0, args }];

// A plain JSON string — the boundary between tiers is a true serialize/deserialize
// (no shared memory), so a separate process or machine resumes it identically. The
// stack may hold several frames (a callee suspended under its caller); they all travel.
export const encodeWire = (stack, request) => JSON.stringify(encodeGraph([{ stack, request }]));
export const decodeWire = (wire) => decodeGraph(JSON.parse(wire))[0];

// Run a resource and route a failure into the continuation: if a try/catch is active in
// any frame on the stack (__unwind walks frames), jump to its catch/finally; otherwise
// the throw escapes the continuation. This is what lets a resource that fails ON ANOTHER
// TIER be caught by a try/catch in the migrated code — even one frame up the call stack.
async function service(stack, req, execHere) {
  try { stack[stack.length - 1].ret = await execHere(req); }
  catch (err) { if (!__unwind(stack, err)) throw err; }
}

export async function pump(stack, ownsHere, execHere, incoming = null) {
  if (incoming) await service(stack, incoming, execHere);  // the resource that migrated us here
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") {
      stack.pop();
      if (!stack.length) return { done: true, value: r.value };
      stack[stack.length - 1].ret = r.value;            // return into the caller frame
    } else if (r.op === "call") {
      stack.push({ fn: r.fn, pc: 0, args: r.args });    // suspendable call: push a sub-frame and run it
    } else if (r.op === "throw") {
      stack.pop();
      if (!__unwind(stack, r.value)) throw r.value;     // uncaught after unwinding all frames
    } else if (ownsHere(r.tier)) {
      await service(stack, r, execHere);                // owned resource: run it (routing any error), resume locally
    } else {
      return { done: false, request: r, stack };        // foreign resource: migrate to r.tier
    }
  }
}

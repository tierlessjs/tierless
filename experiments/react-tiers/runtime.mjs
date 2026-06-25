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
import { PROGRAMS } from "./app/bundle.gen.mjs";
import { encodeGraph, decodeGraph } from "../../src/runtime/heap.mjs";

export const initialStack = (fn, args = []) => [{ fn, pc: 0, args }];

// A plain JSON string — the boundary between tiers is a true serialize/deserialize
// (no shared memory), so a separate process or machine resumes it identically.
export const encodeWire = (stack, request) => JSON.stringify(encodeGraph([{ stack, request }]));
export const decodeWire = (wire) => decodeGraph(JSON.parse(wire))[0];

export async function pump(stack, ownsHere, execHere, incoming = null) {
  if (incoming) stack[stack.length - 1].ret = await execHere(incoming);  // the resource that migrated us here
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") {
      stack.pop();
      if (!stack.length) return { done: true, value: r.value };
      stack[stack.length - 1].ret = r.value;            // return into the caller frame
    } else if (ownsHere(r.tier)) {
      stack[stack.length - 1].ret = await execHere(r);  // owned resource: run it, resume locally
    } else {
      return { done: false, request: r, stack };        // foreign resource: migrate to r.tier
    }
  }
}

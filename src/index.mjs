// Stackmix — public API surface (the single supported entry point).
//
// `createRuntime()` is the batteries-included entry: it owns a program registry
// and binds the interpreter and the TypeScript frontend to it, so two independent
// programs never share state (the prototype's process-wide singleton is gone).
//
// Lower-level primitives — `run`, `Tier`, the continuation wire codec, the
// compiler functions — are re-exported for advanced use. Deep imports
// (`#stackmix/runtime/...`, `#stackmix/wasm/...`) remain available but carry no
// stability guarantee; this barrel is the stable surface.

import { run } from "./runtime/core.mjs";
import { loadModule, loadProgram, describeContinuation } from "./compiler/tsc.mjs";

/**
 * Create an isolated runtime: a program registry plus the interpreter and
 * TypeScript frontend bound to it.
 * @returns a runtime with `program`, `load`, `loadProgram`, `define`, `run`,
 *   `describe`, and `reset`.
 */
export function createRuntime() {
  const program = {};
  return {
    // The raw registry (name -> { nlocals, code, pos? }). Exposed for
    // introspection / advanced use; prefer the methods below.
    program,
    // Compile a single TypeScript module into this runtime.
    load(source, opts) { return loadModule(program, source, opts); },
    // Compile a multi-file import graph into this runtime.
    loadProgram(files, opts) { return loadProgram(program, files, opts); },
    // Install hand-written IR under `name` (no frontend, no wasm).
    define(name, ir) { program[name] = ir; return ir; },
    // Run `frames` on `tier` until they return or suspend at a resource boundary.
    run(tier, frames, host) { return run(program, tier, frames, host); },
    // A human-readable stack trace (fn + source position per frame).
    describe(frames) { return describeContinuation(program, frames); },
    // Forget all loaded code (mainly for tests reusing one runtime).
    reset() { for (const k in program) delete program[k]; return this; },
  };
}

// --- Runtime primitives ------------------------------------------------------
export {
  run, Tier, Suspend, Miss, StackmixUncaught, Yielded,
  serializeContinuation, deserializeContinuation, contBytes,
  pendingName, wireHandles, initialFrames, padLocals,
  isHandle, isGenerator, isClosure, awaitable, fmt, HANDLE_THRESHOLD,
} from "./runtime/core.mjs";

// --- Wire / heap / transport -------------------------------------------------
export { encodeGraph, decodeGraph } from "./runtime/heap.mjs";
export { writeFrame, readFrames } from "./runtime/frame.mjs";
export { Heap, Channel, makeHost } from "./runtime/fetch.mjs";

// --- Compiler (TypeScript -> Stackmix IR) ------------------------------------
export {
  compileModule, compileProgram, loadModule, loadProgram, describeContinuation,
} from "./compiler/tsc.mjs";

// Stackmix — public API surface.
//
// This barrel is the single supported entry point for the framework. Internal
// module layout (runtime/, compiler/, wasm/) may change; what is re-exported
// here is the stable surface. Deep imports (`#stackmix/runtime/...`) remain
// available for advanced/experimental use but carry no stability guarantee.

export * from "./runtime/core.mjs";
export { encodeGraph, decodeGraph } from "./runtime/heap.mjs";
export { writeFrame, readFrames } from "./runtime/frame.mjs";
export { Heap, Channel, makeHost } from "./runtime/fetch.mjs";
export {
  compileModule, loadModule, compileProgram, loadProgram, describeContinuation,
} from "./compiler/tsc.mjs";

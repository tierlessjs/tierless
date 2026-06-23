// Probe: does an IR program *compiled* to wasm (not hand-written) keep a
// serializable, migratable continuation — across control flow AND a heap pointer?
// (the next step after probes/asyncify.mjs)
//
// Three hand-lowered Stackmix IR programs go through the AOT compiler
// (src/wasm/aot.mjs: IR -> Binaryen -> WASM + Asyncify):
//   1. straight-line: main() calls inner() which hits a RES.
//   2. a LOOP that hits a RES each iteration — we suspend MID-loop, so the
//      loop-carried locals (accumulator + counter) must survive.
//   3. a HEAP program: allocate an array, write its fields, hold the POINTER
//      across a RES, then read the fields back — so the heap region (and the
//      bump pointer) must travel with the continuation, not just the locals.
// In each, we suspend at a RES, slice the live state out of linear memory, ship
// it through JSON, and resume in a FRESH instance to the same value as the
// non-suspended run.

import { compileToWasm, BUMP_ADDR, HEAP_BASE } from "#stackmix/wasm/aot.mjs";

const DATA_PTR = 16, STACK_BASE = 1024, STACK_END = 8192, RES = 42;

function instantiate(bytes, onResource) {
  const holder = {};
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { resource: () => onResource(holder.ex) } });
  holder.ex = inst.exports;
  return inst.exports;
}
const seti32 = (mem, a, v) => new DataView(mem.buffer).setInt32(a, v, true);
const geti32 = (mem, a) => new DataView(mem.buffer).getInt32(a, true);

const baseline = (bytes) => { const ex = instantiate(bytes, () => RES); seti32(ex.memory, BUMP_ADDR, HEAP_BASE); return ex.main(); };

// Suspend instance A at its `suspendOnCall`-th resource call, serialize the
// whole low memory region (asyncify stack + heap) through JSON, resume in B.
function migrate(bytes, suspendOnCall) {
  let calls = 0;
  const A = instantiate(bytes, (ex) => { calls++; if (calls === suspendOnCall) { ex.asyncify_start_unwind(DATA_PTR); return 0; } return RES; });
  seti32(A.memory, BUMP_ADDR, HEAP_BASE);
  seti32(A.memory, DATA_PTR, STACK_BASE);
  seti32(A.memory, DATA_PTR + 4, STACK_END);
  A.main();
  A.asyncify_stop_unwind();
  const shipped = JSON.parse(JSON.stringify(Array.from(new Uint8Array(A.memory.buffer, 0, STACK_END))));

  const B = instantiate(bytes, (ex) => { if (ex.asyncify_get_state() === 2) ex.asyncify_stop_rewind(); return RES; });
  new Uint8Array(B.memory.buffer).set(Uint8Array.from(shipped));
  B.asyncify_start_rewind(DATA_PTR);
  return { value: B.main(), used: geti32(A.memory, DATA_PTR) - STACK_BASE };
}

const results = [];
const check = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };

// --- 1. straight-line: main() = y + (x + resource) = 100 + (10 + 42) = 152 ----
const straight = {
  inner: { argc: 0, nlocals: 2, code: [
    ["PUSH", 10], ["STORE", 0], ["RES", "resource", 0], ["STORE", 1], ["LOAD", 0], ["LOAD", 1], ["ADD"], ["RET"],
  ] },
  main: { argc: 0, nlocals: 2, code: [
    ["PUSH", 100], ["STORE", 0], ["CALL", "inner", 0], ["STORE", 1], ["LOAD", 0], ["LOAD", 1], ["ADD"], ["RET"],
  ] },
};
const sBytes = compileToWasm(straight, { entry: "main", resources: ["resource"] });
check(`straight-line baseline == 152`, baseline(sBytes) === 152);
check(`straight-line continuation resumed in a FRESH instance == 152`, migrate(sBytes, 1).value === 152);

// --- 2. loop: acc += resource() three times -> 126; suspend on the 2nd pass ---
const loop = {
  main: { argc: 0, nlocals: 2, code: [
    ["PUSH", 0], ["STORE", 0], ["PUSH", 0], ["STORE", 1],
    "loop",
    ["LOAD", 1], ["PUSH", 3], ["LT"], ["JMPF", "end"],
    ["RES", "resource", 0], ["LOAD", 0], ["ADD"], ["STORE", 0],   // acc = resource() + acc
    ["LOAD", 1], ["PUSH", 1], ["ADD"], ["STORE", 1],              // i = i + 1
    ["JMP", "loop"],
    "end",
    ["LOAD", 0], ["RET"],
  ] },
};
const lBytes = compileToWasm(loop, { entry: "main", resources: ["resource"] });
check(`loop baseline (3x resource) == 126`, baseline(lBytes) === 126);
check(`MID-loop continuation resumed in a FRESH instance == 126 (loop locals survived)`, migrate(lBytes, 2).value === 126);

// --- 3. heap: p=alloc(2); p[0]=10; p[1]=30; r=resource(); return p[0]+p[1]+r=82 -
const heap = {
  main: { argc: 0, nlocals: 1, code: [
    ["PUSH", 2], ["ALLOC"], ["STORE", 0],
    ["LOAD", 0], ["PUSH", 0], ["PUSH", 10], ["ASET"],
    ["LOAD", 0], ["PUSH", 1], ["PUSH", 30], ["ASET"],
    ["RES", "resource", 0],
    ["LOAD", 0], ["PUSH", 0], ["AGET"], ["ADD"],
    ["LOAD", 0], ["PUSH", 1], ["AGET"], ["ADD"],
    ["RET"],
  ] },
};
const hBytes = compileToWasm(heap, { entry: "main", resources: ["resource"] });
check(`heap baseline (alloc + fields + resource) == 82`, baseline(hBytes) === 82);
check(`continuation holding a heap POINTER resumed in a FRESH instance == 82`, migrate(hBytes, 1).value === 82);

const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — an IR-compiled continuation serialized and resumed in a fresh instance, across control flow and a heap pointer`);
process.exit(ok ? 0 : 1);

// Probe: does an IR program *compiled* to wasm (not hand-written) keep a
// serializable, migratable continuation — including across control flow?
// (the next step after probes/asyncify.mjs)
//
// Two hand-lowered Stackmix IR programs go through the AOT compiler
// (src/wasm/aot.mjs: IR -> Binaryen -> WASM + Asyncify):
//   1. straight-line: main() calls inner() which hits a RES.
//   2. a LOOP that calls a RES each iteration — we suspend MID-loop, so the
//      loop-carried locals (the accumulator and the counter) must survive.
// In both, we suspend at a RES, slice the live call stack out of linear memory,
// ship it through JSON, and resume in a FRESH instance to the same value as the
// non-suspended run. The loop case is what proves the Relooper-generated control
// flow stays resumable after a migration.

import { compileToWasm } from "#stackmix/wasm/aot.mjs";

const DATA_PTR = 16, STACK_BASE = 1024, STACK_END = 8192, RES = 42;

function instantiate(bytes, onResource) {
  const holder = {};
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { resource: () => onResource(holder.ex) } });
  holder.ex = inst.exports;
  return inst.exports;
}
const seti32 = (mem, a, v) => new DataView(mem.buffer).setInt32(a, v, true);
const geti32 = (mem, a) => new DataView(mem.buffer).getInt32(a, true);

// Suspend instance A at its `suspendOnCall`-th resource call, serialize the
// continuation through JSON, and resume it in a fresh instance B.
function migrate(bytes, suspendOnCall) {
  let calls = 0;
  const A = instantiate(bytes, (ex) => { calls++; if (calls === suspendOnCall) { ex.asyncify_start_unwind(DATA_PTR); return 0; } return RES; });
  seti32(A.memory, DATA_PTR, STACK_BASE);
  seti32(A.memory, DATA_PTR + 4, STACK_END);
  A.main();
  A.asyncify_stop_unwind();
  const shipped = JSON.parse(JSON.stringify(Array.from(new Uint8Array(A.memory.buffer, 0, STACK_END))));

  const B = instantiate(bytes, (ex) => { if (ex.asyncify_get_state() === 2) ex.asyncify_stop_rewind(); return RES; });
  new Uint8Array(B.memory.buffer).set(Uint8Array.from(shipped));
  B.asyncify_start_rewind(DATA_PTR);
  return { value: B.main(), used: geti32(A.memory, DATA_PTR) - STACK_BASE, bytes: shipped.length };
}

const results = [];
const check = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };

// --- 1. straight-line: main() = y + (x + resource) = 100 + (10 + 42) = 152 ----
const straight = {
  inner: { argc: 0, nlocals: 2, code: [
    ["PUSH", 10], ["STORE", 0], ["RES", "resource", 0], ["STORE", 1],
    ["LOAD", 0], ["LOAD", 1], ["ADD"], ["RET"],
  ] },
  main: { argc: 0, nlocals: 2, code: [
    ["PUSH", 100], ["STORE", 0], ["CALL", "inner", 0], ["STORE", 1],
    ["LOAD", 0], ["LOAD", 1], ["ADD"], ["RET"],
  ] },
};
const sBytes = compileToWasm(straight, { entry: "main", resources: ["resource"] });
check(`straight-line baseline == 152`, instantiate(sBytes, () => RES).main() === 152);
check(`straight-line continuation resumed in a FRESH instance == 152`, migrate(sBytes, 1).value === 152);

// --- 2. loop: acc += resource() three times -> 126; suspend on the 2nd pass ---
//   main(): acc=0; i=0; while (i<3) { acc = resource()+acc; i=i+1 } return acc
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
check(`loop baseline (3x resource) == 126`, instantiate(lBytes, () => RES).main() === 126);
const mid = migrate(lBytes, 2); // suspend at the start of the 2nd iteration (acc=42, i=1)
check(`MID-loop continuation resumed in a FRESH instance == 126 (loop locals survived)`, mid.value === 126);

console.log(`\n  mid-loop continuation captured: ${mid.used} B`);
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — an IR-compiled continuation serialized and resumed in a fresh instance, across control flow`);
process.exit(ok ? 0 : 1);

// Probe: does an IR program *compiled* to wasm (not hand-written) keep a
// serializable, migratable continuation? (the next step after probes/asyncify.mjs)
//
// We hand-lower a tiny straight-line numeric program to Stackmix IR — main()
// calls inner() which hits a RES (resource) — run it through the AOT compiler
// (src/wasm/aot.mjs: IR -> Binaryen -> WASM + Asyncify), then suspend at the RES,
// slice the live call stack out of linear memory, ship it through JSON, and
// resume it in a FRESH instance. The compiled program must return the same value
// as the non-suspended run, which requires both frames' locals to cross. Same
// proof as the Asyncify probe, but now the module came out of the *codegen*.

import { compileToWasm } from "#stackmix/wasm/aot.mjs";

const DATA_PTR = 16, STACK_BASE = 1024, STACK_END = 8192;
const RES_RESULT = 42;
const EXPECT = 100 + (10 + RES_RESULT);   // main = y + (x + resource) = 152

// Hand-lowered Stackmix IR (a stack machine), the same shape the frontend emits:
//   inner(): x=10; r=resource(); return x+r
//   main():  y=100; s=inner();  return y+s
const program = {
  inner: { argc: 0, nlocals: 2, code: [
    ["PUSH", 10], ["STORE", 0],
    ["RES", "resource", 0], ["STORE", 1],
    ["LOAD", 0], ["LOAD", 1], ["ADD"], ["RET"],
  ] },
  main: { argc: 0, nlocals: 2, code: [
    ["PUSH", 100], ["STORE", 0],
    ["CALL", "inner", 0], ["STORE", 1],
    ["LOAD", 0], ["LOAD", 1], ["ADD"], ["RET"],
  ] },
};

const bytes = compileToWasm(program, { entry: "main", resources: ["resource"] });

function instantiate(onResource) {
  const holder = {};
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { resource: () => onResource(holder.ex) } });
  holder.ex = inst.exports;
  return inst.exports;
}
const seti32 = (mem, a, v) => new DataView(mem.buffer).setInt32(a, v, true);
const geti32 = (mem, a) => new DataView(mem.buffer).getInt32(a, true);

const results = [];
const check = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };

// --- baseline: the compiled program, resource returns straight through --------
check(`compiled baseline (no suspend) == ${EXPECT}`, instantiate(() => RES_RESULT).main() === EXPECT);

// --- migrate: instance A suspends at the RES, fresh instance B resumes ---------
const A = instantiate((ex) => { ex.asyncify_start_unwind(DATA_PTR); return 0; });
seti32(A.memory, DATA_PTR, STACK_BASE);
seti32(A.memory, DATA_PTR + 4, STACK_END);
A.main();
A.asyncify_stop_unwind();

const used = geti32(A.memory, DATA_PTR) - STACK_BASE;
const shipped = JSON.parse(JSON.stringify(Array.from(new Uint8Array(A.memory.buffer, 0, STACK_END))));

const B = instantiate((ex) => { ex.asyncify_stop_rewind(); return RES_RESULT; });
new Uint8Array(B.memory.buffer).set(Uint8Array.from(shipped));
B.asyncify_start_rewind(DATA_PTR);

check(`IR-compiled continuation resumed in a FRESH instance == ${EXPECT}`, B.main() === EXPECT);
check(`continuation shipped as plain serializable bytes`, Array.isArray(shipped) && shipped.length === STACK_END);

console.log(`\n  live continuation captured: ${used} B (a 2-frame call stack of compiled IR)`);
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — an IR-compiled continuation serialized and resumed in a fresh instance`);
process.exit(ok ? 0 : 1);

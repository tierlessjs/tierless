// Probe: real TypeScript -> native WASM (no interpreter) -> and it migrates.
// The first "make it real" step: actual TS source goes through the reference
// frontend (compile.mjs) and the AOT compiler (aot.mjs) to a compiled WASM
// module, runs natively, and a continuation captured at a resource call
// serializes and resumes in a fresh instance.

import { compileTsToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, tagInt, untagInt } from "#stackmix/wasm/aot.mjs";
import { DATA_PTR, STACK_BASE, STACK_END } from "#stackmix/wasm/heapwire.mjs";

// Ordinary TypeScript: a helper, a loop, and a resource call (the suspend point).
const SRC = `
declare const db: { query(): number };
function add(a: number, b: number): number { return a + b; }
function main(): number {
  let s = 0;
  for (let i = 0; i < 10; i = i + 1) { s = add(s, i); }   // 0 + 1 + ... + 9 = 45
  return s + db.query();                                  // + 42 = 87
}`;
const bytes = compileTsToWasm(SRC, { entry: "main" });
const RES = 42, EXPECT = 45 + RES;

function instantiate(onResource) {
  const holder = {};
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { "db.query": () => onResource(holder.ex) } });
  holder.ex = inst.exports;
  return inst.exports;
}
const seti32 = (mem, a, v) => new DataView(mem.buffer).setInt32(a, v, true);

const results = [];
const check = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };

// Baseline: run the compiled TS natively.
const base = instantiate(() => tagInt(RES));
seti32(base.memory, BUMP_ADDR, HEAP_BASE);
check(`real TS compiled to native wasm runs == ${EXPECT}`, untagInt(base.main()) === EXPECT);

// Migrate: suspend at db.query(), serialize the continuation, resume in a fresh instance.
const A = instantiate((e) => { e.asyncify_start_unwind(DATA_PTR); return 0; });
seti32(A.memory, BUMP_ADDR, HEAP_BASE);
seti32(A.memory, DATA_PTR, STACK_BASE);
seti32(A.memory, DATA_PTR + 4, STACK_END);
A.main();
A.asyncify_stop_unwind();
const blob = JSON.parse(JSON.stringify(Array.from(new Uint8Array(A.memory.buffer, 0, STACK_END))));

const B = instantiate((e) => { if (e.asyncify_get_state() === 2) e.asyncify_stop_rewind(); return tagInt(RES); });
new Uint8Array(B.memory.buffer).set(Uint8Array.from(blob));
B.asyncify_start_rewind(DATA_PTR);
check(`its continuation resumed in a FRESH instance == ${EXPECT}`, untagInt(B.main()) === EXPECT);

const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — real TypeScript compiled to native wasm, ran, and migrated`);
process.exit(ok ? 0 : 1);

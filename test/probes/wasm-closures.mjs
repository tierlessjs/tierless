// Probe: the AOT compiler runs the REAL frontend's closure IR — and still
// matches the interpreter (the differential oracle, closure edition).
//
// wasm-diff.mjs compiles the native side through compile.mjs (a numeric subset
// that emits direct CALLs). This probe compiles the native side through the full
// TypeScript frontend (tsc.mjs), whose IR lowers every function to a closure:
// a user call is MAKECLOSURE + CALLV (call through a function table), and binary
// operators are BIN. So this exercises the closure machinery end to end — and the
// interpreter (also tsc.mjs) is the oracle, so native must agree value-for-value.
//
// Captures are deferred (no-capture closures only), so the programs here are
// top-level functions: direct calls, nested calls, recursion, mutual recursion,
// and calls inside loops, across the BIN operator set.

import { createRuntime, Tier, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, tagInt, untagInt } from "#stackmix/wasm/aot.mjs";

const RES = 42;

const programs = [
  ["direct call", `
    declare const db: { query(): number };
    function add(a: number, b: number): number { return a + b; }
    function main(): number { return add(1, 2) + db.query(); }`],                    // 3 + 42 = 45
  ["nested calls", `
    declare const db: { query(): number };
    function dbl(x: number): number { return x + x; }
    function main(): number { return dbl(dbl(3)) + db.query(); }`],                   // 12 + 42 = 54
  ["recursion (factorial)", `
    declare const db: { query(): number };
    function fact(n: number): number { if (n <= 1) { return 1; } return n * fact(n - 1); }
    function main(): number { return fact(5) + db.query(); }`],                       // 120 + 42 = 162
  ["mutual recursion", `
    declare const db: { query(): number };
    function isEven(n: number): number { if (n === 0) { return 1; } return isOdd(n - 1); }
    function isOdd(n: number): number { if (n === 0) { return 0; } return isEven(n - 1); }
    function main(): number { return isEven(8) + db.query(); }`],                     // 1 + 42 = 43
  ["call inside a loop", `
    declare const db: { query(): number };
    function inc(x: number): number { return x + 1; }
    function main(): number { let s = 0; for (let i = 0; i < 5; i = i + 1) { s = inc(s); } return s + db.query(); }`], // 5 + 42 = 47
  ["operator mix through a helper", `
    declare const db: { query(): number };
    function f(a: number, b: number): number { return (a - b) * 2; }
    function main(): number { return f(7, 3) + db.query(); }`],                       // 8 + 42 = 50
  ["comparison returned through a call", `
    declare const db: { query(): number };
    function gt(a: number, b: number): number { if (a > b) { return 1; } return 0; }
    function main(): number { return gt(5, 3) + gt(1, 9) + db.query(); }`],           // 1 + 0 + 42 = 43
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: ["db.query"] });
  const tier = new Tier("t", { "db.query": () => RES });
  return rt.run(tier, initialFrames("main", []), { deref: () => { throw new Error("no deref"); } }).value;
}
function native(src) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(compileModuleToWasm(src, { entry: "main", resources: ["db.query"] })), { env: { "db.query": () => tagInt(RES) } });
  new DataView(inst.exports.memory.buffer).setInt32(BUMP_ADDR, HEAP_BASE, true);
  return untagInt(inst.exports.main());
}

const results = [];
for (const [name, src] of programs) {
  const i = interp(src), n = native(src);
  const ok = i === n;
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: interpreter ${i} == native ${n}`);
}

// Migration: the suspend happens INSIDE a function reached through CALLV, so the
// call_indirect frame is live on the stack when Asyncify unwinds. If closures
// migrate, that frame is saved into linear memory, ships, and rewinds in a fresh
// instance — the whole reason the value model lives in linear memory.
const DATA_PTR = 16, STACK_BASE = 1024, STACK_END = 8192;
const migrateSrc = `
  declare const db: { query(): number };
  function load(x: number): number { return x + db.query(); }
  function main(): number { return load(10); }`;            // 10 + 42 = 52, suspending inside load()
const mBytes = compileModuleToWasm(migrateSrc, { entry: "main", resources: ["db.query"] });
const seti32 = (mem, a, v) => new DataView(mem.buffer).setInt32(a, v, true);
const inst = (onQuery) => { const h = {}; const i = new WebAssembly.Instance(new WebAssembly.Module(mBytes), { env: { "db.query": () => onQuery(h.ex) } }); h.ex = i.exports; return i.exports; };

const A = inst((ex) => { ex.asyncify_start_unwind(DATA_PTR); return 0; });
seti32(A.memory, BUMP_ADDR, HEAP_BASE); seti32(A.memory, DATA_PTR, STACK_BASE); seti32(A.memory, DATA_PTR + 4, STACK_END);
A.main();                                                   // suspends inside load() (a CALLV frame is live)
A.asyncify_stop_unwind();
const shipped = Uint8Array.from(new Uint8Array(A.memory.buffer, 0, STACK_END));

const B = inst((ex) => { if (ex.asyncify_get_state() === 2) ex.asyncify_stop_rewind(); return tagInt(RES); });
new Uint8Array(B.memory.buffer).set(shipped);
B.asyncify_start_rewind(DATA_PTR);
const resumed = untagInt(B.main());
results.push(resumed === 52);
console.log(`  ${resumed === 52 ? "PASS" : "FAIL"}  closure frame migrated: suspended inside a CALLV, resumed in a FRESH instance == ${resumed}`);

const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs the real frontend's closures (MAKECLOSURE/CALLV/BIN), matches the interpreter, and migrates a continuation suspended inside a closure call`);
process.exit(ok ? 0 : 1);

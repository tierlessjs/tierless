// Probe: the AOT compiler runs generators — and still matches the interpreter.
//
// The interpreter drives a generator by splicing interpreter frames; native code
// can't, so a generator function compiles to a state machine instead: a
// TRAMPOLINE (what a normal call reaches) allocates a generator object holding
// the body's table index, the saved ip, and the locals; and a DISPATCH BODY that
// br_tables on the saved ip to the right basic block, runs to the next YIELD
// (save locals + ip, return the value, done=0) or RET (done=1). GENNEXT drives it
// one step into a {value, done} object; for-of and .next() consume that. Each
// program runs interpreted (tsc.mjs + core.mjs) and compiled to native wasm; the
// decoded native value must equal the interpreter's. (yield as a statement, the
// common generator; two-way next()/yield*/return-throw are later slices.)

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["fixed yields, for-of sum", `
    function* g() { yield 10; yield 20; yield 30; }
    function main() { let s = 0; for (const x of g()) { s = s + x; } return s; }`],          // 60
  ["range generator, for-of sum", `
    function* range(a, b) { for (let i = a; i < b; i = i + 1) { yield i; } }
    function main() { let s = 0; for (const x of range(1, 5)) { s = s + x; } return s; }`],    // 1+2+3+4 = 10
  ["explicit .next() values and done", `
    function* g() { yield 7; yield 8; }
    function main() { const it = g(); const a = it.next(); const b = it.next(); const c = it.next(); return a.value + b.value + (c.done ? 100 : 0); }`], // 7+8+100 = 115
  ["generator with an accumulator local", `
    function* sums(n) { let acc = 0; for (let i = 1; i <= n; i = i + 1) { acc = acc + i; yield acc; } }
    function main() { let last = 0; for (const x of sums(4)) { last = x; } return last; }`],   // running sums 1,3,6,10 -> 10
  ["nested loops in a generator", `
    function* g() { for (let i = 0; i < 3; i = i + 1) { for (let j = 0; j < 2; j = j + 1) { yield i; } } }
    function main() { let s = 0; for (const x of g()) { s = s + x; } return s; }`],            // 0,0,1,1,2,2 -> 6
  ["count how many a generator yields", `
    function* range(a, b) { for (let i = a; i < b; i = i + 1) { yield i; } }
    function main() { let n = 0; for (const x of range(10, 17)) { n = n + 1; } return n; }`],   // 7
  ["two independent generators interleave", `
    function* g() { yield 1; yield 2; yield 3; }
    function main() { const a = g(), b = g(); const r1 = a.next().value; const r2 = b.next().value; const r3 = a.next().value; return r1 * 100 + r2 * 10 + r3; }`], // 1,1,2 -> 112
  ["empty generator is immediately done", `
    function* g() { return; }
    function main() { const it = g(); return it.next().done ? 1 : 0; }`],                       // 1
  ["two-way next(): a sent value becomes the yield's value", `
    function* echo() { const a = yield 1; const b = yield a; return b; }
    function main() { const it = echo(); it.next(); return it.next(5).value; }`],                // 5
  ["two-way next(): running accumulator fed by next()", `
    function* adder() { let t = 0; while (true) { const x = yield t; t = t + x; } }
    function main() { const it = adder(); it.next(); it.next(10); return it.next(20).value; }`],  // 0 then +10 +20 -> 30
  ["return() abandons the generator with its value", `
    function* g() { yield 1; yield 2; yield 3; }
    function main() { const it = g(); it.next(); return it.return(99).value; }`],                  // 99
  ["return() leaves the generator done", `
    function* g() { yield 1; yield 2; }
    function main() { const it = g(); it.next(); it.return(0); return it.next().done ? 1 : 0; }`], // 1
  ["yield* delegates to another generator", `
    function* inner() { yield 1; yield 2; }
    function* outer() { yield* inner(); yield 3; }
    function main() { let s = 0; for (const x of outer()) { s = s + x; } return s; }`],            // 1+2+3 = 6
  ["yield* between surrounding yields", `
    function* inner() { yield 2; yield 3; }
    function* outer() { yield 1; yield* inner(); yield 4; yield 5; }
    function main() { let s = 0; for (const x of outer()) { s = s + x; } return s; }`],            // 1+2+3+4+5 = 15
  ["yield* a range generator", `
    function* range(a, b) { for (let i = a; i < b; i = i + 1) { yield i; } }
    function* g() { yield* range(1, 5); }
    function main() { let s = 0; for (const x of g()) { s = s + x; } return s; }`],                 // 1+2+3+4 = 10
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: [] });
  return rt.run({ id: "t" }, initialFrames("main", []), { deref: (x) => x }).value;
}
function native(src) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(compileModuleToWasm(src, { entry: "main", resources: [] })), { env: {} });
  new DataView(inst.exports.memory.buffer).setInt32(BUMP_ADDR, HEAP_BASE, true);
  return readValue(inst.exports.memory, inst.exports.main());
}

const results = [];
for (const [name, src] of programs) {
  const i = interp(src), n = native(src);
  const ok = Object.is(i, n);
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: interpreter ${JSON.stringify(i)} == native ${JSON.stringify(n)}`);
}
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs generators (yield, for-of, .next()/done) as a state machine and matches the interpreter`);
process.exit(ok ? 0 : 1);

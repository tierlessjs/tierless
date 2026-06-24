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
import { BUMP_ADDR, HEAP_BASE, readValue, stdlibHost } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["fixed yields, for-of sum", `
    function* g() { yield 10; yield 20; yield 30; }
    function main() { let s = 0; for (const x of g()) { s = s + x; } return s; }`],          // 60
  ["string and float literals in a generator body", `
    function* g() { yield "first"; yield 1.5; yield "last"; }
    function main() { let s = ""; for (const x of g()) { s = s + x + ","; } return s; }`],   // "first,1.5,last," — literals built on the heap inside the gen body
  ["a generator method reads this", `
    class Counter { constructor(n) { this.n = n; } *upto() { for (let i = 0; i < this.n; i++) { yield i * 10; } } }
    function main() { const c = new Counter(4); let s = 0; for (const x of c.upto()) { s = s + x; } return s; }`], // 0+10+20+30 = 60
  ["a generator closes over an outer variable", `
    function make(base) { return function* () { yield base; yield base + 1; yield base + 2; }; }
    function main() { let s = 0; for (const x of make(100)()) { s = s + x; } return s; }`],   // 100+101+102 = 303
  ["a generator builds and consumes an array internally", `
    function* squares(n) { const a = []; for (let i = 1; i <= n; i++) { a.push(i); } for (const x of a) { yield x * x; } }
    function main() { let s = 0; for (const v of squares(4)) { s = s + v; } return s; }`],     // 1+4+9+16 = 30
  ["it.return() runs finally and completes", `
    function* g(log) { try { yield 1; yield 2; } finally { log.push("C"); } }
    function main() { const log = []; const it = g(log); const a = it.next().value; const r = it.return("STOP"); return a + "/" + r.value + "/" + r.done + "/" + log.join("") + "/" + it.next().done; }`], // "1/STOP/true/C/true"
  ["it.return() runs nested finallys inner-to-outer", `
    function* g(log) { try { try { yield 1; } finally { log.push("in"); } } finally { log.push("out"); } }
    function main() { const log = []; const it = g(log); it.next(); it.return(0); return log.join(","); }`], // "in,out"
  ["a throw inside a finally during return propagates", `
    function* g() { try { yield 1; } finally { throw "BOOM"; } }
    function main() { const it = g(); it.next(); try { it.return(1); return "no"; } catch (e) { return "caught:" + e; } }`], // "caught:BOOM"
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
  ["throw() into a generator propagates to an outer catch", `
    function* g() { yield 1; yield 2; }
    function main() { const it = g(); it.next(); try { it.throw(42); return 0 - 1; } catch (e) { return e; } }`], // 42
  ["throw() is caught inside the generator, which recovers", `
    function* c() { try { yield 1; } catch (e) { yield e + 100; } yield 3; }
    function main() { const it = c(); it.next(); return it.throw(5).value; }`],                     // caught 5 -> yield 105
  ["a caught throw() lets the generator continue", `
    function* c() { try { yield 1; } catch (e) { yield e; } yield 3; }
    function main() { const it = c(); it.next(); it.throw(9); return it.next().value; }`],          // ...then yield 3
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: [] });
  return rt.run({ id: "t" }, initialFrames("main", []), { deref: (x) => x }).value;
}
function native(src) {
  const sh = stdlibHost(); // a generator may build float/string literals -> the delegated stdlib (Number->string) is provided by the host
  const inst = new WebAssembly.Instance(new WebAssembly.Module(compileModuleToWasm(src, { entry: "main", resources: [] })), { env: sh.imports });
  sh.bind(inst);
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

// Probe: the AOT compiler runs closures that CAPTURE — and still matches the
// interpreter (the differential oracle, capture edition).
//
// The real frontend lowers every function to a closure and boxes each captured
// variable into a heap cell, so a closure carries an environment: MAKECLOSURE
// stores the captured values into the closure object, LOADENV reads them back,
// and every function receives its closure as an implicit env parameter. This is
// what makes makeAdder, a stateful counter, and per-iteration `let` work. Each
// program runs interpreted (tsc.mjs + core.mjs) and compiled to native wasm
// (tsc.mjs + aot.mjs); the decoded native value must equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, decodeValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["an arrow captures lexical this", `
    class Counter { constructor() { this.n = 0; } makeInc() { return () => { this.n = this.n + 1; return this.n; }; } }
    function main() { const c = new Counter(); const inc = c.makeInc(); return inc() + inc() + inc(); }`],   // 1+2+3 = 6
  ["a nested arrow forwards lexical this", `
    class Box { constructor() { this.v = 10; } make() { return () => () => this.v; } }
    function main() { return new Box().make()()(); }`],                                                      // 10
  ["makeAdder captures a param", `
    function makeAdder(n) { return (x) => x + n; }
    function main() { const a5 = makeAdder(5); const a10 = makeAdder(10); return a5(1) + a10(1); }`], // 6 + 11 = 17
  ["stateful counter (mutable capture)", `
    function mk() { let c = 0; return () => { c = c + 1; return c; }; }
    function main() { const f = mk(); f(); f(); return f(); }`],                                       // 3
  ["two counters are independent", `
    function mk() { let c = 0; return () => { c = c + 1; return c; }; }
    function main() { const f = mk(), g = mk(); f(); f(); return f() + g(); }`],                        // 3 + 1 = 4
  ["nested capture three deep (re-capture outer env)", `
    function outer(a) { return (b) => (c) => a + b + c; }
    function main() { return outer(1)(2)(3); }`],                                                       // 6
  ["closure captures a loop accumulator", `
    function main() { let total = 0; const add = (x) => { total = total + x; return total; }; add(3); add(4); return add(10); }`], // 17
  ["per-iteration let: closures see their own i", `
    function main() {
      const fns = [];
      for (let i = 0; i < 3; i = i + 1) { fns.push(() => i); }
      let s = 0;
      for (let j = 0; j < 3; j = j + 1) { s = s + fns[j](); }
      return s;                                       // 0 + 1 + 2 = 3, not 3+3+3
    }`],
  ["higher-order over an array of closures", `
    function makeAdder(n) { return (x) => x + n; }
    function main() {
      const fns = [makeAdder(1), makeAdder(10), makeAdder(100)];
      let s = 0;
      for (let i = 0; i < 3; i = i + 1) { s = s + fns[i](5); }
      return s;                                       // 6 + 15 + 105 = 126
    }`],
  ["capture shared by sibling closures", `
    function mk() { let c = 10; const inc = () => { c = c + 1; return c; }; const get = () => c; inc(); return get(); }
    function main() { return mk(); }`],                                                                 // 11
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: [] });
  return rt.run({ id: "t" }, initialFrames("main", []), { deref: (x) => x }).value;
}
function native(src) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(compileModuleToWasm(src, { entry: "main", resources: [] })), { env: {} });
  new DataView(inst.exports.memory.buffer).setInt32(BUMP_ADDR, HEAP_BASE, true);
  return decodeValue(inst.exports.main());
}

const results = [];
for (const [name, src] of programs) {
  const i = interp(src), n = native(src);
  const ok = Object.is(i, n);
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: interpreter ${String(i)} == native ${String(n)}`);
}
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs capturing closures (env capture, LOADENV, higher-order calls) and matches the interpreter`);
process.exit(ok ? 0 : 1);

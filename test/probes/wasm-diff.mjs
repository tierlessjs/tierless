// Probe: the AOT compiler matches the interpreter (the differential oracle).
//
// Each program runs BOTH ways — interpreted (tsc.mjs + core.mjs) and compiled to
// native wasm (frontend.mjs + aot.mjs) — and the results must agree. This is the
// safety net for porting the interpreter to a compiler: every opcode added to the
// AOT path is checked against the proven interpreter, so coverage can grow fast
// without silently diverging. (Numeric subset for now; grows with the value model.)

import { createRuntime, Tier, initialFrames } from "#stackmix";
import { compileTsToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, tagInt, untagInt } from "#stackmix/wasm/aot.mjs";

const RES = 42;

const programs = [
  ["add + loop + resource", `
    declare const db: { query(): number };
    function add(a: number, b: number): number { return a + b; }
    function main(): number { let s = 0; for (let i = 0; i < 10; i = i + 1) { s = add(s, i); } return s + db.query(); }`],
  ["nested calls", `
    declare const db: { query(): number };
    function dbl(x: number): number { return x + x; }
    function main(): number { return dbl(dbl(3)) + db.query(); }`],
  ["conditional", `
    declare const db: { query(): number };
    function main(): number { let r = db.query(); if (r >= 40) { return r + r; } return 0; }`],
  ["nested loops", `
    declare const db: { query(): number };
    function main(): number { let s = 0; for (let i = 0; i < 4; i = i + 1) { for (let j = 0; j < 3; j = j + 1) { s = s + 1; } } return s + db.query(); }`],
  ["arrays: build (with a grow), index, length", `
    declare const db: { query(): number };
    function main(): number {
      const a = [];
      for (let i = 0; i < 5; i = i + 1) { a.push(i); }           // 5 pushes -> grows past INITCAP=4
      let s = 0;
      for (let j = 0; j < a.length; j = j + 1) { s = s + a[j]; } // 0+1+2+3+4 = 10
      return s + db.query();
    }`],
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: ["db.query"] });
  const tier = new Tier("t", { "db.query": () => RES });
  return rt.run(tier, initialFrames("main", []), { deref: () => { throw new Error("no deref"); } }).value;
}
function native(src) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(compileTsToWasm(src, { entry: "main" })), { env: { "db.query": () => tagInt(RES) } });
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
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler matches the interpreter (differential oracle)`);
process.exit(ok ? 0 : 1);

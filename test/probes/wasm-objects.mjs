// Probe: the AOT compiler runs string-keyed objects — and still matches the
// interpreter (the differential oracle, object edition).
//
// An object is a linear-memory property bag: a stable header [OBJTAG, count,
// backing] plus a backing store of (key, value) pairs, where each property key
// is interned to a small int at compile time so GETPROP/SETPROP are id matches.
// NEWOBJ allocates, SETPROP inserts-or-overwrites (growing the backing like an
// array), GETPROP returns the value or undefined. Each program runs interpreted
// (tsc.mjs + core.mjs) and compiled to native wasm (tsc.mjs + aot.mjs); the
// decoded native value must equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, decodeValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["literal + read two fields", `function main() { const p = { x: 3, y: 4 }; return p.x + p.y; }`],
  ["Object.assign merges sources into the target", `function main() { const t = Object.assign({ a: 1 }, { b: 2 }, { c: 3 }); return t.a + t.b + t.c; }`], // 6
  ["mutate a field", `function main() { const o = { n: 1 }; o.n = o.n + 10; return o.n; }`],
  ["object passed to a function", `
    function dist(p) { return p.x + p.y; }
    function main() { return dist({ x: 5, y: 6 }); }`],
  ["missing key is undefined", `function main() { const o = { a: 1 }; return o.b; }`],
  ["overwrite keeps one slot", `function main() { const o = { a: 1 }; o.a = 2; o.a = 3; return o.a; }`],
  ["grow past initial capacity", `function main() { const o = {}; o.a = 1; o.b = 2; o.c = 3; o.d = 4; o.e = 5; return o.a + o.b + o.c + o.d + o.e; }`],
  ["boolean-valued field + truthiness", `function main() { const o = { ok: 1 < 2 }; if (o.ok) { return 1; } return 0; }`],
  ["nested objects", `function main() { const o = { inner: { v: 7 } }; return o.inner.v; }`],
  ["object built across a loop, summed", `
    function main() {
      const acc = { total: 0 };
      for (let i = 1; i <= 4; i = i + 1) { acc.total = acc.total + i; }
      return acc.total;
    }`],
  ["field holds a result threaded through calls", `
    function mk(a, b) { return { lo: a, hi: b }; }
    function span(o) { return o.hi - o.lo; }
    function main() { return span(mk(3, 10)); }`],
  ["delete removes a key", `function main() { const o = { a: 1, b: 2, c: 3 }; delete o.b; return (o.a || 0) + (o.b ? 100 : 0) + (o.c || 0); }`], // 4
  ["delete returns true, even for a missing key", `function main() { const o = { x: 1 }; const r1 = delete o.x; const r2 = delete o.zzz; return (r1 ? 10 : 0) + (r2 ? 1 : 0) + (o.x ? 5 : 0); }`], // 11
  ["delete the middle, the rest survive", `function main() { const o = { a: 1, b: 2, c: 3, d: 4 }; delete o.a; delete o.c; return o.b * 100 + o.d; }`], // 204
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs string-keyed objects (NEWOBJ/GETPROP/SETPROP) and matches the interpreter`);
process.exit(ok ? 0 : 1);

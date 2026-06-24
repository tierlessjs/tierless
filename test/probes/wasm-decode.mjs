// Probe: readDeep fully materializes the native heap — and matches the interpreter.
// Most probes return scalars/strings because readValue leaves an aggregate opaque
// ({ptr}); readDeep instead walks the tagged heap (arrays, objects, Map/Set, nesting,
// identity/cycles) back into JS values, resolving object key ids through the module's
// exported __keystr (enabled by the `decode` compile flag). This is the host-side
// prototype of the in-module __serialize walk, and the gate for running the real
// corpora natively. Each program runs interpreted and compiled to native wasm; the
// deep-decoded native value must equal the interpreter's (compared structurally).

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue, readDeep, stdlibHost } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["an array of numbers", `function main() { return [1, 2, 3]; }`],
  ["a nested array", `function main() { return [1, [2, 3], [4, [5]]]; }`],
  ["an array of strings", `function main() { return ["alpha", "beta", "gamma"]; }`],
  ["an object", `function main() { return { a: 1, b: 2 }; }`],
  ["an object with an array and a nested object", `function main() { return { xs: [1, 2, 3], meta: { n: 3, ok: true } }; }`],
  ["an array of objects", `function main() { return [{ id: 1, t: "a" }, { id: 2, t: "b" }]; }`],
  ["mixed value types", `function main() { return { i: 1, f: 2.5, s: "x", b: false, z: null }; }`],
  ["an array built in a loop", `function main() { const a = []; for (let i = 0; i < 4; i++) { a.push(i * i); } return a; }`],
  ["an object built field by field", `function main() { const o = {}; o.a = 1; o.b = 2; o.c = 3; return o; }`],
  ["a class instance decodes to its data", `class P { constructor(x, y) { this.x = x; this.y = y; } sum() { return this.x + this.y; } } function main() { const p = new P(3, 4); p.sum(); return p; }`],
  ["a deeply nested mix", `function main() { return { a: [1, { b: [2, 3] }], c: { d: { e: 5 } }, fs: ["p", "q"] }; }`],
  ["a returned bigint inside an array", `function main() { return [1n, 2n + 3n]; }`],
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: [] });
  return rt.run({ id: "t" }, initialFrames("main", []), { deref: (x) => x }).value;
}
function native(src) {
  const sh = stdlibHost();
  const inst = new WebAssembly.Instance(new WebAssembly.Module(compileModuleToWasm(src, { entry: "main", resources: [], decode: true })), { env: sh.imports });
  sh.bind(inst);
  new DataView(inst.exports.memory.buffer).setInt32(BUMP_ADDR, HEAP_BASE, true);
  const memory = inst.exports.memory;
  const keystr = inst.exports.__keystr ? (id) => { const p = inst.exports.__keystr(id); return p ? readValue(memory, p) : null; } : null;
  return readDeep(memory, inst.exports.main(), keystr);
}

const J = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? "B:" + v.toString() : v));
const results = [];
for (const [name, src] of programs) {
  const i = interp(src), n = native(src);
  const ok = J(i) === J(n);
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: interpreter ${J(i)} == native ${J(n)}`);
}
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — readDeep materializes the native heap (arrays/objects/nesting) and matches the interpreter`);
process.exit(ok ? 0 : 1);

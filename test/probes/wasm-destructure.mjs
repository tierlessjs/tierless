// Probe: the AOT compiler runs array destructuring and object spread — and
// matches the interpreter. Array destructuring lowers to TOARRAY (materialize an
// iterable; identity for an array, chars for a string, drain for a generator)
// then indexed reads; object spread {...src} lowers to ASSIGNALL (copy src's own
// key/value pairs into the target). Each program runs interpreted and compiled to
// native wasm; the decoded native value must equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["array destructuring", `function main() { const [a, b, c] = [10, 20, 30]; return a + b + c; }`],                 // 60
  ["destructuring with a hole", `function main() { const [x, , z] = [1, 2, 3]; return x * 10 + z; }`],               // 13
  ["destructuring a string into chars", `function main() { const [a, b] = "hi"; return a + b; }`],                   // "hi"
  ["destructuring parameters", `function f([a, b]) { return a + b; } function main() { return f([3, 4]); }`],         // 7
  ["destructuring the result of a map", `function main() { const [p, q] = [1, 2, 3].map((x) => x * 10); return p + q; }`], // 30
  ["object spread copies fields", `function main() { const base = { a: 1, b: 2 }; const o = { ...base, c: 3 }; return o.a + o.b + o.c; }`], // 6
  ["object spread, later wins", `function main() { const base = { a: 1, b: 2 }; const o = { ...base, b: 20 }; return o.a + o.b; }`], // 21
  ["two spreads merge", `function main() { const a = { x: 1 }; const b = { y: 2 }; const m = { ...a, ...b, z: 3 }; return m.x + m.y + m.z; }`], // 6
  ["spread an object then mutate", `function main() { const base = { n: 5 }; const o = { ...base }; o.n = 9; return base.n * 10 + o.n; }`], // 59
  ["spread, array, and call together", `function add3(a, b, c) { return a + b + c; } function main() { const xs = [10, 20]; const arr = [0, ...xs, 3]; const obj = { p: 1 }; const o2 = { ...obj, q: 2 }; return arr.length * 1000 + o2.p + o2.q + add3(...xs, 30); }`], // 4000 + 1 + 2 + 60 = 4063
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs array destructuring and object spread and matches the interpreter`);
process.exit(ok ? 0 : 1);

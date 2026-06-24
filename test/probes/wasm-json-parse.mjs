// Probe: the AOT compiler runs JSON.parse — and matches the interpreter. Parsing is
// delegated to the host's own JSON.parse (stdlibHost): the compiled module imports
// __json_parse, which reads the source string out of linear memory, runs the real
// JSON.parse, and then rebuilds the value tree IN the heap by calling the runtime's
// OWN exported constructors (__newobj/__setprop/__keyid/__newarr/__arrpush) — so the
// host needs no knowledge of the heap layout, and semantics are exactly ECMAScript's.
// Object keys go through the same interner as static property access, so reading a
// known key resolves to the same id; a key seen only at runtime is recovered for
// Object.keys / for-in / re-stringify from the interner's pool. Numbers normalize
// like every other number (whole & in range -> fixnum, else a boxed double). Each
// program runs interpreted and compiled to native wasm; the decoded value must match.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue, stdlibHost } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["an object, read a known key", `function main() { return JSON.parse('{"x":42}').x; }`],                       // 42
  ["an array, read by index", `function main() { return JSON.parse('[10,20,30]')[1]; }`],                        // 20
  ["a nested object", `function main() { const o = JSON.parse('{"a":{"b":7}}'); return o.a.b; }`],               // 7
  ["a fractional number is a float", `function main() { return JSON.parse('{"f":3.5}').f; }`],                    // 3.5
  ["a string value concatenates", `function main() { return JSON.parse('{"s":"hi"}').s + "!"; }`],               // "hi!"
  ["array length", `function main() { return JSON.parse('[1,2,3,4]').length; }`],                                 // 4
  ["a boolean value", `function main() { return JSON.parse('{"ok":true}').ok ? "Y" : "N"; }`],                    // "Y"
  ["a null value", `function main() { return JSON.parse('{"v":null}').v === null ? "null" : "no"; }`],            // "null"
  ["negative and out-of-fixnum-range numbers", `function main() { const o = JSON.parse('{"n":-5,"big":2000000000}'); return o.n + "/" + o.big; }`], // "-5/2000000000"
  ["a float compares equal by value", `function main() { return JSON.parse('{"f":1.5}').f === 1.5 ? 1 : 0; }`],   // 1
  ["an array of objects, reach inside", `function main() { const a = JSON.parse('[{"v":1},{"v":2}]'); return a[0].v + a[1].v; }`], // 3
  ["sum a parsed numeric array", `function main() { const a = JSON.parse('[3,4,5]'); let s = 0; for (const x of a) { s += x; } return s; }`], // 12
  ["typeof a parsed object is object", `function main() { return typeof JSON.parse('{"a":1}'); }`],               // "object"
  ["Object.keys of a parsed object (runtime keys)", `function main() { return Object.keys(JSON.parse('{"a":1,"b":2,"c":3}')).join(","); }`], // "a,b,c"
  ["for-in over a parsed object", `function main() { const o = JSON.parse('{"x":1,"y":2}'); let s = ""; for (const k in o) { s += k; } return s; }`], // "xy"
  ["re-stringify a parsed object", `function main() { return JSON.stringify(JSON.parse('{"a":1,"b":2}')); }`],    // '{"a":1,"b":2}'
  ["the canonical round-trip then read", `function main() { const o = { a: [1, { b: 2 }], c: "z" }; const r = JSON.parse(JSON.stringify(o)); return r.a[1].b + r.c; }`], // "2z"
  ["parse a top-level array of strings and join", `function main() { return JSON.parse('["a","b","c"]').join("-"); }`], // "a-b-c"
  ["mixed types in one object", `function main() { const o = JSON.parse('{"i":1,"f":2.5,"s":"x","b":false}'); return o.i + "/" + o.f + "/" + o.s + "/" + o.b; }`], // "1/2.5/x/false"
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: [] });
  return rt.run({ id: "t" }, initialFrames("main", []), { deref: (x) => x }).value;
}
function native(src) {
  const sh = stdlibHost(); // JSON.parse is delegated to the host; bind it to the instance after instantiation
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs JSON.parse (objects/arrays/nesting/types, runtime keys) and matches the interpreter`);
process.exit(ok ? 0 : 1);

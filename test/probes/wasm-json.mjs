// Probe: the AOT compiler runs JSON.stringify — and matches the interpreter.
// JSONSTR recursively serializes the tagged value model: numbers, quoted and
// backslash-escaped strings, booleans, null, arrays, and objects. Objects emit
// only enumerable keys (via the same __keystr reverse table KEYS uses), so a
// class instance's hidden methods, __class__, and __accessors__ are dropped —
// matching JS, which also omits functions. Each program runs interpreted and
// compiled to native wasm; the decoded native string must equal the
// interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["a number", `function main() { return JSON.stringify(42); }`],                                          // "42"
  ["a negative number", `function main() { return JSON.stringify(-7); }`],                                  // "-7"
  ["a string is quoted", `function main() { return JSON.stringify("hi"); }`],                               // "\"hi\""
  ["booleans and null", `function main() { return JSON.stringify(true) + JSON.stringify(false) + JSON.stringify(null); }`], // "truefalsenull"
  ["an array of numbers", `function main() { return JSON.stringify([1, 2, 3]); }`],                          // "[1,2,3]"
  ["an object", `function main() { return JSON.stringify({ a: 1, b: 2 }); }`],                              // '{"a":1,"b":2}'
  ["mixed object with a nested array", `function main() { return JSON.stringify({ name: "ann", age: 30, tags: ["x", "y"] }); }`],
  ["an array of objects", `function main() { return JSON.stringify([{ a: 1 }, { b: 2 }]); }`],               // '[{"a":1},{"b":2}]'
  ["a string with characters needing escapes", `function main() { return JSON.stringify({ s: "a\\"b\\\\c" }); }`],
  ["deeply nested", `function main() { return JSON.stringify({ nested: { deep: { v: 5 } }, arr: [1, [2, 3]] }); }`],
  ["a class instance serializes data only", `
    class Account { constructor(o, b) { this.owner = o; this.balance = b; } get summary() { return this.owner; } deposit(n) { this.balance += n; } }
    function main() { const a = new Account("ann", 100); a.deposit(50); return JSON.stringify(a); }`], // '{"owner":"ann","balance":150}'
  ["round-trip shape (keys + json agree)", `
    function main() {
      const o = { id: 7, label: "row", ok: true };
      return JSON.stringify(o) + "|" + Object.keys(o).join(",");
    }`],
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs JSON.stringify and matches the interpreter`);
process.exit(ok ? 0 : 1);

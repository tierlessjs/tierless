// Probe: the AOT compiler runs for-in and Object.keys — and matches the
// interpreter. Object keys are interned ids, so KEYS maps each id back to its
// string via a compile-time reverse table that covers only enumerable keys —
// those never set via SETHIDDEN — so a class's hidden methods, __class__, and
// __accessors__ don't enumerate, while an object literal's own data and methods
// do (matching JS own-enumerable semantics). for-in is KEYS + indexed iteration.
// Each program runs interpreted and compiled to native wasm; the decoded native
// value must equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["for-in concatenates keys in insertion order", `function main() { const o = { x: 1, y: 2, z: 3 }; let s = ""; for (const k in o) { s += k; } return s; }`], // "xyz"
  ["for-in sums values by computed access", `function main() { const o = { a: 10, b: 20, c: 30 }; let s = 0; for (const k in o) { s += o[k]; } return s; }`], // 60
  ["Object.keys length", `function main() { const o = { a: 1, b: 2, c: 3, d: 4 }; return Object.keys(o).length; }`], // 4
  ["Object.keys joined", `function main() { const o = { first: 1, second: 2, third: 3 }; return Object.keys(o).join(","); }`], // "first,second,third"
  ["keys after grow past capacity", `function main() { const o = {}; o.a = 1; o.b = 2; o.c = 3; o.d = 4; o.e = 5; return Object.keys(o).join(""); }`], // "abcde"
  ["keys after a delete", `function main() { const o = { a: 1, b: 2, c: 3 }; delete o.b; return Object.keys(o).join(","); }`], // "a,c"
  ["a class instance enumerates data, not methods", `
    class Account { constructor(o, b) { this.owner = o; this.balance = b; } deposit(n) { this.balance += n; return this.balance; } }
    function main() { const a = new Account("ann", 100); a.deposit(50); const keys = []; for (const k in a) { keys.push(k); } return keys.join("|") + ":" + a.balance; }`], // "owner|balance:150"
  ["an object literal enumerates data and methods (accessor filtered)", `
    function main() {
      const o = { _v: 1, label: 2, get v() { return this._v; }, dbl() { return this._v * 2; } };
      return Object.keys(o).filter((k) => k !== "v").join(",");
    }`], // "_v,label,dbl"
  ["keys mapped to a derived object", `function main() { const src = { a: 1, b: 2, c: 3 }; const out = {}; for (const k in src) { out[k] = src[k] * 10; } return out.a + out.b + out.c; }`], // 60
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs for-in and Object.keys and matches the interpreter`);
process.exit(ok ? 0 : 1);

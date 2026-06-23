// Probe: the AOT value model — undefined, null, and booleans, not just numbers.
//
// The tagged value model now has four primitive singletons (undefined/null/
// false/true) distinct from the fixnum 0, comparisons produce real booleans
// (not 0/1), and control flow uses JS truthiness (0, null, undefined, false are
// falsy). Each program runs interpreted (tsc.mjs + core.mjs) and compiled to
// native wasm (tsc.mjs + aot.mjs); the decoded native value must equal the
// interpreter's value — so a returned boolean is `true`, not `1`, and a missing
// value is `undefined`, not `0`.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, decodeValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["less-than is true", `function main() { return 3 < 5; }`],
  ["less-than is false", `function main() { return 10 < 5; }`],
  ["strict-eq numbers", `function main() { return 2 === 2; }`],
  ["strict-neq numbers", `function main() { return 2 === 3; }`],
  ["return null", `function main() { return null; }`],
  ["uninitialized let is undefined", `function main() { let x; return x; }`],
  ["null === null", `function main() { return null === null; }`],
  ["null === undefined is false", `function main() { let u; return null === u; }`],
  ["boolean === boolean", `function main() { return (1 < 2) === true; }`],
  ["number !== boolean", `function main() { return 1 === true; }`],          // JS: false (distinct tags)
  ["0 is falsy", `function main() { if (0) { return 100; } return 2; }`],
  ["null is falsy", `function main() { if (null) { return 100; } return 2; }`],
  ["undefined is falsy", `function main() { let u; if (u) { return 100; } return 2; }`],
  ["nonzero is truthy", `function main() { if (5) { return 1; } return 2; }`],
  ["false is falsy", `function main() { if (3 > 5) { return 100; } return 2; }`],
  ["negative is truthy", `function main() { if (0 - 3) { return 1; } return 2; }`],
  ["boolean threaded through a call", `
    function not(b) { if (b) { return false; } return true; }
    function main() { return not(2 < 1); }`],                                // not(false) = true
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT value model (undefined/null/booleans + JS truthiness) matches the interpreter`);
process.exit(ok ? 0 : 1);

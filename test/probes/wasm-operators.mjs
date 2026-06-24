// Probe: the AOT compiler runs the unary and bitwise operators — and matches the
// interpreter. ++/-- (INC/DEC), ! (NOT), ~ (BITNOT), unary - (NEG), and the
// bitwise/shift/mod binary ops, all on the low-bit-tagged integer model (tagged
// ints distribute over & | ^ and signed %; shifts untag the amount and re-tag;
// ~(2n) = -2 - 2n). Each program runs interpreted and compiled to native wasm;
// the decoded native value must equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["postfix ++ returns the old value, prefix the new", `function main() { let i = 5; const a = i++; const b = ++i; return a + b + i; }`], // 5+7+7 = 19
  ["postfix -- ", `function main() { let i = 5; const a = i--; return a * 10 + i; }`],            // 5*10 + 4 = 54
  ["++ drives a for loop", `function main() { let s = 0; for (let i = 0; i < 5; i++) { s = s + i; } return s; }`], // 10
  ["! on falsy and truthy", `function main() { return (!0 === true) === (!5 === false); }`],      // true
  ["! guards a branch", `function main() { const x = 0; if (!x) { return 1; } return 2; }`],       // 1
  ["~ (bitwise not)", `function main() { return ~5; }`],                                          // -6
  ["unary minus", `function main() { let x = 7; return -x; }`],                                   // -7
  ["& | ^ together", `function main() { return (5 & 3) | (8 ^ 1); }`],                            // 1 | 9 = 9
  ["shifts", `function main() { return (1 << 4) + (255 >> 2); }`],                                // 16 + 63 = 79
  ["unsigned shift", `function main() { return 256 >>> 2; }`],                                    // 64
  ["modulo, including negative", `function main() { return (17 % 5) * 10 + (0 - 7) % 3; }`],       // 2*10 + (-1) = 19
  ["masking with ~", `function main() { return 13 & ~1; }`],                                      // 12
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs the unary and bitwise operators and matches the interpreter`);
process.exit(ok ? 0 : 1);

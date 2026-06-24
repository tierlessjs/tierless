// Probe: the AOT compiler runs BigInt — and matches the interpreter. A bigint is
// [BIGTAG, nlimbs, ...limbs], a non-negative arbitrary-precision magnitude in
// base-2^32 (the realts surface is non-negative). Literals build limbs at compile
// time; +, *, /, % (one-limb divisor), ** (square-and-multiply), <<, & | ^, and
// compare run as limb loops with i64 intermediates; toString does base-10 via
// repeated divmod by 1e9; typeof is "bigint"; === is by value and == coerces a
// number. Each program runs interpreted and compiled to native wasm; the decoded
// native value must equal the interpreter's (results are strings/booleans the
// decoder reads, or a returned bigint decoded back).

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["a literal round-trips through toString", `function main() { return (7n).toString(); }`],            // "7"
  ["addition", `function main() { return (7n + 2n).toString(); }`],                                      // "9"
  ["a literal beyond 2^53", `function main() { return (9007199254740993n + 1n).toString(); }`],          // "9007199254740994"
  ["multiplication", `function main() { return (123456789n * 987654321n).toString(); }`],                // "121932631112635269"
  ["division truncates toward zero", `function main() { return (7n / 2n).toString(); }`],                 // "3"
  ["modulo", `function main() { return (10n % 3n).toString(); }`],                                        // "1"
  ["exponent by squaring", `function main() { return (2n ** 64n).toString(); }`],                         // "18446744073709551616"
  ["a big power", `function main() { return (3n ** 40n).toString(); }`],                                  // "12157665459056928801"
  ["bitwise and / or / shift", `function main() { return ((255n & 0x0fn) | (1n << 8n)).toString(); }`],   // "271"
  ["xor", `function main() { return (12n ^ 10n).toString(); }`],                                          // "6"
  ["typeof a bigint literal", `function main() { return typeof 5n; }`],                                   // "bigint"
  ["BigInt() of a number, then typeof", `function main() { return typeof BigInt(42); }`],                 // "bigint"
  ["BigInt() participates in arithmetic", `function main() { return (BigInt(42) + 8n).toString(); }`],     // "50"
  ["strict compares stay within type", `function main() { return (2n === 2n) === (1n !== 2n); }`],         // true
  ["strict bigint vs number is false", `function main() { return 1n === 1; }`],                            // false
  ["loose bigint vs number coerces", `function main() { return (1n == 1) === (2n == 2); }`],               // true
  ["ordering", `function main() { return (3n < 5n ? 1 : 0) + (5n >= 5n ? 10 : 0); }`],                     // 11
  ["increment in a loop (factorial)", `function main() { let p = 1n; for (let i = 1n; i <= 25n; i++) { p *= i; } return p.toString(); }`], // 25!
  ["a returned bigint decodes back", `function main() { return 12345678901234567890n + 1n; }`],           // 12345678901234567891n
  ["sum of a big and small literal as a value", `function main() { return 2n ** 100n; }`],                // 1267650600228229401496703205376n
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
  const show = (x) => typeof x === "bigint" ? x.toString() + "n" : JSON.stringify(x);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: interpreter ${show(i)} == native ${show(n)}`);
}
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs BigInt (arbitrary-precision +,*,/,%,**,bitwise,compare,toString) and matches the interpreter`);
process.exit(ok ? 0 : 1);

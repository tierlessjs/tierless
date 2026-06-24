// Probe: the AOT compiler runs BigInt — and matches the interpreter. Arithmetic is
// delegated to the host's native BigInt (stdlibHost): a bigint cell is just
// [BIGTAG, sign, nlimbs, ...limbs] in linear memory, and the compiled module imports
// __big_bin/__big_cmp/__big_eq/__big_str/__big_from, which read the operands out of
// memory, run the real operation, and write the result back. So semantics are exactly
// ECMAScript's — including negatives, subtraction, and true multi-limb division, none
// of which the old hand-rolled limb runtime supported. Literals build limbs at
// compile time; typeof is "bigint" (a tag check, no engine). Each program runs
// interpreted and compiled to native wasm; the decoded native value must equal the
// interpreter's (a string/boolean the decoder reads, or a returned bigint decoded back).

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue, stdlibHost } from "#stackmix/wasm/aot.mjs";

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
  // Negatives, subtraction, and general division — beyond the old in-module runtime,
  // now correct because the host's own BigInt does the work.
  ["subtraction can go negative", `function main() { return (2n - 9n).toString(); }`],                     // "-7"
  ["unary minus on a bigint", `function main() { return (-5n).toString(); }`],                             // "-5"
  ["a negative bigint round-trips as a value", `function main() { return 3n - 10n; }`],                    // -7n
  ["multi-limb division (not one-limb)", `function main() { return (123456789012345678901234567890n / 1000000007n).toString(); }`], // "123456788148148161864"
  ["modulo with a negative result", `function main() { return ((-7n) % 3n).toString(); }`],                // "-1"
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: [] });
  return rt.run({ id: "t" }, initialFrames("main", []), { deref: (x) => x }).value;
}
function native(src) {
  const sh = stdlibHost(); // BigInt is delegated to the host; bind it to the instance after instantiation
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
  const show = (x) => typeof x === "bigint" ? x.toString() + "n" : JSON.stringify(x);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: interpreter ${show(i)} == native ${show(n)}`);
}
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs BigInt (arbitrary-precision +,*,/,%,**,bitwise,compare,toString) and matches the interpreter`);
process.exit(ok ? 0 : 1);

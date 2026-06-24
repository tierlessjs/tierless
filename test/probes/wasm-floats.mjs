// Probe: the AOT compiler runs floating-point — and matches the interpreter.
// Numbers are tagged ints on the fast path; a non-integer literal, a division, or
// a string coerced through arithmetic produces an f64 that is computed and then
// normalized — a whole value in tagged-int range collapses back to a fixnum so
// === and downstream integer/bitwise ops keep working, otherwise it is boxed
// [FLOATTAG, f64]. Covers literals, +-*/ , comparisons, unary +/- coercion
// (`+"3.14"` / `-"-2"`), Math.floor/ceil/round/trunc/abs, Number.isInteger, and
// mixed int/float. Turning a boxed double back into text (concat / toString / join)
// is delegated to the host's own Number->string (shortest-round-trip and exponent
// rules — an engine, not hand-rolled). Each program runs interpreted and compiled to
// native wasm; the decoded native value must equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue, stdlibHost } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["a float literal round-trips", `function main() { return 3.14; }`],                                   // 3.14
  ["float addition staying fractional", `function main() { return 1.5 + 2.0; }`],                         // 3.5
  ["a float sum that lands whole becomes an int", `function main() { return 1.5 + 2.5; }`],               // 4
  ["division is float-shaped", `function main() { return 7 / 2; }`],                                       // 3.5
  ["exact division collapses to an int", `function main() { return 6 / 2; }`],                             // 3
  ["multiply a float by an int", `function main() { return 3.14 * 2; }`],                                  // 6.28
  ["float subtraction", `function main() { return 5.5 - 2.25; }`],                                         // 3.25
  ["unary minus on a float", `function main() { return -3.5; }`],                                          // -3.5
  ["unary plus coerces a numeric string to an int", `function main() { return +"5"; }`],                   // 5
  ["unary plus coerces to a float", `function main() { return +"3.14"; }`],                                // 3.14
  ["unary minus coerces a string", `function main() { return -"-2"; }`],                                   // 2
  ["Math.floor / ceil of floats", `function main() { return Math.floor(2.9) * 10 + Math.ceil(2.1); }`],    // 23
  ["Math.round is round-half-up", `function main() { return Math.round(2.5) * 10 + Math.round(-2.5); }`],  // 30 - 2 = 28
  ["Math.abs of a float", `function main() { return Math.abs(-3.5) + Math.abs(3.5); }`],                   // 7
  ["floor of a division (integer division idiom)", `function main() { return Math.floor(17 / 5); }`],      // 3
  ["float equality by value", `function main() { return (3.14 === 3.14) === (1.5 !== 2.5); }`],            // true
  ["float comparison", `function main() { return (3.14 < 3.15 ? 1 : 0) + (2.5 >= 2.5 ? 10 : 0); }`],       // 11
  ["Number.isInteger discriminates", `function main() { return (Number.isInteger(5.5) ? 1 : 0) * 10 + (Number.isInteger(6 / 2) ? 1 : 0); }`], // 0*10 + 1 = 1
  ["typeof a float is number", `function main() { return typeof 3.14 === "number" ? 1 : 0; }`],            // 1
  ["a float accumulator in a loop", `function main() { let x = 0.0; for (let i = 0; i < 5; i++) { x = x + 0.5; } return x; }`], // 2.5
  ["averaging produces a float", `function main() { const a = [1, 2, 4]; let s = 0; for (const x of a) { s += x; } return s / a.length; }`], // 7/3 = 2.333…
  ["mixed: int math then a float step", `function main() { let n = 10; n = n * 3; return n / 4; }`],       // 30/4 = 7.5
  // A boxed double turned into text is delegated to the host's Number->string (the
  // shortest-round-trip / exponent rules are an engine of their own — not hand-rolled).
  ["a float concatenates into a string", `function main() { return "pi=" + 3.14; }`],                      // "pi=3.14"
  ["toString of a float", `function main() { return (7 / 2).toString(); }`],                               // "3.5"
  ["a float joins inside an array", `function main() { return [1.5, 2.25, 3].join(","); }`],               // "1.5,2.25,3"
  ["rounding error shows the real digits", `function main() { return "" + (0.1 + 0.2); }`],                 // "0.30000000000000004"
  ["a tiny float uses exponent notation", `function main() { return "" + (1 / 8 / 1000000); }`],            // "1.25e-7"
  // ** on numbers is Math.pow on the host, boxed back into the model (whole & in range -> fixnum).
  ["integer exponent", `function main() { return 2 ** 10; }`],                                               // 1024
  ["a fractional exponent (square root)", `function main() { return 2 ** 0.5; }`],                            // 1.4142135623730951
  ["a fractional base", `function main() { return 1.5 ** 2; }`],                                              // 2.25
  ["a negative exponent", `function main() { return 10 ** -1; }`],                                            // 0.1
  ["a power past the fixnum range stays a number", `function main() { return 2 ** 53; }`],                    // 9007199254740992
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: [] });
  return rt.run({ id: "t" }, initialFrames("main", []), { deref: (x) => x }).value;
}
function native(src) {
  const sh = stdlibHost(); // Number->string is delegated to the host; bind it to the instance after instantiation
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs floating-point (literals, arithmetic, division, coercion, Math) and matches the interpreter`);
process.exit(ok ? 0 : 1);

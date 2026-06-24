// Probe: the AOT compiler runs the scalar host stdlib and array spread — and
// matches the interpreter. Math (abs/floor/ceil/round/sign/max/min), Number
// (isInteger/isFinite/isNaN), Array.isArray, the array higher-order methods
// (map/filter/reduce/find/some/every — inlined by the frontend, gated on an
// ISARRAY check), array/string `.length`, spread ([...a], f(...a),
// Math.max(...a)), and the `arguments` object + rest parameters. The HOFs and
// `arguments` both ride the uniform indirect-call arity: a callback declared
// `x => ...` is invoked with (value, index), extras ignored; `arguments` and a
// rest param recover the real passed-arg count published at each call site.
// Each program runs interpreted and compiled to native wasm; the decoded native
// value must equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["Math.abs / floor / max / min", `function main() { return Math.abs(-7) + Math.floor(3) + Math.max(3, 1, 4) + Math.min(9, 2, 5); }`], // 7+3+4+2 = 16
  ["Math.sign", `function main() { return Math.sign(-9) * 100 + Math.sign(0) * 10 + Math.sign(42); }`],                                    // -100 + 0 + 1 = -99
  ["Math.max/min over many args", `function main() { return Math.max(1, 9, 2, 8, 3, 7) - Math.min(5, 4, 6, 2, 9); }`],                     // 9 - 2 = 7
  ["Array.isArray on an array and a non-array", `function main() { return (Array.isArray([1, 2]) ? 1 : 0) * 10 + (Array.isArray(5) ? 1 : 0); }`], // 10
  ["Number.isInteger / isNaN / isFinite", `function main() { return (Number.isInteger(5) ? 1 : 0) + (Number.isNaN(5) ? 10 : 0) + (Number.isFinite(9) ? 100 : 0); }`], // 1 + 0 + 100 = 101
  ["array .length", `function main() { const a = [3, 1, 4, 1, 5]; return a.length; }`],                                                     // 5
  ["string .length", `function main() { const s = "hello"; return s.length; }`],                                                            // 5
  ["map then reduce (callback ignores the index)", `function main() { const a = [1, 2, 3, 4]; return a.map((x) => x * 2).reduce((s, x) => s + x, 0); }`], // 2+4+6+8 = 20
  ["filter by parity", `function main() { const a = [1, 2, 3, 4, 5, 6]; return a.filter((x) => x % 2 === 0).length; }`],                     // 3
  ["map with the index arg", `function main() { const a = [10, 20, 30]; return a.map((x, i) => x + i).reduce((s, x) => s + x, 0); }`],       // 10+21+32 = 63
  ["find / findIndex", `function main() { const a = [5, 8, 13, 21]; return a.find((x) => x > 10) * 100 + a.findIndex((x) => x > 10); }`],     // 13*100 + 2 = 1302
  ["some / every", `function main() { const a = [2, 4, 6]; return (a.every((x) => x % 2 === 0) ? 1 : 0) * 10 + (a.some((x) => x > 5) ? 1 : 0); }`], // 11
  ["forEach accumulates via a closure", `function main() { const a = [1, 2, 3, 4]; let s = 0; a.forEach((x) => { s = s + x; }); return s; }`], // 10
  ["array spread literal", `function main() { const a = [1, 2, 3]; const b = [0, ...a, 4]; return b.length * 100 + b[0] + b[4]; }`],          // 5*100 + 0 + 4 = 504
  ["spread into the middle", `function main() { const a = [2, 3]; const b = [1, ...a, 4, ...a]; return b.reduce((s, x) => s + x, 0); }`],     // 1+2+3+4+2+3 = 15
  ["Math.max with spread", `function main() { const a = [3, 1, 4, 1, 5, 9, 2, 6]; return Math.max(...a) * 10 + Math.min(...a); }`],          // 9*10 + 1 = 91
  ["spread a computed array into a call", `function main() { function add3(a, b, c) { return a + b + c; } const xs = [10, 20, 30]; return add3(...xs); }`], // 60
  ["chained HOFs", `function main() { const a = [1, 2, 3, 4, 5, 6, 7, 8]; return a.filter((x) => x % 2 === 0).map((x) => x * x).reduce((s, x) => s + x, 0); }`], // 4+16+36+64 = 120
  ["arguments: length and index", `function variadic() { let s = 0; for (let i = 0; i < arguments.length; i++) { s += arguments[i]; } return s; } function main() { return variadic(1, 2, 3, 4); }`], // 10
  ["arguments captured by a nested arrow", `function viaArrow() { return (() => arguments[0] + arguments[1])(); } function main() { return viaArrow(10, 20); }`], // 30
  ["arguments forwarded through an implicit constructor", `class A { constructor(n) { this.n = n; } } class B extends A {} class C extends B { c = this.n + 1; } function main() { return new C(3).n * 100 + new C(3).c; }`], // 304
  ["rest parameter collects the tail", `function sum(first, ...rest) { let s = first; for (let i = 0; i < rest.length; i++) { s += rest[i]; } return s; } function main() { return sum(1, 2, 3, 4) * 10 + sum(7); }`], // 10*10 + 7 = 107
  ["rest gathers a spread call", `function f(a, b, ...rest) { return a + b + rest.length; } function main() { const more = [4, 5]; return f(1, 2, ...more, 6); }`], // 1+2+3 = 6
  ["only a rest parameter", `function tail(...xs) { return xs.length; } function main() { return tail() * 100 + tail(1, 2, 3); }`], // 0*100 + 3 = 3
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs the scalar host stdlib, array HOFs, .length and spread, and matches the interpreter`);
process.exit(ok ? 0 : 1);

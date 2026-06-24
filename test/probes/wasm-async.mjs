// Probe: the AOT compiler runs async/await — and still matches the interpreter.
//
// In Stackmix, await is a suspension point, but a plain value resolves to itself
// (no host round-trip), so async between user functions is synchronous: an async
// function is an ordinary function, and AWAIT is identity — the value stays on
// the operand stack. (A genuine async value would suspend like a resource, and a
// rejected promise would throw — both later slices that need the host stdlib and
// exceptions.) Each program runs interpreted (tsc.mjs + core.mjs) and compiled to
// native wasm; the decoded native value must equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue, stdlibHost } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["await a user async function", `
    async function dbl(x) { return x * 2; }
    async function main() { const a = await dbl(5); const b = await dbl(a); return a + b; }`],   // 10 + 20 = 30
  ["await inside an expression", `
    async function f(x) { return x + 1; }
    async function main() { return (await f(7)) + (await f(7)); }`],                              // 8 + 8 = 16
  ["await flowing a string", `
    async function name() { return "ann"; }
    async function main() { return "hi " + (await name()); }`],                                   // "hi ann"
  ["await chained through async helpers", `
    async function inc(x) { return x + 1; }
    async function twice(x) { return await inc(await inc(x)); }
    async function main() { return await twice(10); }`],                                          // 12
  ["await in a loop accumulates", `
    async function add(a, b) { return a + b; }
    async function main() { let s = 0; for (let i = 1; i <= 4; i = i + 1) { s = await add(s, i); } return s; }`], // 1+2+3+4 = 10
  ["await a boolean condition", `
    async function ready() { return 1 < 2; }
    async function main() { if (await ready()) { return "go"; } return "stop"; }`],               // "go"
  ["async generator consumed by for-await", `
    async function* g() { yield 1; yield 2; yield 3; }
    async function main() { let s = 0; for await (const x of g()) { s = s + x; } return s; }`],   // 6
  ["async generator that awaits in its body", `
    async function dbl(x) { return x * 2; }
    async function* g() { yield await dbl(5); yield await dbl(10); }
    async function main() { let s = 0; for await (const x of g()) { s = s + x; } return s; }`],   // 10 + 20 = 30
  ["async range generator", `
    async function* range(a, b) { for (let i = a; i < b; i = i + 1) { yield i; } }
    async function main() { let s = 0; for await (const x of range(1, 5)) { s = s + x; } return s; }`], // 1+2+3+4 = 10
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: [] });
  return rt.run({ id: "t" }, initialFrames("main", []), { deref: (x) => x }).value;
}
function native(src) {
  const sh = stdlibHost(); // the delegated stdlib (Number->string, regex, BigInt) is provided by the host
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs async/await and async generators (synchronous resolution between user functions) and matches the interpreter`);
process.exit(ok ? 0 : 1);

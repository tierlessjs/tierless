// Probe: the AOT compiler runs strings — literals, concatenation (with number
// coercion), and value equality — and still matches the interpreter.
//
// A string is a heap object [STRTAG, byteLength, ...bytes]. String literals are
// built inline; "+" is polymorphic (a numeric fast path when both operands are
// fixnums, else __add concatenates, coercing a number via __numstr); and "===" /
// "!==" compare strings BY VALUE (__eq walks the bytes), so two separately built
// equal strings are ===, not just identical pointers. Each program runs
// interpreted (tsc.mjs + core.mjs) and compiled to native wasm; the decoded
// native value (a real JS string, read back from the heap) must equal the
// interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["string literal", `function main() { return "hello"; }`],
  ["concat two literals", `function main() { return "ab" + "cd"; }`],
  ["concat chain", `function main() { return "a" + "b" + "c" + "d"; }`],
  ["coerce a number on the right", `function main() { return "n=" + 5; }`],
  ["coerce a number on the left", `function main() { return 42 + "!"; }`],
  ["coerce a negative number", `function main() { return "t=" + (0 - 42); }`],
  ["coerce zero", `function main() { return "z" + 0; }`],
  ["coerce a multi-digit number", `function main() { return "#" + 12345; }`],
  ["equal strings are === by value", `function main() { const a = "x" + "y"; const b = "xy"; return a === b; }`],
  ["unequal strings", `function main() { return "ab" === "ac"; }`],
  ["different lengths are not equal", `function main() { return "ab" === "abc"; }`],
  ["!== on strings", `function main() { return "a" !== "b"; }`],
  ["string through a function", `
    function greet(name) { return "hi " + name; }
    function main() { return greet("ann"); }`],
  ["pick a branch by string equality", `
    function main() {
      const s = "f" + "oo";
      if (s === "foo") { return "matched"; }
      return "no";
    }`],
  ["build a label across a loop", `
    function main() {
      let s = "";
      for (let i = 0; i < 3; i = i + 1) { s = s + i; }
      return s;                                  // "012"
    }`],
  ["count then summarize", `
    function main() {
      let n = 0;
      for (let i = 0; i < 5; i = i + 1) { n = n + i; }
      return "sum=" + n;                         // "sum=10"
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs strings (literals, concat with coercion, value equality) and matches the interpreter`);
process.exit(ok ? 0 : 1);

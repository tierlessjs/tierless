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
import { BUMP_ADDR, HEAP_BASE, readValue, stdlibHost } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["string literal", `function main() { return "hello"; }`],
  ["for-of over a string yields characters", `function main() { let r = ""; for (const ch of "hello") { r = ch + r; } return r; }`], // "olleh"
  ["for-of over a string counts a predicate", `function main() { let v = 0; for (const c of "education") { if (c === "a" || c === "e" || c === "i" || c === "o" || c === "u") { v = v + 1; } } return v; }`], // 5
  ["concat two literals", `function main() { return "ab" + "cd"; }`],
  ["concat chain", `function main() { return "a" + "b" + "c" + "d"; }`],
  ["coerce a number on the right", `function main() { return "n=" + 5; }`],
  ["coerce a number on the left", `function main() { return 42 + "!"; }`],
  ["coerce a negative number", `function main() { return "t=" + (0 - 42); }`],
  ["coerce zero", `function main() { return "z" + 0; }`],
  ["coerce a multi-digit number", `function main() { return "#" + 12345; }`],
  ["coerce true", `function main() { return "v=" + (1 < 2); }`],                          // "v=true"
  ["coerce false", `function main() { return "v=" + (2 < 1); }`],                          // "v=false"
  ["coerce null", `function main() { return "v=" + null; }`],                              // "v=null"
  ["coerce undefined", `function main() { let x; return "v=" + x; }`],                     // "v=undefined"
  ["equal strings are === by value", `function main() { const a = "x" + "y"; const b = "xy"; return a === b; }`],
  ["unequal strings", `function main() { return "ab" === "ac"; }`],
  ["different lengths are not equal", `function main() { return "ab" === "abc"; }`],
  ["!== on strings", `function main() { return "a" !== "b"; }`],
  ["String.raw lowers to compile-time raw concatenation", `function main() { return String.raw\`a\\nb\` + "|" + String.raw\`x\${2 + 3}y\`; }`], // "a\\nb|x5y" — raw escapes preserved verbatim, the substitution coerced and concatenated (no runtime .raw)
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
  ["typeof number", `function main() { return typeof 5; }`],
  ["typeof string", `function main() { return typeof "x"; }`],
  ["typeof boolean", `function main() { return typeof (1 < 2); }`],
  ["typeof undefined", `function main() { let x; return typeof x; }`],
  ["typeof null is object", `function main() { return typeof null; }`],
  ["typeof object", `function main() { return typeof { a: 1 }; }`],
  ["typeof function", `function main() { const f = (x) => x; return typeof f; }`],
  ["typeof guards a branch", `function main() { const v = 5; if (typeof v === "number") { return "num"; } return "other"; }`],
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs strings (literals, concat with coercion, value equality, typeof) and matches the interpreter`);
process.exit(ok ? 0 : 1);

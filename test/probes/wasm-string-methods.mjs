// Probe: the AOT compiler runs string and array instance methods — and matches
// the interpreter. Strings are [STRTAG, byteLen, ...bytes] (ASCII); the runtime
// case-folds (toUpperCase/toLowerCase), trims, splits, searches (charCodeAt/
// charAt), and slices over that byte layout. Array methods (join, slice, and
// Array.from) reuse the growable-array runtime; slice is tag-polymorphic
// (substring vs subarray). These compile to CALLM with the real receiver (a
// string or array), dispatched at compile time on the method name. Each program
// runs interpreted and compiled to native wasm; the decoded native value must
// equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue, stdlibHost } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["toUpperCase / toLowerCase", `function main() { return "Hello".toUpperCase() + "/" + "WoRlD".toLowerCase(); }`], // "HELLO/world"
  ["trim strips both ends", `function main() { return "[" + "  hi there  ".trim() + "]"; }`],                          // "[hi there]"
  ["trim of tabs and newlines", `function main() { return "\\t\\n x \\n\\t".trim(); }`],                                // "x"
  ["split by a separator", `function main() { const p = "one two three".split(" "); return p.length * 100 + p[0].length + p[2].length; }`], // 3*100 + 3 + 5 = 308
  ["split by comma, count", `function main() { return "a,b,c,d".split(",").length; }`],                                 // 4
  ["split by empty string -> chars", `function main() { return "abc".split("").join("|"); }`],                          // "a|b|c"
  ["array join with a separator", `function main() { return ["x", "y", "z"].join("-"); }`],                             // "x-y-z"
  ["array join default separator", `function main() { return [1, 2, 3].join(); }`],                                     // "1,2,3"
  ["array slice (one arg)", `function main() { return [10, 20, 30, 40].slice(2).join(","); }`],                          // "30,40"
  ["array slice (two args)", `function main() { return [10, 20, 30, 40].slice(1, 3).join(","); }`],                      // "20,30"
  ["string slice", `function main() { return "abcdef".slice(2, 4); }`],                                                 // "cd"
  ["string slice with a negative index", `function main() { return "hello world".slice(-5); }`],                        // "world"
  ["charCodeAt and charAt", `function main() { return "ABC".charCodeAt(0) * 1000 + "ABC".charAt(2).charCodeAt(0); }`],   // 65000 + 67 = 65067
  ["Array.from copies an array", `function main() { const a = Array.from([5, 6, 7]); a[0] = 9; return a[0] * 100 + a.length; }`], // 903
  ["the slugify chain (trim/lower/split/join)", `function slugify(t) { return t.trim().toLowerCase().split(" ").join("-"); } function main() { return slugify("  Hello Big World  "); }`], // "hello-big-world"
  ["split then map then join", `function main() { return "1 2 3 4".split(" ").map((s) => s + "!").join(","); }`],        // "1!,2!,3!,4!"
  ["Array.flat (one level)", `function main() { return [[1, 2], [3], [4, 5, 6]].flat().reduce((s, x) => s + x, 0); }`], // 21
  ["flat then join, mixed elements", `function main() { return [1, [2, 3], 4].flat().join(","); }`],                    // "1,2,3,4"
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs string and array instance methods and matches the interpreter`);
process.exit(ok ? 0 : 1);

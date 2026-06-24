// Probe: the AOT compiler runs regular expressions — and matches the interpreter.
// A regex literal's pattern is known at compile time, so it is compiled to a tiny
// bytecode (literals, ., char classes incl. \d\w\s and negation, * + ?, |, groups,
// ^ $, g/i flags) and matched by a backtracking VM at runtime. test returns a
// boolean, match returns the array of matches (g) or null, and replace rebuilds the
// string against a literal or a callback. Each program runs interpreted and
// compiled to native wasm; the decoded native value must equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["test: a digit is present", `function main() { return /\\d/.test("abc123"); }`],                            // true
  ["test: no digit", `function main() { return /\\d/.test("abcdef"); }`],                                       // false
  ["test: + quantifier", `function main() { return /ab+c/.test("abbbc") === (!/ab+c/.test("ac")); }`],          // true
  ["test: a character class", `function main() { return (/[a-z]+/.test("hey") ? 1 : 0) + (/[a-z]+/.test("99") ? 10 : 0); }`], // 1
  ["test: anchors", `function main() { return (/^hi$/.test("hi") ? 1 : 0) + (/^hi$/.test("hii") ? 10 : 0); }`], // 1
  ["test: alternation", `function main() { return /(cat|dog)/.test("a dog!"); }`],                              // true
  ["test: the i flag", `function main() { return /abc/i.test("xxABCyy"); }`],                                   // true
  ["test: \\w and \\s", `function main() { return /\\w+\\s\\w+/.test("foo bar"); }`],                           // true
  ["match: all digit runs (g)", `function main() { return "a12b3c456".match(/\\d+/g).join(","); }`],            // "12,3,456"
  ["match: words (g)", `function main() { return "hello   world".match(/[a-z]+/g).join("|"); }`],               // "hello|world"
  ["match: no match returns null", `function main() { const m = "xyz".match(/\\d/g); return m === null ? "null" : m.join(","); }`], // "null"
  ["match: count via length", `function main() { return "a.b.c.d".match(/[a-z]/g).length; }`],                  // 4
  ["replace: all occurrences (g)", `function main() { return "foo boo".replace(/o/g, "0"); }`],                 // "f00 b00"
  ["replace: first only (no g)", `function main() { return "hello".replace(/l/, "L"); }`],                      // "heLlo"
  ["replace: a class with a literal", `function main() { return "a1b2c3".replace(/[0-9]/g, "#"); }`],           // "a#b#c#"
  ["replace: a callback uppercases each match", `function main() { return "the cat sat".replace(/\\w+/g, (w) => w.toUpperCase()); }`], // "THE CAT SAT"
  ["replace: callback doubles digits", `function main() { return "a1b2".replace(/\\d/g, (d) => d + d); }`],     // "a11b22"
  ["the realts shape: test + match + replace", `
    function main() {
      const s = "hello world 42";
      return (/\\d/.test(s) ? "Y" : "N") + " " + s.match(/[a-z]+/g).join(",") + " " + s.replace(/o/g, "0");
    }`], // "Y hello,world hell0 w0rld 42"
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs regular expressions (test/match/replace) and matches the interpreter`);
process.exit(ok ? 0 : 1);

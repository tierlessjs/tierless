// Probe: the AOT compiler runs Map and Set — and matches the interpreter. Both
// are [tag, count, backing] (a Map backing holds key/value entries, a Set holds
// values), with keys/values compared by __eq so equal strings collide as one key.
// Construction (optional init array), set/get/has/add, .size, for-of (a Map yields
// [k,v] pairs, a Set its values), .keys()/.values(), and spread ([...s],
// [...m.keys()]) all route through the iterator machinery. The programs return
// scalars (the native decoder reads numbers/strings); each runs interpreted and
// compiled to native wasm and the decoded values must match.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue, stdlibHost } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["map set/get", `function main() { const m = new Map(); m.set("a", 1); m.set("b", 2); return m.get("a") + m.get("b"); }`], // 3
  ["map overwrite keeps one entry", `function main() { const m = new Map(); m.set("a", 1); m.set("a", 9); return m.get("a") * 10 + m.size; }`], // 91
  ["map has", `function main() { const m = new Map(); m.set("x", 5); return (m.has("x") ? 1 : 0) * 10 + (m.has("z") ? 1 : 0); }`], // 10
  ["map from an init array, then set", `function main() { const m = new Map([["a", 1], ["b", 2]]); m.set("c", 3); return m.size * 100 + m.get("b"); }`], // 302
  ["map get missing is undefined", `function main() { const m = new Map([["a", 1]]); return m.get("zzz") === undefined ? 7 : 0; }`], // 7
  ["map for-of over [k,v] entries", `function main() { const m = new Map([["a", 1], ["b", 2], ["c", 3]]); let t = 0; for (const [k, v] of m) { t += v; } return t; }`], // 6
  ["map keys spread", `function main() { const m = new Map([["a", 1], ["b", 2], ["c", 3]]); const ks = [...m.keys()]; return ks.length * 100 + (ks[0] === "a" ? 1 : 0) + (ks[2] === "c" ? 10 : 0); }`], // 311
  ["map values via for-of", `function main() { const m = new Map([["a", 10], ["b", 20]]); let t = 0; for (const v of m.values()) { t += v; } return t; }`], // 30
  ["map integer keys", `function main() { const m = new Map(); m.set(1, 100); m.set(2, 200); return m.get(1) + m.get(2) + (m.has(2) ? 1 : 0); }`], // 301
  ["set size with duplicates dropped", `function main() { const s = new Set([1, 2, 2, 3, 3, 3]); return s.size; }`], // 3
  ["set add and has", `function main() { const s = new Set(); s.add(1); s.add(2); s.add(2); return s.size * 10 + (s.has(2) ? 1 : 0) + (s.has(9) ? 100 : 0); }`], // 21
  ["set for-of", `function main() { const s = new Set([5, 10, 15]); let t = 0; for (const v of s) { t += v; } return t; }`], // 30
  ["set spread to an array", `function main() { const s = new Set([1, 2, 3]); const d = [...s]; return d.length * 100 + d[0] + d[2]; }`], // 304
  ["map and set together", `function main() { const m = new Map([["x", 1]]); m.set("y", 2); const s = new Set([1, 2, 2]); s.add(3); let t = 0; for (const [k, v] of m) { t += v; } for (const v of s) { t += v; } return t * 100 + m.size * 10 + s.size; }`], // (1+2 + 1+2+3)=9 -> 900 + 20 + 3 = 923
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs Map and Set (construct, methods, .size, for-of, spread) and matches the interpreter`);
process.exit(ok ? 0 : 1);

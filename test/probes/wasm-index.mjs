// Probe: the AOT compiler runs computed member access — obj[expr] and arr[i] —
// and matches the interpreter. INDEX/SETINDEX dispatch at runtime on the
// receiver: an array (numeric index into the backing store) or an object (string
// key). Object keys are interned ints, so a string key is mapped by __keyid,
// which seeds a table from the program's static keys and then interns any new
// key by value — so a key never seen statically (o["z"]=...) still gets a unique
// id and round-trips, and one shared with static access resolves to the same id.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue, stdlibHost } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["constant array index", `function main() { const a = [1, 2, 3]; return a[0] + a[2]; }`],        // 1 + 3 = 4
  ["variable array index in a loop", `function main() { const a = [10, 20, 30]; let s = 0; for (let i = 0; i < 3; i++) { s += a[i]; } return s; }`], // 60
  ["array element assignment", `function main() { const a = [1, 2, 3]; a[1] = 9; return a[0] + a[1] + a[2]; }`], // 13
  ["read-modify-write through an index", `function main() { const a = [1, 2, 3]; const x = a[1]--; return x * 100 + a[1]; }`], // 2*100 + 1 = 201
  ["object computed get with a static key", `function main() { const o = { x: 5, y: 7 }; const k = "x"; return o[k] + o.y; }`], // 12
  ["object computed set with a brand-new key", `function main() { const o = { a: 1 }; o["z"] = 99; return o.z + o.a; }`], // 100
  ["dynamic keys taken from an array", `function main() { const o = {}; const keys = ["p", "q"]; o[keys[0]] = 3; o[keys[1]] = 4; return o["p"] + o["q"]; }`], // 7
  ["computed get and set together (for-in shape)", `
    function main() {
      const o = { a: 1, b: 2, c: 3 };
      const out = {};
      const ks = ["a", "b", "c"];
      for (let i = 0; i < 3; i++) { out[ks[i]] = o[ks[i]] * 2; }
      return out.a + out.b + out.c;
    }`],                                                                                             // 2+4+6 = 12
  ["nested computed access", `function main() { const grid = [[1, 2], [3, 4]]; return grid[1][0] + grid[0][1]; }`], // 3 + 2 = 5
  ["computed access with a string-keyed value", `function main() { const o = { name: "ann" }; const f = "name"; return "hi " + o[f]; }`], // "hi ann"
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
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs computed member access (arr[i] / obj[key]) and matches the interpreter`);
process.exit(ok ? 0 : 1);

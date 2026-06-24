// Probe: the AOT compiler runs Promise.resolve / Promise.all / Promise.reject —
// and matches the interpreter. In this synchronous execution model a resolved
// promise is just its value (await and Promise.resolve are identity, Promise.all
// of resolved values is the array). Only a rejection is reified — Promise.reject
// builds a [REJTAG, value] cell, and awaiting it (directly or inside Promise.all)
// raises the value through the same exception protocol as throw, so a surrounding
// try/catch catches it. Each program runs interpreted and compiled to native
// wasm; the decoded native value must equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["await a resolved value", `async function go() { const v = await Promise.resolve(42); return v + 1; }`], // 43
  ["Promise.all of resolved values, reduced", `async function go() { const xs = await Promise.all([Promise.resolve(1), Promise.resolve(2), 3]); return xs.reduce((a, b) => a + b, 0); }`], // 6
  ["Promise.all preserves order", `async function go() { const xs = await Promise.all([10, Promise.resolve(20), 30]); return xs[0] * 100 + xs[1] * 10 + xs[2]; }`], // 1230
  ["a rejection caught by try/catch", `async function go() { try { await Promise.reject({ code: "Z" }); return "no"; } catch (e) { return e.code; } }`], // "Z"
  ["resolve vs reject across two awaits", `
    async function risky(fail) { if (fail) { return Promise.reject({ code: "X" }); } return "ok"; }
    async function go() {
      let r1, r2;
      try { r1 = await risky(false); } catch (e) { r1 = "caught:" + e.code; }
      try { r2 = await risky(true); } catch (e) { r2 = "caught:" + e.code; }
      return r1 + "|" + r2;
    }`], // "ok|caught:X"
  ["a rejection inside Promise.all propagates to catch", `async function go() { try { await Promise.all([Promise.resolve(1), Promise.reject({ code: "B" })]); return "no"; } catch (e) { return e.code; } }`], // "B"
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "go", resources: [] });
  return rt.run({ id: "t" }, initialFrames("go", []), { deref: (x) => x }).value;
}
function native(src) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(compileModuleToWasm(src, { entry: "go", resources: [] })), { env: {} });
  new DataView(inst.exports.memory.buffer).setInt32(BUMP_ADDR, HEAP_BASE, true);
  return readValue(inst.exports.memory, inst.exports.go());
}

const results = [];
for (const [name, src] of programs) {
  const i = interp(src), n = native(src);
  const ok = Object.is(i, n);
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: interpreter ${JSON.stringify(i)} == native ${JSON.stringify(n)}`);
}
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs Promise.resolve/all/reject and matches the interpreter`);
process.exit(ok ? 0 : 1);

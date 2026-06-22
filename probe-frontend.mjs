// Probe: #4 frontend — real TS with closures + await, compiled to the JS IR.
//
// Section A reproduces the gap: the toy wasm-IR compiler can't handle a closure.
// Section B compiles real TS (closures + await) with the new frontend, runs it
// on the de-risked runtime, and proves the payoff: a closure survives a
// serialization boundary MID-AWAIT — its captured environment travels as data,
// its code by reference. That's the #4 thesis in miniature.

import { PROGRAM, run, Suspend, serializeContinuation, deserializeContinuation, initialFrames, isClosure } from "./waso-core.mjs";
import { loadModule } from "./waso-tsc.mjs";

let pass = true;
const check = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); pass &&= cond; };

// ---- Section A: the gap in the old (wasm-IR) frontend ----------------------
console.log("Probe: #4 frontend (closures + await)\n--- A. the gap ---");
const { compile: oldCompile } = await import("./waso-compile.mjs");
let gap = false;
try { oldCompile("function f(){ const g = (x) => x + 1; return g(2); }"); }
catch { gap = true; }
check("old wasm-IR frontend rejects a closure (arrow function)", gap);

// ---- Section B: closures, compiled from real TS and run -------------------
console.log("\n--- B. closures via the new frontend ---");
loadModule(PROGRAM, `
  function makeAdder(n) { return (x) => x + n; }      // closure captures n
  function main() {
    const add10 = makeAdder(10);
    return add10(5) + add10(7);                        // 15 + 17
  }
`, { entry: "main" });

const sync = run({ id: "t" }, initialFrames("main", []), { deref: (x) => x });
check(`real TS with a returned closure runs (got ${sync.value}, expected 32)`, sync.value === 32);

// ---- Section C: closure + await, and serialize MID-AWAIT -------------------
console.log("\n--- C. closure survives a migration mid-await ---");
loadModule(PROGRAM, `
  function makeAdder(n) { return (x) => x + n; }
  function task() {
    const add = makeAdder(100);     // a closure is live in locals across the await
    const y = await ext();          // suspension point: continuation holds the closure
    return add(y);                  // resume and call the closure
  }
`, { entry: "task", resources: ["ext"] });

const tier = { id: "t", has: (n) => n === "ext", resources: { ext: () => ({ op: "ext" }) } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resolve = async (d) => { await sleep(2); return d.op === "ext" ? 5 : 0; };

// Async orchestrator that serializes/deserializes the continuation at the await.
async function runViaWire(entry) {
  let frames = initialFrames(entry, []);
  const host = { deref: (x) => x };
  let sawClosureOnWire = false;
  while (true) {
    let res;
    try { res = run(tier, frames, host); }
    catch (e) {
      if (!(e instanceof Suspend)) throw e;
      if (!(e.pending && "await" in e.pending)) throw new Error("unexpected suspension");
      const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, tier);   // cross a boundary
      // the closure `add` is a local in the suspended frame; confirm it rode the wire as data
      const got = deserializeContinuation(JSON.parse(JSON.stringify(wire)));
      sawClosureOnWire = got.frames.some((f) => f.locals.some(isClosure));
      const value = await resolve(got.pending.await);
      got.frames[got.frames.length - 1].stack.push(value);
      frames = got.frames;
      continue;
    }
    return { value: res.value, sawClosureOnWire };
  }
}

const r = await runViaWire("task");
check(`closure was serialized as part of the continuation at the await`, r.sawClosureOnWire);
check(`after migrating mid-await, the closure still works (got ${r.value}, expected 105)`, r.value === 105);

console.log(`\nResult: ${pass ? "all PASS" : "FAILURES"} — real TS closures compile to the JS IR, and a`);
console.log(`closure survives a serialization boundary mid-await (env as data, code by reference).`);
console.log(`Next for #4: broaden the TS subset (loops/objects already in), then mutable captured`);
console.log(`vars and the source-map metadata; async needs no colored functions here.`);
if (!pass) process.exitCode = 1;

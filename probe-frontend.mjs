// Probe: #4 frontend — real TS with closures + await, compiled to the JS IR.
//
// Section A reproduces the gap: the toy wasm-IR compiler can't handle a closure.
// Section B compiles real TS (closures + await) with the new frontend, runs it
// on the de-risked runtime, and proves the payoff: a closure survives a
// serialization boundary MID-AWAIT — its captured environment travels as data,
// its code by reference. That's the #4 thesis in miniature.

import { PROGRAM, run, Suspend, serializeContinuation, deserializeContinuation, initialFrames, isClosure } from "./waso-core.mjs";
import { loadModule, describeContinuation } from "./waso-tsc.mjs";

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

// ---- Section D: mutable captured variable shared across closures -----------
console.log("\n--- D. shared mutable capture (boxed cell) surviving migration ---");
loadModule(PROGRAM, `
  function makeCounter() { let n = 0; const inc = () => { n = n + 1; }; const get = () => n; return { inc, get }; }
  function main() { const c = makeCounter(); c.inc(); c.inc(); return c.get(); }
`, { entry: "main" });
const local = run({ id: "t" }, initialFrames("main", []), { deref: (x) => x });
check(`two closures share & mutate a captured 'let' (got ${local.value}, expected 2)`, local.value === 2);

loadModule(PROGRAM, `
  function makeCounter() { let n = 0; const inc = () => { n = n + 1; }; const get = () => n; return { inc, get }; }
  function task() { const c = makeCounter(); await ext(); c.inc(); c.inc(); return c.get(); }
`, { entry: "task", resources: ["ext"] });
const shared = await runViaWire("task");
check(`the shared cell survives migration: inc/inc after resume still reach get (got ${shared.value}, expected 2)`, shared.value === 2);

// ---- Section E: lexical shadowing (binding-keyed, not name-keyed) ----------
console.log("\n--- E. shadowing: same name, different bindings ---");
loadModule(PROGRAM, `
  function add100(n) { return n + 100; }     // n is a plain param (NOT boxed)
  function outer() {
    let n = 1;                               // a DIFFERENT n, captured + mutated -> boxed
    const inc = () => { n = n + 10; };
    inc();
    return n + add100(5);                    // 11 + 105 = 116
  }
`, { entry: "outer" });
const sh = run({ id: "t" }, initialFrames("outer", []), { deref: (x) => x });
check(`outer's boxed n and add100's plain n don't collide (got ${sh.value}, expected 116)`, sh.value === 116);

// ---- Section F: broadened control flow vs plain JS -------------------------
console.log("\n--- F. while / break / continue / && / ?: / += ---");
const SRC = `function compute(limit) {
  let sum = 0; let i = 0;
  while (i < limit) {
    if (i === 5) { i = i + 1; continue; }
    sum += i;
    if (sum > 20) { break; }
    i = i + 1;
  }
  const flag = (limit > 3) && (sum > 0);
  return flag ? sum : -1;
}`;
loadModule(PROGRAM, SRC, { entry: "compute" });
function computeJS(limit) { let sum = 0, i = 0; while (i < limit) { if (i === 5) { i = i + 1; continue; } sum += i; if (sum > 20) break; i = i + 1; } const flag = (limit > 3) && (sum > 0); return flag ? sum : -1; }
let okF = true;
for (const lim of [0, 3, 8, 100]) {
  const got = run({ id: "t" }, initialFrames("compute", [lim]), { deref: (x) => x }).value;
  if (got !== computeJS(lim)) { okF = false; console.log(`    compute(${lim}) = ${got}, JS = ${computeJS(lim)}`); }
}
check("compute() matches plain JS across inputs (while/break/continue/&&/?:/+=)", okF);

// ---- Section G: source maps — a continuation as a TS stack trace -----------
console.log("\n--- G. source map: continuation -> TS stack trace ---");
loadModule(PROGRAM, `
  function fetchThing() { return ext(); }
  function step() { return await fetchThing(); }
  function task() { const a = step(); return a; }
`, { entry: "task", resources: ["ext"] });

let trace = null;
{
  let frames = initialFrames("task", []);
  try { run(tier, frames, { deref: (x) => x }); }
  catch (e) { if (e instanceof Suspend) trace = describeContinuation(PROGRAM, e.frames); else throw e; }
}
console.log("  suspended continuation maps to:");
for (const fr of trace || []) console.log(`    #${fr.depth} ${fr.fn.padEnd(6)} ${fr.loc ? `${fr.loc.file}:${fr.loc.line}  \`${fr.loc.text}\`` : "(no source)"}`);
check("continuation has a TS-level frame for `step` with a real line", !!(trace && trace.find((f) => f.fn === "step" && f.loc && f.loc.line)));
check("the deepest frame points at the await/fetch line", !!(trace && trace[trace.length - 1].loc && /ext|fetchThing/.test(trace[trace.length - 1].loc.text)));

console.log(`\nResult: ${pass ? "all PASS" : "FAILURES"} — closures, mutable shared captures (migration-safe),`);
console.log(`lexical shadowing, while/break/continue/&&/||/?:/+=, and source-mapped continuations`);
console.log(`(a serialized continuation prints as a TS stack trace).`);
if (!pass) process.exitCode = 1;

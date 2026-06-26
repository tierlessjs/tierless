// Headless regression for the compiler's EXTENDED control flow (loops, continue,
// try/catch/finally). Drives the pre-generated cf-fixtures.gen.mjs and SERIALIZES the
// continuation through the project's graph codec at every suspend — simulating a tier
// migration on each resource — so it proves loop counters AND the try-handler stack
// (F.__h/__c/__err) survive the wire, and that a resource failing "on another tier" is
// caught by a try/catch in the migrated code. No browser, no socket, no Babel.
import { PROGRAMS, __dispatch } from "./cf-fixtures.gen.mjs";
import { encodeGraph, decodeGraph } from "../../src/runtime/heap.mjs";

const wire = (stack) => decodeGraph(JSON.parse(JSON.stringify(encodeGraph([stack]))))[0];
const exec = (req) => { if (req.name === "api.fail") throw new Error("resource failed"); return req.args[0]; }; // dbl/get echo arg; fail throws

function runMigrating(fn) {
  let stack = [{ fn, pc: 0, args: [] }];
  for (;;) {
    const r = PROGRAMS[stack[stack.length - 1].fn](stack[stack.length - 1]);
    if (r.op === "return") return r.value;           // single-frame fixtures
    if (r.op === "throw") throw r.value;
    stack = wire(stack);                             // migrate: serialize the whole continuation, then service the resource
    const top = stack[stack.length - 1];
    try { top.ret = exec(r); }
    catch (err) { const tpc = __dispatch(top, err); if (tpc == null) throw err; top.pc = tpc; }
  }
}

const cases = [
  ["for + continue + suspend in loop", "forContinue", 9],
  ["while(cond) + break", "whileBreak", 10],
  ["try/catch a resource error across the migrate", "catchAcrossTier", "rescued:resource failed"],
  ["try/finally runs on the normal path", "finallyRuns", "a5F"],
  ["try/catch/finally (resource throws)", "catchFinally", "aCF"],
];

let pass = 0;
for (const [label, fn, expected] of cases) {
  let got, err = null;
  try { got = runMigrating(fn); } catch (e) { err = e; }
  const ok = err == null && got === expected;
  if (ok) pass++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${err ? "ERR:" + err.message : JSON.stringify(got)}, expected ${JSON.stringify(expected)})`}`);
}
console.log(pass === cases.length
  ? `\nPASS — extended control flow survives migration: loops, continue, and try/catch/finally across suspends (${pass}/${cases.length})`
  : `\nFAIL (${pass}/${cases.length})`);
process.exit(pass === cases.length ? 0 : 1);

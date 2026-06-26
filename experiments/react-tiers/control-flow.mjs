// Headless regression for the compiler's EXTENDED control flow (loops, continue,
// try/catch/finally). Drives the pre-generated cf-fixtures.gen.mjs and SERIALIZES the
// continuation through the project's graph codec at every suspend — simulating a tier
// migration on each resource — so it proves loop counters AND the try-handler stack
// (F.__h/__c/__err) survive the wire, and that a resource failing "on another tier" is
// caught by a try/catch in the migrated code. No browser, no socket, no Babel.
import { PROGRAMS, __unwind } from "./cf-fixtures.gen.mjs";
import { encodeGraph, decodeGraph } from "../../src/runtime/heap.mjs";

const wire = (stack) => decodeGraph(JSON.parse(JSON.stringify(encodeGraph([stack]))))[0];
const exec = (req) => { if (req.name === "api.fail") throw new Error("resource failed"); return req.args[0]; }; // dbl/get echo arg; fail throws

function runMigrating(fn) {
  let stack = [{ fn, pc: 0, args: [] }];
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return r.value; stack[stack.length - 1].ret = r.value; continue; }
    if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); continue; }   // push a sub-frame
    if (r.op === "throw") { stack.pop(); if (!__unwind(stack, r.value)) throw r.value; continue; }
    stack = wire(stack);                             // resource: serialize the WHOLE (possibly multi-frame) continuation, then service
    const f = stack[stack.length - 1];
    try { f.ret = exec(r); }
    catch (err) { if (!__unwind(stack, err)) throw err; }
  }
}

const cases = [
  ["for + continue + suspend in loop", "forContinue", 9],
  ["while(cond) + break", "whileBreak", 10],
  ["try/catch a resource error across the migrate", "catchAcrossTier", "rescued:resource failed"],
  ["try/finally runs on the normal path", "finallyRuns", "a5F"],
  ["try/catch/finally (resource throws)", "catchFinally", "aCF"],
  ["sync throw inside a compiled function", "throwInMachine", "caught:boom"],
  ["nested suspension: callee suspends, multi-frame stack migrates", "sumViaHelper", 12],
  ["cross-frame catch: callee's resource fails, caller catches", "callerCatches", "caught:resource failed"],
  ["resource value used in an expression (return f()+1)", "returnExpr", 8],
  ["resource on an assignment RHS (x = api.get())", "assignRhs", 5],
  ["resource in an if-test", "ifTest", "yes"],
  ["resource in a while-test (desugared)", "whileTestSusp", 6],
  ["two resources in a call's args, order preserved", "nestedArgs", 5],
  ["suspendable-call result used in an expression", "callInExpr", 9],
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
  ? `\nPASS — extended control flow survives migration: loops, continue, try/catch/finally, nested calls, and suspensions in expression positions (${pass}/${cases.length})`
  : `\nFAIL (${pass}/${cases.length})`);
process.exit(pass === cases.length ? 0 : 1);

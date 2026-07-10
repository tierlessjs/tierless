// Headless regression for the compiler's EXTENDED control flow (loops, continue,
// try/catch/finally). Drives the pre-generated cf-fixtures.gen.mjs and SERIALIZES the
// continuation through the project's graph codec at every suspend — simulating a tier
// migration on each resource — so it proves loop counters AND the try-handler stack
// (F.__h/__c/__err) survive the wire, and that a resource failing "on another tier" is
// caught by a try/catch in the migrated code. No browser, no socket, no Babel.
import { PROGRAMS, __unwind } from "./cf-fixtures.gen.mjs";
import { encodeGraph, decodeGraph } from "tierless/graph";
import type { Frame, ResourceRequest } from "tierless/runtime";

const wire = (stack: Frame[]): Frame[] => decodeGraph(JSON.parse(JSON.stringify(encodeGraph([stack])))) [0] as Frame[]; // round-tripped through the wire codec — same shape
const exec = (req: ResourceRequest): unknown => {                       // dbl/get echo arg; inc adds 1; lt3 is i<3; fail throws
  if (req.name === "api.fail") throw new Error("resource failed");
  if (req.name === "api.inc") return (req.args[0] as number) + 1;
  if (req.name === "api.lt3") return (req.args[0] as number) < 3 ? 1 : 0;
  return req.args[0];
};

function runMigrating(fn: string): unknown {
  let stack: Frame[] = [{ fn, pc: 0, args: [] }];
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return r.value; stack[stack.length - 1].ret = r.value; continue; }
    if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); continue; }   // push a sub-frame
    if (r.op === "throw") { stack.pop(); if (!__unwind(stack, r.value)) throw r.value; continue; }
    if (r.op !== "resource") throw new Error("this fixture never parks dynamically");   // op:"dyn" joined MachineResult with the migrate arm
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
  ["?: where only the taken branch suspends", "ternaryPick", 7],
  ["&& / || short-circuit with a suspending operand", "shortCircuit", 5],
  ["switch with a break", "switchPick", 20],
  ["switch fall-through", "switchFall", 3],
  ["labeled break out of nested loops", "labeledBreak", 4],
  ["do-while with a suspending body", "doWhileSusp", 3],
  ["suspending for-init", "forHeaderSusp", 6],
  ["early return out of a try/catch", "returnInTry", 5],
  ["break out of a try inside a loop", "breakOutOfTry", 3],
  ["return through a finally (which itself suspends)", "returnThroughFinally", 7],
  ["suspending for-update", "forUpdateSusp", 6],
  ["suspending do-while test", "doWhileTestSusp", 3],
  ["unbraced if-branch: suspension runs ONLY in the taken branch", "unbracedBranchSusp", 10],
  ["unbraced loop-body if with a suspending branch", "unbracedLoopBodySusp", 100],
] as const;

let pass = 0;
for (const [label, fn, expected] of cases) {
  let got: unknown, err: unknown = null;
  try { got = runMigrating(fn); } catch (e) { err = e; }
  const ok = err == null && got === expected;
  if (ok) pass++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${err ? "ERR:" + (err as Error).message : JSON.stringify(got)}, expected ${JSON.stringify(expected)})`}`);
}

// Safety net: a frame whose pc has no case (a transform bug, or a continuation mangled in transit)
// must hard-error at once, never spin `while (true)` forever. Drive a real machine with an
// out-of-range pc and assert it throws RangeError instead of hanging.
let guardErr: unknown = null;
try { PROGRAMS.forContinue({ fn: "forContinue", pc: 0xbeef, args: [] }); } catch (e) { guardErr = e; }
const pcGuardOk = guardErr instanceof RangeError && /invalid pc/.test(guardErr.message);
console.log(`  ${pcGuardOk ? "PASS" : "FAIL"}  out-of-range pc hard-errors (no infinite loop)`);

const allOk = pass === cases.length && pcGuardOk;
console.log(allOk
  ? `\nPASS — extended control flow survives migration: loops, continue, try/catch/finally, nested calls, expression positions, &&/||/?:, switch, labeled break/continue, do-while, loop headers, and the pc safety net (${pass}/${cases.length} + guard)`
  : `\nFAIL (${pass}/${cases.length}${pcGuardOk ? "" : ", pc guard failed"})`);
process.exit(allOk ? 0 : 1);

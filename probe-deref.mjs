// Waso — deref-miss re-runnability probe.
//
// A continuation can reference a remote heap object as a §5 handle. Touching it on a
// tier that doesn't have it resident makes host.deref return a Miss, which the
// interpreter turns into a Suspend (a deref-miss is an await on the fetch). The host
// fetches it and RE-RUNS the same op from the same ip — so every op that derefs must
// touch the stack only AFTER the deref succeeds, or the re-run sees a corrupted stack
// (lost args / shifted operands). This probe makes the deref miss exactly once, then
// asserts the op suspends, resumes, and computes the right answer with its stack intact.
//
// The transport that actually fetches a remote handle isn't wired yet (it's modeled in
// waso-policy.mjs), but the re-runnable invariant is real and load-bearing for it — so
// it's tested here directly rather than left to a future integration.

import { PROGRAM, run, Suspend, Miss } from "./waso-core.mjs";

let pass = 0, fail = 0; const fails = [];
const HANDLE = { __waso_handle__: true, owner: "srv", id: 0, kind: "object" };

// Run a hand-written program whose locals hold HANDLE; host.deref misses the FIRST
// time it's asked for HANDLE (forcing a Suspend), then resolves to `real`. Asserts the
// program suspended (so the deref path was exercised) and resumed to `expect`.
function reRun(name, code, locals, real, expect) {
  let missed = false;
  const host = { deref: (h) => { if (h === HANDLE && !missed) { missed = true; return new Miss(h); } return real; } };
  const tier = { id: "srv" };
  PROGRAM["%t"] = { nlocals: locals.length, code, pos: code.map(() => null) };
  let suspended = false, got, err = null;
  try {
    got = run(tier, [{ fn: "%t", ip: 0, locals: locals.slice(), stack: [], env: [], handlers: [] }], host).value;
  } catch (e) {
    if (e instanceof Suspend) { suspended = true; try { got = run(tier, e.frames, host).value; } catch (e2) { err = e2; } } // resume from the captured continuation
    else err = e;
  }
  const ok = !err && suspended && JSON.stringify(got) === JSON.stringify(expect);
  if (ok) pass++; else { fail++; fails.push(name); console.log(`  FAIL  ${name}`); console.log(`        suspended=${suspended} err=${err ? (err.message || err) : "-"} got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`); }
}

console.log("Waso deref-miss re-runnability — a handle miss mid-op suspends, resumes, stays correct\n");

// BIN: a handle OPERAND must resolve to its value (was: operated on the raw wrapper).
reRun("BIN + on a handle operand", [["LOAD", 0], ["PUSH", 10], ["BIN", "+"], ["RET"]], [HANDLE], 5, 15);
reRun("BIN === handle vs handle", [["LOAD", 0], ["LOAD", 0], ["BIN", "==="], ["RET"]], [HANDLE], { a: 1 }, true);

// The core claim: an op with ARGS already on the stack must not lose them when the
// receiver deref-misses (was: args popped before the deref → corrupt on resume).
reRun("CALLM keeps its arg (handle.indexOf(7))", [["LOAD", 0], ["PUSH", 7], ["CALLM", "indexOf", 1], ["RET"]], [HANDLE], [10, 20, 7, 30], 2);
reRun("CALLMETHOD keeps its arg (handle.includes(20))", [["LOAD", 0], ["PUSH", 20], ["CALLMETHOD", "includes", 1], ["RET"]], [HANDLE], [10, 20, 30], true);
reRun("CALLDYN keeps key+arg (handle['includes'](20))", [["LOAD", 0], ["PUSH", "includes"], ["PUSH", 20], ["CALLDYN", 1], ["RET"]], [HANDLE], [10, 20], true);

// Other deref ops: property/key/delete/iterate on a handle.
reRun("GETPROP on a handle (control, already correct)", [["LOAD", 0], ["GETPROP", "length"], ["RET"]], [HANDLE], [1, 2, 3], 3);
reRun("HASKEY (`x in handle`)", [["PUSH", "x"], ["LOAD", 0], ["HASKEY"], ["RET"]], [HANDLE], { x: 1 }, true);
reRun("DELPROP on a handle", [["LOAD", 0], ["DELPROP", "a"], ["RET"]], [HANDLE], { a: 1, b: 2 }, true);
reRun("KEYS (Object.keys of a handle)", [["LOAD", 0], ["KEYS"], ["RET"]], [HANDLE], { a: 1, b: 2 }, ["a", "b"]);
reRun("ISARRAY of a handle", [["LOAD", 0], ["ISARRAY"], ["RET"]], [HANDLE], [1, 2], true);
reRun("GENNEXT drives a handle iterator", [["LOAD", 0], ["PUSH", undefined], ["GENNEXT"], ["GETPROP", "value"], ["RET"]], [HANDLE], { __it__: "arr", a: [42, 43], i: 0 }, 42);

console.log(`\n${"=".repeat(64)}`);
console.log(`Result: ${fail === 0 ? "ALL PASS" : fails.length + " FAILED"} — ${pass} deref-miss re-runnability checks${fail ? " ; failures: " + fails.join(", ") : ""}.`);
if (fail) process.exitCode = 1;

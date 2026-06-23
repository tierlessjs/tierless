// Probe: the AOT compiler runs try/catch/throw — and still matches the interpreter.
//
// WASM has no built-in exceptions (and the migration core rides on Asyncify), so
// throwing is a sentinel-return protocol: a pending-exception flag and the thrown
// value live in memory, a throw with no local handler sets them and returns, and
// every call site checks the flag and unwinds to the lexically-active catch
// (resolved per block by tracking PUSHTRY/POPTRY) — or returns to propagate.
// Basic blocks split at calls so the post-call code becomes conditional. Each
// program runs interpreted (tsc.mjs + core.mjs) and compiled to native wasm; the
// decoded native value must equal the interpreter's. (finally and generator
// .throw() are the next slices.)

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["catch a thrown value in the same function", `
    function safe(x) { try { if (x < 0) { throw 42; } return x * 2; } catch (e) { return e; } }
    function main() { return safe(-1); }`],                                                            // 42
  ["no throw takes the normal path", `
    function safe(x) { try { return x * 2; } catch (e) { return 0 - 1; } }
    function main() { return safe(5) + safe(3); }`],                                                    // 10 + 6 = 16
  ["throw vs no-throw across two calls", `
    function safe(x) { try { if (x < 0) { throw 1; } return x * 2; } catch (e) { return 0 - 1; } }
    function main() { return safe(5) + safe(-1); }`],                                                   // 10 + (-1) = 9
  ["a throw propagates across a call into an outer catch", `
    function inner(x) { if (x < 0) { throw 7; } return x; }
    function outer() { try { return inner(-1); } catch (e) { return 99; } }
    function main() { return outer(); }`],                                                              // 99
  ["the propagated value reaches the catch", `
    function inner(x) { if (x < 0) { throw x * 10; } return x; }
    function outer() { try { return inner(-4); } catch (e) { return e; } }
    function main() { return outer(); }`],                                                              // -40
  ["throw a string, catch and concatenate", `
    function f(x) { try { if (x < 0) { throw "bad"; } return "ok"; } catch (e) { return "caught:" + e; } }
    function main() { return f(-1); }`],                                                                // "caught:bad"
  ["nested try, inner catch wins", `
    function f() { try { try { throw 1; } catch (a) { return 10 + a; } } catch (b) { return 99; } }
    function main() { return f(); }`],                                                                  // 11
  ["nested try, rethrow caught by the outer", `
    function f() { try { try { throw 5; } catch (a) { throw a + 1; } } catch (b) { return b * 10; } }
    function main() { return f(); }`],                                                                  // (5+1)*10 = 60
  ["throw out of a loop, caught", `
    function f(n) { let s = 0; let i = 0; try { while (i < n) { if (i === 2) { throw i; } s = s + i; i = i + 1; } } catch (e) { return s * 100 + e; } return s; }
    function main() { return f(5); }`],                                                                 // s=1, throw 2 -> 102
  ["recover in catch, then continue", `
    function f(x) { let r = 0; try { if (x < 0) { throw 1; } r = 10; } catch (e) { r = 20; } return r + 5; }
    function main() { return f(-1) * 100 + f(1); }`],                                                    // 25*100 + 15 = 2515
  ["catch then call a helper", `
    function helper() { return 50; }
    function f() { try { throw 0; } catch (e) { return helper(); } }
    function main() { return f(); }`],                                                                  // 50
  ["throw through two call levels", `
    function deep(x) { if (x < 0) { throw 123; } return x; }
    function mid(x) { return deep(x) + 1; }
    function top() { try { return mid(-1); } catch (e) { return e; } }
    function main() { return top(); }`],                                                                // 123
  ["finally runs on the normal path", `
    function f() { let log = 0; try { log = 1; } finally { log = log + 10; } return log; }
    function main() { return f(); }`],                                                                  // 11
  ["finally runs but the return value was captured first", `
    function f(x) { try { return x; } finally { x = 99; } }
    function main() { return f(5); }`],                                                                 // 5
  ["finally runs on throw, an outer catch recovers", `
    function f() { let log = 0; try { try { log = 1; throw 0; } finally { log = log + 10; } } catch (e) { log = log + 100; } return log; }
    function main() { return f(); }`],                                                                  // 1+10+100 = 111
  ["try / catch / finally together, both branches", `
    function f(x) { let r = 0; try { if (x < 0) { throw 1; } r = 10; } catch (e) { r = 20; } finally { r = r + 100; } return r; }
    function main() { return f(-1) * 1000 + f(1); }`],                                                   // 120*1000 + 110
  ["finally runs when a loop breaks out of the try", `
    function f() { let log = 0; for (let i = 0; i < 5; i = i + 1) { try { if (i === 2) { break; } log = log + i; } finally { log = log + 10; } } return log; }
    function main() { return f(); }`],                                                                  // i0:+0+10, i1:+1+10, i2:break+10 -> 31
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: [] });
  return rt.run({ id: "t" }, initialFrames("main", []), { deref: (x) => x }).value;
}
function native(src) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(compileModuleToWasm(src, { entry: "main", resources: [] })), { env: {} });
  const dv = new DataView(inst.exports.memory.buffer);
  dv.setInt32(BUMP_ADDR, HEAP_BASE, true);
  const r = inst.exports.main();
  return dv.getInt32(0, true) ? "<uncaught>" : readValue(inst.exports.memory, r); // EXC_FLAG at addr 0 set => uncaught
}

const results = [];
for (const [name, src] of programs) {
  const i = interp(src), n = native(src);
  const ok = Object.is(i, n);
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: interpreter ${JSON.stringify(i)} == native ${JSON.stringify(n)}`);
}
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs try/catch/throw and try/finally (same-function and across calls) and matches the interpreter`);
process.exit(ok ? 0 : 1);

// Probe: language coverage of the tier-splitting compiler (transform.cjs).
//
// A suspendable function is lowered to a serializable state machine whose locals live on an
// explicit frame F. Several ordinary JS binding forms don't map onto F directly — for-of/for-in
// loop variables, destructuring declarations, and non-simple parameters (defaults, patterns,
// rest). The transform now DESUGARS each into the simple `F.x = expr` forms the machine handles,
// so plain code compiles and migrates. This probe drives each supported form to completion while
// JSON-round-tripping the whole continuation at EVERY suspension — if a form didn't reduce to
// plain frame data, the round-trip would corrupt it and the result would be wrong.
//
// The dual claim: forms that genuinely CAN'T migrate — a tier call inside a callback/comparator
// (invoked synchronously by native code that can't suspend) or an object/class method (never a
// top-level program) — must fail with a CLEAR compile error, not a silent miscompile. Those are
// asserted to throw.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TX = fileURLToPath(new URL("../../src/transform.cjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "langcov-"));
let n = 0, pass = 0, fail = 0;
const check = (label, cond, got) => { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}${got === undefined ? "" : `  (got ${JSON.stringify(got)})`}`); } };

function compile(src, flags = ["--bare"]) {
  const inF = join(dir, `s${n}.src.js`), outF = join(dir, `s${n++}.gen.mjs`);
  writeFileSync(inF, src);
  try { execFileSync(process.execPath, [TX, inF, outF, ...flags], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] }); }
  catch (e) { const err = new Error("compile failed"); err.stderr = (e.stderr || "").toString(); throw err; }
  return outF;
}

// The mock resource layer. Return values become part of the continuation.
const service = (name, args) => {
  const [x, y] = args;
  switch (name) {
    case "api.get": return x;
    case "api.dbl": return x * 2;
    case "api.cmp": return x - y;
    case "api.pair": return { a: 1, b: 2 };
    case "api.obj": return { a: 1, b: 2, c: 3, d: 4 };
    case "api.arr": return [10, 20, 30];
    case "api.pairs": return [["k1", 1], ["k2", 2]];
    case "api.set": return new Set(["p", "q"]);
    default: return null;
  }
};

// Drive a compiled bundle to completion. At every suspension the whole frame stack is put through
// JSON — a stand-in for the wire — so a bundle that parked a non-serializable value (a closure, a
// native cursor) would come back wrong. Returns the final value and the ordered resource calls.
function drive(mod, entry, args = [], migrate = true) {
  const calls = [];
  let stack = [{ fn: entry, pc: 0, args }];
  for (let steps = 0; steps < 100000; steps++) {
    const top = stack[stack.length - 1];
    const r = mod.PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { value: r.value, calls }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (r.op === "throw") { throw r.value; }
    else if (r.op === "resource") {
      calls.push(r.name);
      if (migrate) stack = JSON.parse(JSON.stringify(stack));    // MIGRATE: the continuation is plain data (skipped when a frame holds a live closure — unserializable regardless of tiering)
      stack[stack.length - 1].ret = service(r.name, r.args);
    }
  }
  throw new Error("did not terminate");
}

async function supported(label, src, entry, expect, args = []) {
  let mod;
  try { mod = await import(pathToFileURL(compile(src)).href); }
  catch (e) { check(label, false, "COMPILE ERROR: " + (e.stderr || e.message).split("\n").find((l) => l.includes("Error")) || "?"); return; }
  try { const { value } = drive(mod, entry, args); check(`${label} -> ${JSON.stringify(expect)}`, JSON.stringify(value) === JSON.stringify(expect), value); }
  catch (e) { check(label, false, "RUNTIME: " + e.message); }
}

function declined(label, src, needle) {
  try { compile(src); check(`${label} (should be rejected)`, false, "compiled without error"); }
  catch (e) { const msg = (e.stderr || "").includes(needle) && (e.stderr || "").includes("not supported"); check(`${label} -> clear error`, msg, msg ? undefined : (e.stderr || "").split("\n").filter(Boolean).slice(-2).join(" ⏎ ")); }
}

// Oracle for optional-chaining: run the SAME source as plain JS with a native `api` (api.get
// echoes its arg and records the call). The compiled+migrated result must match both the value
// AND the exact call sequence — so a tier call correctly SKIPPED on short-circuit is proven, not
// just the happy path, and `this`-binding is checked by the value.
function oracle(src, entry) {
  const calls = [];
  const api = { get: (x) => { calls.push("api.get"); return x; } };
  return { value: new Function("api", `${src}\nreturn ${entry}();`)(api), calls };
}
async function optchain(label, src, entry, migrate = true) {
  const exp = oracle(src, entry);
  let mod;
  try { mod = await import(pathToFileURL(compile(src)).href); }
  catch (e) { check(label, false, "COMPILE: " + ((e.stderr || e.message).split("\n").find((l) => l.includes("Error")) || "?")); return; }
  try {
    const got = drive(mod, entry, [], migrate);
    const ok = JSON.stringify(got.value) === JSON.stringify(exp.value) && JSON.stringify(got.calls) === JSON.stringify(exp.calls);
    check(`${label} -> ${JSON.stringify(exp.value)} calls=${JSON.stringify(exp.calls)}`, ok, ok ? undefined : `compiled ${JSON.stringify(got.value)}/${JSON.stringify(got.calls)}`);
  } catch (e) { check(label, false, "RUNTIME: " + e.message); }
}

console.log("Probe: language coverage — non-trivial binding forms desugar and migrate; un-migratable forms are rejected\n");

console.log("supported forms (each driven across a JSON round-trip of the continuation at every suspension):");
// for-of / for-in
await supported("for-of over a literal, body suspends", "function A(){ let s = 0; for (const x of [1,2,3]) { const y = api.dbl(x); s = s + y; } return s; }", "A", 12);
await supported("for-of over a suspendable iterable", "function A(){ let s = 0; for (const v of api.arr()) { s = s + v; } return s; }", "A", 60);
await supported("for-of with a destructuring loop var", "function A(){ let s = 0; for (const [k, v] of api.pairs()) { const d = api.dbl(v); s = s + d; } return s; }", "A", 6);
await supported("for-of with continue + break around a suspension", "function A(){ let s = 0; for (const x of [1,2,3,4,5]) { if (x === 2) continue; if (x === 5) break; const y = api.get(x); s = s + y; } return s; }", "A", 8);
await supported("nested for-of (both bodies suspend)", "function A(){ let s = 0; for (const i of [1,2]) { for (const j of [10,20]) { const y = api.get(i * j); s = s + y; } } return s; }", "A", 90);
await supported("for-in over an object, body suspends", "function A(){ let s = 0; const o = { a: 3, b: 4 }; for (const k in o) { const y = api.dbl(o[k]); s = s + y; } return s; }", "A", 14);
await supported("labeled for-of with continue <label>", "function A(){ let s = 0; outer: for (const i of [1,2,3]) { for (const j of [1,2]) { if (i === 2) continue outer; const y = api.get(i * j); s = s + y; } } return s; }", "A", 12);
// destructuring declarations
await supported("object destructuring of a suspendable result", "function A(){ const { a, b } = api.pair(); return a + b; }", "A", 3);
await supported("array destructuring of a suspendable result", "function A(){ const [x, y] = api.arr(); return x + y; }", "A", 30);
await supported("nested destructuring", "function A(){ const { a, b } = api.pair(); const [p, q] = api.arr(); return a + b + p + q; }", "A", 33);
await supported("many-key destructure, extracted locals cross a later migration", "function A(){ const { a, b, c, d } = api.obj(); const s = api.get(a + b + c + d); return s; }", "A", 10);
await supported("array destructure, extracted locals cross a later migration", "function A(){ const [x, y, z] = api.arr(); const s = api.get(x + y + z); return s; }", "A", 60);
await supported("destructuring with default + rest", "function A(){ const { a, z = 7, ...rest } = api.obj(); return a + z + rest.b + rest.c + rest.d; }", "A", 17);
await supported("array destructuring of a NON-array iterable (Array.from guard)", "function A(){ const [a, b] = api.set(); return a + '|' + b; }", "A", "p|q");
await supported("object destructuring with string-literal keys + array elision", 'function A(){ const { "a": first, "b": second } = api.obj(); const [, mid] = api.arr(); return first + second + mid; }', "A", 23);
// non-simple params
await supported("default parameter that suspends", "function A(x = api.get(5)){ return x + 1; } function B(){ const r = A(); return r; }", "B", 6);
await supported("destructured parameter", "function A({ a, b }){ return a * b; } function B(){ const o = api.pair(); const r = A(o); return r; }", "B", 2);
await supported("rest parameter", "function A(a, ...xs){ return a + xs.length; } function B(){ const r = A(api.get(9), 1, 2, 3); return r; }", "B", 12);

console.log("\noptional-chain conditional suspensions (compiled result checked vs a native-JS oracle — value AND call sequence, so short-circuit skipping the tier call is verified):");
await optchain("obj?.[api.f()] — receiver present", 'function A(){ const o = { b: 42 }; const r = o?.[api.get("b")]; return r; }', "A");
await optchain("obj?.[api.f()] — receiver null (skip)", 'function A(){ const o = null; const r = o?.[api.get("b")]; return r; }', "A");
// optional-CALL forms hold a callee/receiver (a function) on the frame across the suspension — a live
// closure is unserializable regardless of tiering, so drive without the round-trip; the oracle still
// pins value + call order + this-binding + short-circuit.
await optchain("fn?.(api.f()) — present", "function A(){ const f = (x) => x + 1; const r = f?.(api.get(5)); return r; }", "A", false);
await optchain("fn?.(api.f()) — null (skip)", "function A(){ const f = null; const r = f?.(api.get(5)); return r; }", "A", false);
await optchain("obj.m?.(api.f()) — this preserved via .call", "function A(){ const o = { tag: 7, m(x){ return this.tag + x; } }; const r = o.m?.(api.get(5)); return r; }", "A", false);
await optchain("obj?.m(api.f()) — optional member, method call", "function A(){ const o = { tag: 7, m(x){ return this.tag + x; } }; const r = o?.m(api.get(5)); return r; }", "A", false);
await optchain("obj?.m(api.f()) — receiver null (skip)", "function A(){ const o = null; const r = o?.m(api.get(5)); return r; }", "A", false);
await optchain("a?.b[api.f()] — suspension downstream of ?.", 'function A(){ const o = { b: { c: 3 } }; const r = o?.b[api.get("c")]; return r; }', "A");
await optchain("a?.b[api.f()] — null (skip whole rest)", 'function A(){ const o = null; const r = o?.b[api.get("c")]; return r; }', "A");
await optchain("a?.b?.[api.f()] — multi-?., both present", 'function A(){ const o = { b: { c: 9 } }; const r = o?.b?.[api.get("c")]; return r; }', "A");
await optchain("a?.b?.[api.f()] — middle null (skip)", 'function A(){ const o = { b: null }; const r = o?.b?.[api.get("c")]; return r; }', "A");
await optchain("(obj?.[api.f()]) ?? default — null coalesces", 'function A(){ const o = null; const r = o?.[api.get("x")] ?? 99; return r; }', "A");
await optchain("optional-chain in return position", 'function A(){ const o = { b: 8 }; return o?.[api.get("b")]; }', "A");
await optchain("optional-chain in an if-test", 'function A(){ const o = { b: 1 }; if (o?.[api.get("b")]) { return "hit"; } return "miss"; }', "A");
await optchain("optional-chain in a while-test", 'function A(){ let n = 0; const o = { go: true }; while (o?.[api.get("go")] && n < 3) { n = n + 1; } return n; }', "A");
await optchain("non-suspending optional chain stays native, later suspension", 'function A(){ const o = { p: 5 }; const r = o?.p; const s = api.get(r + 1); return s; }', "A");
await optchain("optional-chain value crosses a later migration", 'function A(){ const o = { b: 5 }; const t = o?.[api.get("b")]; const u = api.get(t + 1); return u; }', "A");

console.log("\nun-migratable forms (must fail with a clear compile error, not silently miscompile):");
declined("tier call inside a .map callback", "function A(){ const out = [1,2,3].map(i => api.dbl(i)); return out[0]; }", "nested function");
declined("tier call inside a sort comparator", "function A(){ const a = [3,1,2]; a.sort((x, y) => api.cmp(x, y)); return a[0]; }", "nested function");
declined("tier call inside an object method", "const obj = { m(){ const v = api.get(5); return v; } }; function A(){ return obj.m(); }", "object/class method");

console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass}/${pass + fail} checks passed`);
console.log(fail === 0
  ? "language coverage: for-of/for-in, destructuring, and non-simple params desugar and migrate correctly; un-migratable tier calls are rejected with a clear error"
  : "language coverage: FAILURES above");
process.exit(fail === 0 ? 0 : 1);

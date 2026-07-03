// Probe: mix modules authored in TypeScript (app.src.ts instead of app.src.js).
//
// transform.cjs detects a .ts/.mts filename and strips TypeScript syntax to whitespace
// (node:module's stripTypeScriptTypes, mode:"strip") BEFORE parsing — so the rest of the
// compiler (allow-list rewrite, suspendability analysis, CPS lowering, codegen) sees plain
// JS text and needs no TS-awareness at all. Whitespace-replacement (not deletion) preserves
// every line/column, so a genuinely suspendable function with typed params still compiles to
// a correct state machine and RUNS end to end — proven here by actually driving the compiled
// bundle through a pump with mock resources, not just checking that it compiles.
//
// Scope is the erasable TS subset only — the same ceiling as `node --experimental-strip-types`
// and every .mts file elsewhere in this repo. A non-erasable construct (an enum with a runtime
// body) must fail with a clear error, not a silent miscompile or a confusing parse crash.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeCounter } from "../lib/check.mjs";

const TX = fileURLToPath(new URL("../../packages/tierless/src/transform.cjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ts-mix-"));
let n = 0;
const { check, counts } = makeCounter();

function build(src, ext = "ts", flags = ["--bare"]) {
  const inF = join(dir, `s${n}.src.${ext}`), outF = join(dir, `s${n++}.gen.mjs`);
  writeFileSync(inF, src);
  return { inF, outF, run: (extra = []) => execFileSync(process.execPath, [TX, inF, outF, ...flags, ...extra], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }) };
}

// Drive a compiled bundle to completion, JSON-round-tripping the continuation at every
// suspension (a stand-in for the wire) — proves a typed local still reduces to plain frame data.
function drive(mod, entry, args, service) {
  let stack = [{ fn: entry, pc: 0, args }];
  for (let steps = 0; steps < 10000; steps++) {
    const top = stack[stack.length - 1];
    const r = mod.PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return r.value; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (r.op === "resource") { stack = JSON.parse(JSON.stringify(stack)); stack[stack.length - 1].ret = service(r.name, r.args); }
    else throw new Error("unexpected op " + r.op);
  }
  throw new Error("did not terminate");
}

console.log("Probe: TypeScript mix modules (.src.ts) — strip, compile, run\n");

// --- a genuinely suspendable function with typed params/return, a default, and an `as` cast ---
{
  const src = `
interface Order { id: number; total: number }

function tax(amount: number, rate: number = 0.08): number {
  return amount * rate;
}

export function checkout(orderId: number): number {
  const order = api.getOrder(orderId) as Order;
  const total: number = order.total + tax(order.total);
  return total;
}
`;
  const { inF, outF, run } = build(src);
  try {
    run();
    const mod = await import(pathToFileURL(outF).href);
    const service = (name, args) => (name === "api.getOrder" ? { id: args[0], total: 100 } : null);
    const value = drive(mod, "checkout", [7], service);
    check("typed suspendable function compiles and RUNS (interface, param/return types, default, `as` cast)", value === 108, value);
  } catch (e) {
    check("typed suspendable function compiles and RUNS", false, (e.stderr || e.message || "").toString().split("\n").slice(0, 3).join(" ⏎ "));
  }
  void inF;
}

// --- .mts extension is accepted too (not just .ts) ---
{
  const src = `export function double(n: number): number { return n * 2; }`;
  const { outF, run } = build(src, "mts");
  try {
    run();
    const mod = await import(pathToFileURL(outF).href);
    check(".mts extension also strips (pure helper, emitted verbatim)", mod.double(21) === 42, mod.double(21));
  } catch (e) {
    check(".mts extension also strips", false, (e.stderr || e.message || "").toString().split("\n")[0]);
  }
}

// --- `tierless explain` (analyze()) on a .ts file: its own independent parse must strip too ---
{
  const src = `
function pure(x: number): number { return x + 1; }
export function withResource(id: number): unknown {
  return api.get(id);
}
`;
  const { inF } = build(src);
  try {
    const out = execFileSync(process.execPath, [
      fileURLToPath(new URL("../../packages/tierless/bin/tierless.mjs", import.meta.url)),
      "explain", inF, "--json",
    ], { cwd: ROOT, encoding: "utf8" });
    const rep = JSON.parse(out);
    const withResource = rep.functions.find((f) => f.name === "withResource");
    const pure = rep.functions.find((f) => f.name === "pure");
    check("`tierless explain` on .ts: withResource is suspendable (touches api.get)", !!withResource?.suspendable, withResource);
    check("`tierless explain` on .ts: pure is NOT suspendable", pure && !pure.suspendable, pure);
  } catch (e) {
    check("`tierless explain` on .ts", false, (e.stderr || e.message || "").toString().split("\n")[0]);
  }
}

// --- non-erasable TS (a real runtime enum) must fail with a CLEAR error, not a silent miscompile ---
{
  const src = `
enum Status { Open, Closed }
export function f(): Status { return Status.Open; }
`;
  const { run } = build(src);
  try {
    run();
    check("non-erasable TS (enum) is rejected, not silently miscompiled", false, "compiled without error");
  } catch (e) {
    const stderr = (e.stderr || "").toString();
    check("non-erasable TS (enum) is rejected with a clear error", stderr.includes("enum") && stderr.includes("not supported"), stderr.split("\n").filter(Boolean).slice(-2).join(" ⏎ "));
  }
}

// --- plain .js is completely unaffected (no TS detection, no stripping attempted) ---
{
  const src = `export function plain(x) { return x + 1; }`;
  const { outF, run } = build(src, "js");
  try {
    run();
    const mod = await import(pathToFileURL(outF).href);
    check("plain .js is unaffected by TS detection", mod.plain(1) === 2, mod.plain(1));
  } catch (e) {
    check("plain .js is unaffected by TS detection", false, (e.stderr || e.message || "").toString().split("\n")[0]);
  }
}

const { pass, fail } = counts();
console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass}/${pass + fail} checks passed`);
console.log(fail === 0
  ? "TypeScript mix modules: .src.ts/.mts strip to plain JS before parsing and compile+run identically to .src.js; a non-erasable construct is rejected with a clear error; plain .js is unaffected"
  : "TypeScript mix modules: FAILURES above");
process.exit(fail === 0 ? 0 : 1);

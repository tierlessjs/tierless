// Waso multi-module conformance — an import graph compiled into one program.
//
// Modules are namespaced (the entry keeps "" so its entry fn name is stable); imports
// resolve through the TS type checker to the exporting module's namespaced global, and
// module inits run in dependency order. The headline check: the SAME object graph that
// crosses module boundaries also survives continuation migration — a tierless program
// is one program no matter how many files it spans.

import { PROGRAM, run, Suspend, serializeContinuation, deserializeContinuation, initialFrames, awaitable } from "./waso-core.mjs";
import { compileProgram, loadModule } from "./waso-tsc.mjs";

let pass = 0, fail = 0; const fails = [];
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? "B:" + v.toString() : v === undefined ? "U" : v));
function load(files, entryFile, resources = []) { for (const k in PROGRAM) delete PROGRAM[k]; const frag = compileProgram(new Map(Object.entries(files)), { entry: "go", entryFile, resources }); for (const [k, v] of Object.entries(frag)) PROGRAM[k] = v; }
function t(name, files, entryFile, expect) {
  let got, err = null;
  try { load(files, entryFile); got = run({ id: "t" }, initialFrames("go", []), { deref: (x) => x }).value; } catch (e) { err = e; }
  const ok = !err && J(got) === J(expect);
  if (ok) pass++; else { fail++; fails.push(name); console.log(`  FAIL  ${name}`); console.log(`        waso=${err ? "threw " + (err.message || "") : J(got)}  expect=${J(expect)}`); }
}
// migrate: run the entry through a serialize/resume loop at every ckpt
async function tm(name, files, entryFile, expect) {
  let got, err = null;
  try {
    load(files, entryFile, ["ckpt"]);
    const tier = { id: "client", has: (n) => n === "ckpt", resources: { ckpt: (a) => awaitable({ v: a[0] }) } };
    let frames = initialFrames("go", []); const host = { deref: (x) => x };
    while (true) {
      let res; try { res = run(tier, frames, host); } catch (e) {
        if (!(e instanceof Suspend)) throw e;
        const g = deserializeContinuation(JSON.parse(JSON.stringify(serializeContinuation({ frames: e.frames, pending: e.pending }, tier))));
        g.frames[g.frames.length - 1].stack.push(g.pending.await.v); frames = g.frames; continue;
      }
      got = res.value; break;
    }
  } catch (e) { err = e; }
  const ok = !err && J(got) === J(expect);
  if (ok) pass++; else { fail++; fails.push(name); console.log(`  FAIL  ${name}`); console.log(`        waso=${err ? "threw " + (err.message || "") : J(got)}  expect=${J(expect)}`); }
}

console.log("Waso multi-module: imports, namespacing, dependency-ordered init, migration\n");

t("named function imports", {
  "/math.ts": `export function add(a,b){ return a+b; } export function mul(a,b){ return a*b; }`,
  "/main.ts": `import { add, mul } from "./math"; function go(){ return [add(2,3), mul(4,5)]; }`,
}, "/main.ts", [5, 20]);

t("class import: new + method + instanceof", {
  "/models.ts": `export class User { constructor(n){ this.name=n; } greet(){ return "hi "+this.name; } }`,
  "/main.ts": `import { User } from "./models"; function go(){ const u=new User("Ada"); return [u.greet(), u instanceof User]; }`,
}, "/main.ts", ["hi Ada", true]);

t("const/array imports + module init", {
  "/config.ts": `export const VERSION="1.2.3"; export const tags=["a","b"];`,
  "/main.ts": `import { VERSION, tags } from "./config"; function go(){ return [VERSION, tags.length, tags[0]]; }`,
}, "/main.ts", ["1.2.3", 2, "a"]);

t("transitive imports run init in dependency order", {
  "/c.ts": `export const base=10;`,
  "/b.ts": `import { base } from "./c"; export function scaled(x){ return x*base; }`,
  "/a.ts": `import { scaled } from "./b"; function go(){ return scaled(5); }`,
}, "/a.ts", 50);

t("same top-level name in two modules doesn't collide", {
  "/x.ts": `export function name(){ return "x"; } export const v=1;`,
  "/y.ts": `export function name(){ return "y"; } export const v=2;`,
  "/main.ts": `import { name as nx, v as vx } from "./x"; import { name as ny, v as vy } from "./y"; function go(){ return [nx(), ny(), vx, vy]; }`,
}, "/main.ts", ["x", "y", 1, 2]);

t("cross-module class inheritance", {
  "/base.ts": `export class Animal { constructor(n){ this.n=n; } speak(){ return this.n+" makes a sound"; } }`,
  "/main.ts": `import { Animal } from "./base"; class Dog extends Animal { speak(){ return super.speak()+" (woof)"; } } function go(){ const d=new Dog("Rex"); return [d.speak(), d instanceof Animal, d instanceof Dog]; }`,
}, "/main.ts", ["Rex makes a sound (woof)", true, true]);

t("cross-module type-based DI via design:paramtypes", {
  "/logger.ts": `export function Injectable(c){} @Injectable export class Logger { log(){ return "logged"; } }`,
  "/repo.ts": `import { Logger } from "./logger"; export function Injectable(c){} @Injectable export class Repo { constructor(l: Logger){ this.l=l; } find(){ return this.l.log()+":data"; } }`,
  "/main.ts": `import { Repo } from "./repo"; function resolve(C){ const pts=Reflect.getMetadata("design:paramtypes",C)||[]; return new C(...pts.map(resolve)); } function go(){ return resolve(Repo).find(); }`,
}, "/main.ts", "logged:data");

t("imported higher-order + shared mutable module state", {
  "/store.ts": `let count=0; export function bump(){ return ++count; } export function total(){ return count; }`,
  "/main.ts": `import { bump, total } from "./store"; function go(){ bump(); bump(); bump(); return total(); }`,
}, "/main.ts", 3);

await (async () => {
  console.log("\n— a multi-module program migrates as one —");
  await tm("imported class instance survives the wire", {
    "/acct.ts": `export class Account { constructor(b){ this.bal=b; } deposit(n){ this.bal+=n; return this.bal; } }`,
    "/main.ts": `import { Account } from "./acct"; async function go(){ const a=new Account(100); a.deposit(await ckpt(50)); await ckpt(0); return [a.deposit(25), a instanceof Account]; }`,
  }, "/main.ts", [175, true]);

  await tm("cross-module state + closures across a checkpoint", {
    "/counter.ts": `let n=0; export function inc(){ return ++n; } export function get(){ return n; }`,
    "/main.ts": `import { inc, get } from "./counter"; async function go(){ inc(); const a=await ckpt(get()); inc(); inc(); return [a, get()]; }`,
  }, "/main.ts", [1, 3]);

  await tm("cross-module DI graph migrates mid-request", {
    "/dep.ts": `export function Injectable(c){} @Injectable export class Clock { now(){ return 42; } }`,
    "/main.ts": `import { Clock } from "./dep"; function Injectable(c){} @Injectable class Handler { constructor(c: Clock){ this.c=c; } async handle(){ const t=await ckpt(this.c.now()); return "t="+t; } } function resolve(C){ const pts=Reflect.getMetadata("design:paramtypes",C)||[]; return new C(...pts.map(resolve)); } async function go(){ return resolve(Handler).handle(); }`,
  }, "/main.ts", "t=42");
})();

// Loading a NEW module into a tier that already ran code must re-run the new module's
// top-level init. A flat boolean __minit latched after the first run and silently skipped
// it, so the second module's top-level bindings were never initialized (returned undefined).
(() => {
  for (const k in PROGRAM) delete PROGRAM[k];
  const tier = { id: "reuse" }; const host = { deref: (x) => x };
  loadModule(PROGRAM, `let x = 1; function go(){ return x; }`, { entry: "go" });
  const first = run(tier, initialFrames("go", []), host).value;                   // 1 — first module's init ran
  loadModule(PROGRAM, `let y = 100; function go(){ return y; }`, { entry: "go" }); // overwrites %moduleinit on the SAME tier
  let second, err = null;
  try { second = run(tier, initialFrames("go", []), host).value; } catch (e) { err = e; }
  const ok = !err && first === 1 && second === 100;
  if (ok) pass++; else { fail++; fails.push("tier reuse re-runs a newly loaded module's init"); console.log(`  FAIL  tier reuse re-runs a newly loaded module's init`); console.log(`        first=${first} second=${err ? "threw " + err.message : second}  expect 1 then 100`); }
})();

console.log(`\n${"=".repeat(64)}`);
console.log(`Result: ${fail === 0 ? "ALL PASS" : fails.length + " FAILED"} — ${pass} multi-module checks${fail ? " ; failures: " + fails.join(", ") : ""}.`);
if (fail) process.exitCode = 1;

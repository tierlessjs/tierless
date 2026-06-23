// Waso decorator conformance — legacy/experimental class decorators (the flavor
// Nest/Angular use). Node can't run decorator syntax in plain JS, so the reference
// is the TS compiler's own `experimentalDecorators` transpile, run in Node. Every
// case asserts Waso computes what the canonical lowering computes.
//
// Scope: CLASS decorators — run at module load, bottom-up, with the class object as
// the target; a non-null return rebinds the class. This is the backbone of framework
// registration (@Injectable/@Component/@Module/@Entity). Method/property/parameter
// decorators and emitDecoratorMetadata (design:type, for DI) are the next steps —
// they need a shared-prototype method model and the TS type checker, respectively.

import { PROGRAM, run, initialFrames } from "./waso-core.mjs";
import { loadModule } from "./waso-tsc.mjs";
import ts from "typescript";

let pass = 0, fail = 0; const fails = [];
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? "B:" + v.toString() : v === undefined ? "U" : v));
const refRun = (src) => { const out = ts.transpileModule(src + "\n;", { compilerOptions: { experimentalDecorators: true, target: ts.ScriptTarget.ES2020 } }); return new Function(out.outputText + "\n;return go;")()(); };

function d(name, src) {
  let got, ref, ge = null, re = null;
  for (const k in PROGRAM) delete PROGRAM[k];
  try { loadModule(PROGRAM, src, { entry: "go" }); got = run({ id: "t" }, initialFrames("go", []), { deref: (x) => x }).value; } catch (e) { ge = e; }
  try { ref = refRun(src); } catch (e) { re = e; }
  const ok = re ? !!ge : (!ge && J(got) === J(ref));
  if (ok) pass++; else { fail++; fails.push(name); console.log(`  FAIL  ${name}`); console.log(`        waso=${ge ? "threw " + (ge.message || "") : J(got)}  ref=${re ? "threw" : J(ref)}`); }
}

console.log("Waso decorator conformance — legacy class decorators vs TS transpile\n");

d("registration decorator runs at load", `const registry=[]; function Injectable(c){ registry.push(c.id); } @Injectable class Svc { static id='Svc'; } function go(){ return [registry, new Svc() instanceof Svc]; }`);
d("decorator factory with options", `const meta=[]; function Component(opts){ return function(c){ meta.push(opts.selector); }; } @Component({selector:'app'}) class App {} function go(){ return meta; }`);
d("decorator mutates the class object", `function Stamp(c){ c.stamped=true; } @Stamp class W { static stamped=false; } function go(){ return W.stamped; }`);
d("decorator returns a replacement (affects ClassName refs)", `function Tagged(c){ c.kind='tagged'; return c; } @Tagged class T { static kind='plain'; } function go(){ return T.kind; }`);
d("multiple decorators apply bottom-up", `const order=[]; function a(c){order.push('a');} function b(c){order.push('b');} function cc(c){order.push('c');} @a @b @cc class C {} function go(){ return order; }`);
d("decorator reads a static method", `const out=[]; function Reg(c){ out.push(c.label()); } @Reg class M { static label(){ return 'M!'; } } function go(){ return out; }`);
d("decorated class still instantiates with fields/methods", `function Note(c){ c.noted=true; } @Note class Box { constructor(v){ this.v=v; } get(){ return this.v*2; } } function go(){ const b=new Box(5); return [Box.noted, b.get(), b.v]; }`);
d("decorator factory closing over state", `let n=0; function Id(){ const id=++n; return function(c){ c.uid=id; }; } @Id() class A{} @Id() class B{} function go(){ return [A.uid, B.uid]; }`);
d("registration order across classes", `const seen=[]; function R(c){ seen.push(c.t); } @R class X{ static t='X'; } @R class Y{ static t='Y'; } function go(){ return seen; }`);
d("decorated class extending a base", `function D(c){ c.dec=true; } class Base{ who(){ return 'base'; } } @D class Sub extends Base{ who(){ return super.who()+'/sub'; } } function go(){ return [Sub.dec, new Sub().who()]; }`);

console.log(`\n${"=".repeat(64)}`);
console.log(`Result: ${fail === 0 ? "ALL PASS" : fails.length + " FAILED"} — ${pass} checks vs TS-transpiled reference${fail ? " ; failures: " + fails.join(", ") : ""}.`);
if (fail) process.exitCode = 1;

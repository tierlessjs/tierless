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

import { PROGRAM, run, initialFrames, Suspend, serializeContinuation, deserializeContinuation, awaitable } from "./waso-core.mjs";
import { loadModule } from "./waso-tsc.mjs";
import ts from "typescript";

let pass = 0, fail = 0; const fails = [];
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? "B:" + v.toString() : v === undefined ? "U" : v));
// Minimal reflect-metadata shim for the reference (bare Node Reflect has no
// defineMetadata) so metadata-using decorators validate against the same store model.
const metaWM = new WeakMap();
const RShim = Object.assign(Object.create(Reflect), {
  defineMetadata(mk, mv, t, pk) { let m = metaWM.get(t); if (!m) metaWM.set(t, (m = new Map())); let pm = m.get(pk); if (!pm) m.set(pk, (pm = new Map())); pm.set(mk, mv); },
  getMetadata(mk, t, pk) { const pm = metaWM.get(t) && metaWM.get(t).get(pk); return pm ? pm.get(mk) : undefined; },
  getOwnMetadata(mk, t, pk) { const pm = metaWM.get(t) && metaWM.get(t).get(pk); return pm ? pm.get(mk) : undefined; },
  hasMetadata(mk, t, pk) { const pm = metaWM.get(t) && metaWM.get(t).get(pk); return !!(pm && pm.has(mk)); },
  getMetadataKeys(t, pk) { const pm = metaWM.get(t) && metaWM.get(t).get(pk); return pm ? [...pm.keys()] : []; },
});
const refRun = (src) => { const out = ts.transpileModule(src + "\n;", { compilerOptions: { experimentalDecorators: true, target: ts.ScriptTarget.ES2020 } }); return new Function("Reflect", out.outputText + "\n;return go;")(RShim)(); };

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

console.log("\n— method / property / parameter decorators —");
d("method decorator wraps the method", `const calls=[]; function log(t,k,d){ const o=d.value; d.value=function(...a){ calls.push(k); return o.apply(this,a); }; } class S{ greet(n){ return 'hi '+n; } } S.prototype; class S2{ @log greet(n){ return 'hi '+n; } } function go(){ const s=new S2(); return [s.greet('x'),calls]; }`);
d("method decorator preserves this", `function dbl(t,k,d){ const o=d.value; d.value=function(...a){ return o.apply(this,a)*2; }; } class C{ constructor(n){this.n=n;} @dbl val(){ return this.n; } } function go(){ return new C(7).val(); }`);
d("method decorator returns a replacement descriptor", `function fixed(t,k,d){ return {value:function(){return 'fixed';}}; } class C{ @fixed m(){ return 'orig'; } } function go(){ return new C().m(); }`);
d("two method decorators compose bottom-up", `const order=[]; function a(t,k,d){ const o=d.value; d.value=function(...x){order.push('a');return o.apply(this,x);}; } function b(t,k,d){ const o=d.value; d.value=function(...x){order.push('b');return o.apply(this,x);}; } class C{ @a @b m(){return 1;} } function go(){ new C().m(); return order; }`);
d("static method decorator replaces on the class", `const seen=[]; function trace(t,k,d){ const o=d.value; d.value=function(...a){ seen.push(k); return o.apply(this,a); }; } class C{ @trace static build(){ return 'built'; } } function go(){ return [C.build(),seen]; }`);
d("property decorator runs for each field", `const props=[]; function track(t,k){ props.push(k); } class M{ @track name='x'; @track age=1; m(){return this.name;} } function go(){ const o=new M(); return [props, o.m()]; }`);
d("parameter decorator records position", `const params=[]; function Inject(t,k,i){ params.push(i); } class S{ m(@Inject a, b, @Inject c){} } function go(){ new S(); return params.sort((x,y)=>x-y); }`);
d("method decorator stores route metadata", `function Get(path){ return function(t,k,d){ Reflect.defineMetadata('path',path,t,k); }; } class Ctrl{ @Get('/users') list(){ return []; } @Get('/users/:id') one(){ return {}; } } function go(){ const p=Ctrl.prototype; return [Reflect.getMetadata('path',p,'list'),Reflect.getMetadata('path',p,'one')]; }`);
d("decorated method works across instances (shared, dynamic this)", `function tag(t,k,d){ const o=d.value; d.value=function(...a){ return '['+o.apply(this,a)+']'; }; } class N{ constructor(v){this.v=v;} @tag show(){ return this.v; } } function go(){ return [new N(1).show(), new N(2).show()]; }`);

// A decorated-method program frozen to bytes and resumed mid-flight must still
// produce the canonical result — the shared decorated closure and metadata travel.
async function wmig(name, src) {
  let ref; try { ref = await refRun(src.replace(/await ckpt\((.*?)\)/g, "$1")); } catch { ref = undefined; } // reference: same program, ckpt as identity, awaited
  let got, err = null;
  for (const k in PROGRAM) delete PROGRAM[k];
  try {
    loadModule(PROGRAM, src, { entry: "go", resources: ["ckpt"] });
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
  const ok = !err && J(got) === J(ref);
  if (ok) pass++; else { fail++; fails.push(name); console.log(`  FAIL  ${name}`); console.log(`        waso=${err ? "threw " + (err.message || "") : J(got)}  ref=${J(ref)}`); }
}

await (async () => {
  console.log("\n— decorators survive continuation migration —");
  await wmig("decorated method survives the wire", `function tag(t,k,d){ const o=d.value; d.value=function(...a){ return '['+o.apply(this,a)+']'; }; } class N{ constructor(v){this.v=v;} @tag show(){ return this.v; } } async function go(){ const n=new N(7); const a=n.show(); await ckpt(0); return [a, n.show()]; }`);
  await wmig("route metadata survives the wire", `function Get(p){ return function(t,k,d){ Reflect.defineMetadata('path',p,t,k); }; } class Ctrl{ @Get('/x') h(){ return 1; } } async function go(){ const p=Ctrl.prototype; const before=Reflect.getMetadata('path',p,'h'); await ckpt(0); return [before, Reflect.getMetadata('path',p,'h')]; }`);
})();

console.log(`\n${"=".repeat(64)}`);
console.log(`Result: ${fail === 0 ? "ALL PASS" : fails.length + " FAILED"} — ${pass} checks vs TS-transpiled reference${fail ? " ; failures: " + fails.join(", ") : ""}.`);
if (fail) process.exitCode = 1;

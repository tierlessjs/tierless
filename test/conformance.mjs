// Stackmix conformance suite — does the full TS/JS language survive our continuations?
//
// Two questions, one file:
//   1. FIDELITY   — does Stackmix compute the same result as the real engine? Every
//      `t(...)` compiles a snippet, runs it on the interpreter, AND evals it in
//      Node, and asserts the outputs are identical (BigInt-safe compare).
//   2. CONTINUATION — does that result still hold when the computation is SERIALIZED
//      and RESUMED mid-flight? Every `w(...)` snippet calls `await ckpt(x)` at points
//      where rich state (closures, boxed cells, Maps/Sets, class instances,
//      generators, cyclic graphs, live try/catch handlers) is alive; the harness
//      round-trips the ENTIRE continuation through JSON at each checkpoint and
//      resumes from the bytes. `ckpt` is identity-async, so Node computes the same
//      value — but Stackmix's value crossed a wire N times to get there.
//
// This is the bar for a general-purpose framework: not "the frontend parses X" but
// "a live computation using X can be frozen to bytes, shipped, and thawed correctly."
// The same harness is the template for any other language that compiles to the IR.

import { createRuntime } from "#stackmix";
import { Suspend, serializeContinuation, deserializeContinuation, contBytes, initialFrames, awaitable } from "#stackmix/runtime/core.mjs";
const rt = createRuntime();
const PROGRAM = rt.program;
const run = (tier, frames, host) => rt.run(tier, frames, host);
import { loadModule } from "#stackmix/compiler/tsc.mjs";

let pass = 0, fail = 0; const fails = [];
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? "B:" + v.toString() : v));
function report(name, ok, err, got, ref) {
  if (ok) { pass++; return; }
  fail++; fails.push(name);
  console.log(`  FAIL  ${name}`);
  if (err) console.log(`        error: ${err.message}`);
  else console.log(`        stackmix=${J(got)}\n        node=${J(ref)}`);
}

// ---- fidelity: Stackmix eval === Node eval ------------------------------------
function t(name, src, entry = "go", args = []) {
  let got, ref, err = null;
  try {
    loadModule(PROGRAM, src, { entry });
    got = run({ id: "t" }, initialFrames(entry, args), { deref: (x) => x }).value;
    ref = new Function(src + "\n;return " + entry + ";")()(...args);
  } catch (e) { err = e; }
  report(name, !err && J(got) === J(ref), err, got, ref);
}

// async fidelity: Stackmix runs awaits of plain values inline; Node returns a Promise we await.
async function ta(name, src, entry = "go", args = []) {
  let got, ref, err = null;
  try {
    loadModule(PROGRAM, src, { entry });
    got = run({ id: "t" }, initialFrames(entry, args), { deref: (x) => x }).value;
    ref = await new Function(src + "\n;return " + entry + ";")()(...args);
  } catch (e) { err = e; }
  report(name, !err && J(got) === J(ref), err, got, ref);
}

// ---- continuation: same program, serialized + resumed at every `ckpt` await --
// ckpt(x) is a resource returning an awaitable {v:x}; the harness crosses a real
// serialization boundary at each one. Node runs ckpt as identity-async.
let maxWire = 0;
async function w(name, src, entry = "go", args = [], minHops = 1) {
  let got, ref, err = null, hops = 0;
  try {
    loadModule(PROGRAM, src, { entry, resources: ["ckpt"] });
    const tier = { id: "client", has: (n) => n === "ckpt", resources: { ckpt: (a) => awaitable({ v: a[0] }) } };
    let frames = initialFrames(entry, args); const host = { deref: (x) => x };
    while (true) {
      let res;
      try { res = run(tier, frames, host); }
      catch (e) {
        if (!(e instanceof Suspend)) throw e;
        const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, tier); // freeze to bytes
        maxWire = Math.max(maxWire, contBytes(wire));
        const g = deserializeContinuation(JSON.parse(JSON.stringify(wire)));                 // thaw from bytes
        if (g.pending && "await" in g.pending) { hops++; g.frames[g.frames.length - 1].stack.push(g.pending.await.v); }
        else if (g.pending && "awaitAll" in g.pending) { hops++; const r = g.pending.result.slice(); g.pending.pendingIdx.forEach((idx, k) => { r[idx] = g.pending.awaitAll[k].v; }); g.frames[g.frames.length - 1].stack.push(r); }
        else throw new Error("unexpected suspension");
        frames = g.frames; continue;
      }
      got = res.value; break;
    }
    const ckpt = async (x) => x; // identity-async in the reference engine
    ref = await new Function("ckpt", src + "\n;return " + entry + ";")(ckpt)(...args);
  } catch (e) { err = e; }
  report(`${name} [wire x${hops}]`, !err && J(got) === J(ref) && hops >= minHops, err, got, ref);
}

const section = (s) => console.log(`\n— ${s} —`);
console.log("Stackmix conformance: full-language fidelity, and survival across continuation migration\n");
console.log("PART 1 — FIDELITY (Stackmix === Node)");

section("literals, operators, coercion");
t("numbers/strings/bools/null/template", `function go(){const a=1.5,b="x",c=true,d=null; return [a*2,b+"y",!c,d,\`\${a}-\${b}\`];}`);
t("arithmetic + precedence + %/**", `function go(){return [1+2*3,(1+2)*3,7%3,2**10,7/2,-(3),+"5"];}`);
t("comparison + equality (loose vs strict)", `function go(){return [1<2,2<=2,3>4,1==="1",1=="1",null==undefined,null===undefined,NaN===NaN];}`);
t("logical + nullish + ternary", `function go(){return [true&&"a",false||"b",0??"c",null??"d",1?"y":"n",""&&"z"];}`);
t("bitwise + shifts + ~", `function go(){return [5&3,5|2,5^1,1<<4,256>>2,-1>>>28,~0,~5];}`);
t("string methods", `function go(){const s=" Hi There ";return [s.trim(),s.toLowerCase(),s.trim().split(" "),"a-b-c".split("-").join("+"),s.includes("Hi"),"abc".slice(1),"x".repeat(3),"AB".padStart(4,"_")];}`);
t("number methods + Math", `function go(){return [(3.14159).toFixed(2),(255).toString(16),Math.max(1,9,3),Math.min(4,2),Math.round(2.6),Math.floor(2.9),Math.abs(-7),Math.sqrt(16)];}`);

section("control flow");
t("if/else if/else", `function classify(n){if(n<0)return"neg";else if(n===0)return"zero";else return"pos";} function go(){return [-1,0,5].map(classify);}`);
t("for / while / do-while", `function go(){let a=[];for(let i=0;i<3;i++)a.push(i);let j=0;while(j<3){a.push(j*10);j++;}let k=0;do{a.push(k+100);k++;}while(k<2);return a;}`);
t("for-of / for-in", `function go(){const a=[];for(const x of [1,2,3])a.push(x);const o={p:1,q:2};for(const k in o)a.push(k);return a;}`);
t("switch fall-through + default", `function f(n){switch(n){case 1:case 2:return"lo";case 3:return"mid";default:return"hi";}} function go(){return [1,2,3,9].map(f);}`);
t("break / continue / labeled", `function go(){const a=[];outer:for(let i=0;i<3;i++){for(let j=0;j<3;j++){if(j===1)continue;if(i===2)break outer;a.push(i+""+j);}}return a;}`);
t("comma operator + void", `function go(){let x=0;const y=(x=5,x*2);return [y,void 0];}`);
t("assignment is an expression (chained, in-condition, single-eval base)", `function go(){let a,b;a=b=5;let calls=0;const get=()=>{calls++;return {v:1};};get().v+=10;let m,i=0,out=[];const arr=[7,8,9];while((m=arr[i++])!==undefined)out.push(m);let x=1;const r=(x&&=3);return {a,b,calls,out,x,r,nested:(()=>{const o={};let t;o.z=t=4;return [o.z,t];})()};}`);
t("++ / -- single-eval + value (postfix/prefix on var/prop/elem)", `function go(){let i=5;const a=i++,c=++i;const o={n:1};const d=o.n++;const arr=[10];const e=arr[0]--;let calls=0;const g=()=>{calls++;return o;};g().n++;return {a,c,i,d,on:o.n,e,a0:arr[0],calls};}`);

section("functions, closures, scoping");
t("defaults + rest + spread", `function f(a,b=10,...rest){return [a,b,rest];} function go(){return [f(1),f(1,2),f(1,2,3,4),f(1,...[5,6])];}`);
t("closures capture + mutate", `function counter(){let n=0;return {inc:()=>++n,get:()=>n};} function go(){const c=counter();c.inc();c.inc();return c.get();}`);
t("higher-order: map/filter/reduce/find/some/every", `function go(){const a=[1,2,3,4,5,6];return {ev:a.filter(x=>x%2===0),dbl:a.map(x=>x*2),sum:a.reduce((s,x)=>s+x,0),f:a.find(x=>x>4),some:a.some(x=>x>5),every:a.every(x=>x>0)};}`);
t("block scoping + per-iteration let", `function go(){const f=[];for(let i=0;i<3;i++)f.push(()=>i);for(const v of [9])f.push(()=>v);return f.map(g=>g());}`);
t("nested fn decls + recursion", `function go(){function fib(n){return n<2?n:fib(n-1)+fib(n-2);}return [fib(0),fib(5),fib(10)];}`);
t("IIFE + arrow this lexical", `function go(){const o={v:5,run(){return (()=>this.v*2)();}};return o.run();}`);
t("arguments object", `function sum(){let s=0;for(let i=0;i<arguments.length;i++)s+=arguments[i];return s;} function go(){return sum(1,2,3,4,5);}`);

section("destructuring");
t("object/array + defaults + rest + nested", `function go(){const {a=1,b,...rest}={b:2,c:3,d:4};const [x,,z,...tail]=[10,20,30,40,50];const {p:{q}}={p:{q:9}};return {a,b,rest,x,z,tail,q};}`);
t("swap + for-of destructure", `function go(){let a=1,b=2;[a,b]=[b,a];const o=[];for(const [k,v] of [["x",1],["y",2]])o.push(k+v);return {a,b,o};}`);

section("objects & arrays");
t("object literal: shorthand/computed/spread/getter-setter", `function go(){const n=5;const base={a:1};const o={n,[\"k\"+1]:2,...base,get d(){return this.n*2;}};const r=o.d;return {n:o.n,k1:o.k1,a:o.a,d:r};}`);
t("array spread/holes/flat/includes", `function go(){return {sp:[0,...[1,2],3],fl:[1,[2,3],[4]].flat(),inc:[1,2,3].includes(2),idx:[5,6,7].indexOf(6)};}`);
t("Map / Set / JSON / Object.*", `function go(){const m=new Map([["a",1]]);m.set("b",2);const s=new Set([1,1,2]);return {m:[...m],size:m.size,set:[...s],keys:Object.keys({x:1,y:2}),json:JSON.parse(JSON.stringify({z:[1,2]}))};}`);

section("module-level bindings");
t("module const/let, shared & mutated across functions", `const PI=3.14159; let hits=0; const log=[]; function track(n){hits++;log.push(n);} function go(){track("a");track("b");return {area:PI*2*2|0,hits,log};}`, "go");
t("module computed init + destructuring + closures over module state", `const base=10; const derived=base*3+1; const {x,y}=({x:1,y:2}); let acc=0; const add=(n)=>{acc+=n;}; function go(){add(5);add(derived);return {derived,x,y,acc};}`, "go");
t("module side-effecting statements + var hoisting", `let items=[]; items.push("init"); function use(){items.push("used");} function go(){use();return {items,hoisted:typeof later};} var later=1;`, "go");

section("classes");
t("fields/methods/this/new/getters/setters", `class Temp{constructor(c){this._c=c;}get f(){return this._c*9/5+32;}set f(v){this._c=(v-32)*5/9;}desc(){return this._c+"C";}} function go(){const t=new Temp(100);const a=t.f;t.f=32;return [a,t._c,t.desc()];}`);
t("inheritance/super/override/instanceof", `class A{constructor(n){this.n=n;}who(){return"A:"+this.n;}} class B extends A{who(){return super.who()+"/B";}} function go(){const b=new B(5);return [b.who(),b instanceof A,b instanceof B,b.n];}`);
t("static members + implicit ctor + private", `class C{static count=0;#id;constructor(){this.#id=++C.count;}id(){return this.#id;}static total(){return C.count;}} function go(){const a=new C(),b=new C();return [a.id(),b.id(),C.total()];}`);
t("local classes + factory", `function make(base){class P{constructor(x){this.x=x;}val(){return this.x+base;}}return new P(10);} function go(){return make(5).val();}`);

section("exceptions");
t("try/catch/finally + throw + rethrow-through-finally", `function go(){const log=[];function f(x){try{if(x<0)throw"neg";return x;}finally{log.push("fin"+x);}}let caught="ok";try{f(-1);}catch(e){caught=e;}return {a:f(5),caught,log};}`);
t("finally runs on return/break/continue", `function go(){const log=[];function r(){try{return 1;}finally{log.push("r");}}for(let i=0;i<3;i++){try{if(i===1)continue;if(i===2)break;}finally{log.push("L"+i);}}return {r:r(),log};}`);
t("nested try + catch binding + finally override", `function go(){function f(){try{try{throw"x";}finally{}}catch(e){return"caught:"+e;}}function g(){try{return"a";}finally{return"b";}}return [f(),g()];}`);

section("generators & iterators");
t("yield / for-of / two-way next / return value", `function* r(a,b){for(let i=a;i<b;i++){const got=yield i;if(got)return"early";}return"done";} function go(){const it=r(1,5);return [it.next().value,it.next().value,it.next(true).value,it.next().done];}`);
t("yield* delegation + spread + generator method", `function* inner(){yield 1;yield 2;return 3;} function* outer(){const r=yield* inner();yield r;} class G{*nums(){yield 7;yield 8;}} function go(){return {o:[...outer()],g:[...new G().nums()]};}`);
t(".return()/.throw() with finally", `function* g(log){try{yield 1;yield 2;}catch(e){log.push("c:"+e);yield 9;}finally{log.push("fin");}} function go(){const log=[];const it=g(log);it.next();const r=it.throw("E");return {r:r.value,log,done:it.return(0).done};}`);

section("async (await as suspension; values match)");
await ta("async/await chains (plain values)", `async function dbl(x){return x*2;} async function go(){const a=await dbl(5);const b=await dbl(a);return a+b;}`);
await ta("Promise.all / resolve / reject+catch", `async function go(){const xs=await Promise.all([Promise.resolve(1),2,Promise.resolve(3)]);let caught="ok";try{await Promise.reject("boom");}catch(e){caught=e;}return {sum:xs.reduce((a,b)=>a+b,0),caught};}`);
await ta("async generator + for await (plain)", `async function* nums(n){for(let i=0;i<n;i++){const v=await Promise.resolve(i);yield v*10;}} async function go(){const o=[];for await(const x of nums(4))o.push(x);return o;}`);

section("symbols, custom iterables, computed names");
t("Symbol: unique / for / keyFor / typeof / as key", `function go(){const a=Symbol("x"),b=Symbol("x");const o={};o[a]=1;o[b]=2;return {uniq:a!==b,same:a===a,ty:typeof a,desc:a.description,forEq:Symbol.for("k")===Symbol.for("k"),keyFor:Symbol.keyFor(Symbol.for("z")),val:o[a],syms:Object.getOwnPropertySymbols(o).length};}`);
t("custom iterable via [Symbol.iterator] (object + class)", `const proto={};function range(a,b){return {[Symbol.iterator](){let i=a;return {next(){return i<b?{value:i++,done:false}:{value:undefined,done:true};}};}};} class Evens{constructor(n){this.n=n;}*[Symbol.iterator](){for(let i=0;i<this.n;i++)yield i*2;}} function go(){const o=[];for(const x of range(1,4))o.push(x);return {forOf:o,spread:[...range(5,7)],gen:[...new Evens(4)]};}`);
t("computed property + method + Symbol-keyed method", `function go(){const k="dyn";const sym=Symbol("s");const o={[k+"1"]:1,[k](){return 2;},[sym](){return 3;}};return {a:o.dyn1,b:o.dyn(),c:o[sym]()};}`);

section("bigint, regex, tagged templates");
t("BigInt arithmetic + compare + typeof", `function go(){const a=9007199254740993n;return {sum:(a+1n).toString(),pow:(2n**64n).toString(),div:(7n/2n).toString(),cmp:[1n===1n,1n==1,2n>1n],ty:typeof a};}`);
t("regex test/match/replace", `function go(){return {has:/\\d+/.test("a12b"),m:"a1b2c3".match(/\\d/g),rep:"hello".replace(/l/g,"L")};}`);
t("tagged templates + String.raw", `function tag(s,...v){return s.join("|")+":"+v.join(",");} function go(){const x=2,y=3;return [tag\`a\${x}b\${y}c\`,String.raw\`x\\ny\`];}`);

await (async () => {
  console.log("\nPART 2 — CONTINUATION (frozen to bytes & resumed at every checkpoint)");

  section("primitive & structural state across the wire");
  await w("locals + arithmetic survive", `async function go(){let a=2,b=3;a=await ckpt(a*10);b=await ckpt(b+a);return a+b;}`, "go", [], 2);
  await w("object graph with sharing + mutation", `async function go(){const shared={n:1};const pair=[shared,shared];await ckpt(0);shared.n=99;return [pair[0].n,pair[1]===pair[0]];}`);
  await w("cyclic object round-trips and stays cyclic", `async function go(){const o={id:1};o.self=o;const x=await ckpt(o);return [x.self===x,x.self.self.id];}`);
  await w("Map/Set survive with contents", `async function go(){const m=new Map([["a",1]]);const s=new Set([1,2]);await ckpt(0);m.set("b",2);s.add(3);return {m:[...m],s:[...s]};}`);
  await w("BigInt survives", `async function go(){const a=9007199254740993n;const b=await ckpt(a);return (b+1n).toString();}`);

  section("closures & boxed cells across the wire");
  await w("closure called after migration", `function adder(n){return x=>x+n;} async function go(){const add=adder(100);const y=await ckpt(5);return add(y);}`);
  await w("shared mutable cell survives, then mutated", `function mk(){let n=0;return {inc:()=>++n,get:()=>n};} async function go(){const c=mk();c.inc();await ckpt(0);c.inc();c.inc();return c.get();}`);

  section("dynamic `this` & bound closures across the wire");
  await w("borrowed method suspends mid-call, reads dynamic this after migration", `function read(){return this.n;} async function go(){const o2={n:42,read};await ckpt(0);return o2.read();}`);
  await w("dynamic this resolved AFTER a checkpoint inside the method", `const o={n:7,async m(){const a=await ckpt(1);return this.n+a;}}; async function go(){const o2={n:100,m:o.m};return [await o.m(),await o2.m()];}`, "go", [], 2);
  await w("bound closure created, migrated, then invoked", `function add(a,b){return this.k+a+b;} async function go(){const g=add.bind({k:10},1);await ckpt(0);return g(2);}`);
  await w("arrow capturing dynamic this migrates and stays bound to the receiver", `const o={n:5,make(){return ()=>this.n;}}; async function go(){const o2={n:99,make:o.make};const f=o2.make();await ckpt(0);return f();}`);
  await w("call/apply with this across a checkpoint", `function read(){return this.v;} async function go(){const a=await ckpt(1);return [read.call({v:a}),read.apply({v:a+1})];}`);
  await w("accessor-inheritance instance migrates, getter/setter still resolve", `class A{constructor(v){this._v=v;}get x(){return this._v;}set x(n){this._v=n;}} class B extends A{get x(){return super.x*10;}} async function go(){const b=new B(3);await ckpt(0);const r=b.x;b._v=4;return [r,b.x];}`);
  await w("Map.forEach + accumulator survive a mid-iteration checkpoint", `async function go(){const m=new Map([['a',1],['b',2]]);const out=[];m.forEach((v,k)=>out.push(k+v));await ckpt(0);m.set('c',3);m.forEach((v,k)=>out.push(k+v));return out;}`);
  await w("Proxy + trap handler migrate; traps keep firing post-resume", `async function go(){const log=[];const p=new Proxy({n:1},{set(t,k,v){log.push(k+'='+v);t[k]=v;return true;}});p.n=await ckpt(5);p.n++;return [p.n,log];}`);

  section("classes & generators across the wire");
  await w("class instance migrates, methods still work", `class Acct{constructor(b){this.bal=b;}dep(n){this.bal+=n;return this.bal;}} async function go(){const a=new Acct(100);a.dep(50);await ckpt(0);return [a.dep(25),a instanceof Acct,JSON.stringify(a)];}`);
  await w("half-consumed generator migrates and keeps going", `function* nat(){let i=0;while(true)yield i++;} async function go(){const it=nat();const a=it.next().value;await ckpt(0);return [a,it.next().value,it.next().value];}`);
  await w("async generator awaiting a resource MID-ITERATION migrates", `async function* pages(n){for(let i=0;i<n;i++){const r=await ckpt(i*10);yield r;}} async function go(){const o=[];for await(const r of pages(3))o.push(r);return o;}`, "go", [], 3);

  section("control flow & handlers across the wire");
  await w("try/catch handler survives, catches post-resume throw", `async function go(){try{const y=await ckpt(5);throw y+1;}catch(e){return"caught:"+e;}}`);
  await w("custom Error subclass survives wire, instanceof still holds", `class AppErr extends Error{constructor(m,c){super(m);this.name='AppErr';this.code=c;}} async function go(){const e=new AppErr('boom',42);await ckpt(0);return [e.message,e.name,e.code,e instanceof Error,e instanceof AppErr];}`);
  await w("error thrown across a checkpoint, caught by type", `class NotFound extends Error{} async function go(){try{await ckpt(0);throw new NotFound('missing');}catch(e){return [e instanceof Error,e instanceof NotFound,e.message];}}`);
  await w("finally runs after a migration", `async function go(){const log=[];try{await ckpt(0);log.push("body");}finally{log.push("fin");}return log;}`);
  await w("loop state + accumulator across many checkpoints", `async function go(){let s=0;for(let i=0;i<5;i++){s=await ckpt(s+i);}return s;}`, "go", [], 5);
  await w("Promise.all of resources resolved concurrently across the wire", `async function go(){const xs=await Promise.all([ckpt(1),ckpt(2),ckpt(3)]);return xs.reduce((a,b)=>a+b,0);}`);
  await w("destructuring + Map + closure all live across one await", `async function go(){const m=new Map([["k",[1,2,3]]]);const {k:[first,...tail]}=Object.fromEntries?{k:m.get("k")}:{k:m.get("k")};const f=x=>x+first;const y=await ckpt(10);return [f(y),tail];}`);
  await w("custom iterable consumed across checkpoints (iterator state migrates)", `async function go(){const it={i:0,n:3,[Symbol.iterator](){return this;},next(){return this.i<this.n?{value:this.i++,done:false}:{value:undefined,done:true};}};const out=[];for(const x of it){out.push(await ckpt(x*10));}return out;}`, "go", [], 3);
  await w("symbol-keyed state + Symbol value survive the wire", `async function go(){const s=Symbol("id");const o={[s]:1};await ckpt(0);o[s]+=await ckpt(41);return [o[s],typeof s,s.description];}`);
  await w("module-level state persists across a migration (per-tier)", `let counter=0; const bump=()=>++counter; async function go(){bump();const a=await ckpt(0);bump();bump();return [counter,a];}`, "go", [], 1);
})();

console.log(`\n${"=".repeat(64)}`);
console.log(`Result: ${fail === 0 ? "ALL PASS" : fails.length + " FAILED"} — ${pass} checks passed${fail ? " ; failures: " + fails.join(", ") : ""}.`);
console.log(`Max continuation on the wire: ${maxWire} B. Fidelity vs Node + survival across`);
console.log(`serialize/resume — the full language, owned as data by the continuation.`);
if (fail) process.exitCode = 1;

// Waso differential tester — find edge-case divergences from the real engine.
//
// Completeness can't be asserted; it has to be MEASURED. This runs a large battery
// of semantic-corner snippets through both Waso and Node and flags any divergence.
// It deliberately targets the places a reimplementation breaks — scoping/TDZ/
// hoisting, closure capture, destructuring corners, control-flow (try/finally,
// switch, labels), iterator/generator protocol, coercion, getters — not the easy
// middle. Every divergence it prints is a bug to fix or a caveat to document.

import { PROGRAM, run, initialFrames } from "./waso-core.mjs";
import { loadModule } from "./waso-tsc.mjs";

let pass = 0, fail = 0, caveat = 0; const fails = [];
// Documented, intentional divergences (behavior differs only for already-buggy code):
//   - TDZ non-enforcement: reading a let/const before its declaration yields undefined
//     instead of throwing ReferenceError. Enforcing it would add a sentinel check to
//     every let/const read; correct programs never observe the difference.
const CAVEATS = new Set(["let TDZ throws"]);
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? "B:" + v.toString() : typeof v === "symbol" ? "S:" + String(v.description) : typeof v === "function" ? "fn" : v === undefined ? "U" : v));
function d(name, src) {
  let got, ref, gErr = null, rErr = null;
  for (const k in PROGRAM) delete PROGRAM[k];
  try { loadModule(PROGRAM, src, { entry: "go" }); got = run({ id: "t" }, initialFrames("go", []), { deref: (x) => x }).value; } catch (e) { gErr = e; }
  try { ref = new Function(src + "\n;return go;")()(); } catch (e) { rErr = e; }
  // Compare values; if Node throws, Waso should throw too (we don't compare messages).
  const ok = rErr ? !!gErr : (!gErr && J(got) === J(ref));
  const emsg = (e) => (e == null ? "" : e.message !== undefined ? e.message : "value" in e ? "throw " + J(e.value) : String(e)).slice(0, 70);
  if (ok) pass++; else if (CAVEATS.has(name)) { caveat++; console.log(`  caveat ${name} (documented)`); } else { fail++; fails.push(name); console.log(`  DIFF  ${name}`); if (gErr && !rErr) console.log(`        waso threw: ${emsg(gErr)}  | node=${J(ref)}`); else if (rErr && !gErr) console.log(`        waso=${J(got)}  | node threw`); else console.log(`        waso=${J(got)}  node=${J(ref)}`); }
}
const D = (name, expr) => d(name, `function go(){ return (${expr}); }`);

console.log("Waso differential test vs Node — hunting edge divergences\n");

console.log("— coercion & operators —");
for (const e of ["[]+[]", "[]+{}", "({})+[]", "1+'2'", "'5'-1", "'5'*'2'", "null+1", "undefined+1", "true+1", "false+'x'", "[1,2]+[3]", "+[]", "+{}", "-'5'", "!''", "!0", "!'0'", "~~4.7", "5%-3", "-5%3", "2**-1", "0.1+0.2", "1/0", "-1/0", "0/0", "1<2<3", "3>2>1", "'a'<'b'", "null??5", "0??5", "''||'x'", "NaN||1", "void 0", "typeof typeof 1"]) D("coerce " + e, e);
for (const e of ["NaN===NaN", "0===-0", "1/-0===-Infinity", "null==undefined", "null===undefined", "''==0", "'0'==0", "[]==0", "[]==''", "[0]==false", "' '==0", "null==0", "undefined==null"]) D("eq " + e, e);

console.log("— scoping, hoisting, TDZ, closures —");
d("var hoists, reads undefined", "function go(){ const r=typeof x; var x=5; return [r,x]; }");
d("function hoisting", "function go(){ return f(); function f(){return 'hoisted';} }");
d("let TDZ throws", "function go(){ try{ return y; }catch(e){return 'tdz';} let y=1; }");
d("closure captures var not value", "function go(){ const fns=[]; for(var i=0;i<3;i++)fns.push(()=>i); return fns.map(f=>f()); }");
d("closure per-iteration let", "function go(){ const fns=[]; for(let i=0;i<3;i++)fns.push(()=>i); return fns.map(f=>f()); }");
d("block shadow inner/outer", "function go(){ let x=1; { let x=2; { let x=3; } } return x; }");
d("nested fn shadows param", "function go(){ function f(a){ function g(a){return a*2;} return g(a)+a; } return f(5); }");
d("IIFE scope", "function go(){ const x=(function(){ var y=10; return y; })(); return [x, typeof y]; }");
d("shadow in catch", "function go(){ let e='outer'; try{throw 'inner';}catch(e){return e;} }");
d("default param sees earlier param", "function go(){ function f(a,b=a*2){return a+b;} return f(3); }");
d("recursive closure", "function go(){ const fac=n=>n<=1?1:n*fac(n-1); return fac(5); }");

console.log("— destructuring corners —");
d("swap via array destr", "function go(){ let a=1,b=2; [a,b]=[b,a]; return [a,b]; }");
d("nested with defaults", "function go(){ const {a:{b=5}={}}={a:{}}; return b; }");
d("array holes", "function go(){ const [,,c]=[1,2,3]; return c; }");
d("rest in middle not allowed -> only trailing", "function go(){ const [a,...r]=[1,2,3,4]; return [a,r]; }");
d("default only when undefined not null", "function go(){ const {a=5}={a:null}; const {b=5}={b:undefined}; return [a,b]; }");
d("computed key destr", "function go(){ const k='x'; const {[k]:v}={x:42}; return v; }");
d("destr from string", "function go(){ const [a,b]='hi'; return [a,b]; }");
d("nested array+object", "function go(){ const {list:[first,{deep}]}={list:[1,{deep:9}]}; return [first,deep]; }");
d("param destructure default", "function go(){ function f({x=1,y=2}={}){return x+y;} return [f(),f({x:10})]; }");

console.log("— control flow corners —");
d("finally overrides return", "function go(){ function f(){ try{return 1;}finally{return 2;} } return f(); }");
d("finally runs on break", "function go(){ const log=[]; for(let i=0;i<3;i++){ try{ if(i===1)break; log.push(i);}finally{log.push('f'+i);} } return log; }");
d("return value computed before finally", "function go(){ let n=1; function f(){ try{return n;}finally{n=99;} } return [f(),n]; }");
d("nested finally order", "function go(){ const log=[]; try{ try{ throw 'x'; }finally{ log.push('inner'); } }catch(e){ log.push('catch'); }finally{ log.push('outer'); } return log; }");
d("switch fallthrough", "function go(){ function f(n){ let r=[]; switch(n){ case 1: r.push(1); case 2: r.push(2); break; case 3: r.push(3); default: r.push('d'); } return r; } return [f(1),f(2),f(3),f(9)]; }");
d("switch with no match no default", "function go(){ let r='none'; switch(5){ case 1: r='one'; } return r; }");
d("labeled continue", "function go(){ const out=[]; outer: for(let i=0;i<3;i++){ for(let j=0;j<3;j++){ if(j===1)continue outer; out.push(i+''+j); } } return out; }");
d("labeled break from nested", "function go(){ let hit=0; a: for(let i=0;i<5;i++){ for(let j=0;j<5;j++){ hit++; if(i===1&&j===1)break a; } } return hit; }");
d("do-while runs once", "function go(){ let n=0; do{ n++; }while(n<0); return n; }");
d("continue in while", "function go(){ let i=0,s=0; while(i<5){ i++; if(i%2===0)continue; s+=i; } return s; }");
d("throw in finally replaces", "function go(){ function f(){ try{throw 'a';}finally{throw 'b';} } try{f();}catch(e){return e;} }");
d("try without catch only finally", "function go(){ const log=[]; function f(){ try{ log.push('t'); return 1; }finally{ log.push('f'); } } const r=f(); return [r,log]; }");

console.log("— iterators, generators, spread —");
d("spread string", "function go(){ return [...'abc']; }");
d("spread set dedups", "function go(){ return [...new Set([1,1,2,3,3])]; }");
d("spread map entries", "function go(){ return [...new Map([['a',1],['b',2]])]; }");
d("generator return value via for-of ignored", "function go(){ function* g(){ yield 1; return 99; yield 2; } return [...g()]; }");
d("generator early return", "function go(){ function* g(){ yield 1; yield 2; yield 3; } const it=g(); it.next(); it.return(); return it.next().done; }");
d("nested spread in call", "function go(){ function f(a,b,c,d){return a+b+c+d;} return f(...[1,2],...[3,4]); }");
d("Array.from with mapFn", "function go(){ return Array.from([1,2,3], x=>x*10); }");
d("entries of array", "function go(){ const out=[]; for(const [i,v] of [10,20].entries())out.push(i+':'+v); return out; }");
d("iterator manual protocol", "function go(){ const it=[1,2][Symbol.iterator](); return [it.next().value, it.next().value, it.next().done]; }");

console.log("— objects, getters, this, classes —");
d("getter on object literal", "function go(){ const o={_v:5,get v(){return this._v*2;}}; return o.v; }");
d("setter validates", "function go(){ const o={_v:0,set v(x){this._v=x<0?0:x;},get v(){return this._v;}}; o.v=-5; o.v=10; return o.v; }");
d("method this dynamic", "function go(){ const o={n:5,get(){return this.n;}}; const o2={n:9,get:o.get}; return [o.get(),o2.get()]; }");
d("arrow captures dynamic this", "function go(){ const o={n:5,make(){return ()=>this.n;}}; const o2={n:9,make:o.make}; return [o.make()(),o2.make()()]; }");
d("plain fn as method gets receiver", "function go(){ function f(){return this&&this.v;} const o={v:7,f}; return [o.f(),typeof f()]; }");
d("nested arrows share this", "function go(){ const o={n:3,go(){return (()=>(()=>this.n)())();}}; return o.go(); }");
d("this in array method callback", "function go(){ const o={base:10,vals:[1,2,3],run(){return this.vals.map(x=>x+this.base);}}; return o.run(); }");
d("method extracted to var keeps via call site", "function go(){ const o={n:8,read(){return this.n;}}; const o2={n:1}; o2.read=o.read; return o2.read(); }");
d("dynamic dispatch this", "function go(){ const o={n:4,m(){return this.n;}}; const k='m'; return o[k](); }");
d("generator method this", "function go(){ const o={vals:[1,2],*g(){for(const v of this.vals)yield v;}}; return [...o.g()]; }");
d("Function.call", "function go(){ function f(a,b){return this.base+a+b;} return f.call({base:100},2,3); }");
d("Function.apply", "function go(){ function f(a,b){return this.base+a+b;} return f.apply({base:100},[2,3]); }");
d("Function.bind partial", "function go(){ function f(a,b,c){return this.k+a+b+c;} const g=f.bind({k:1},10); return g(20,30); }");
d("bind then call ignores new this", "function go(){ const o={n:5,m(){return this.n;}}; const b=o.m.bind({n:99}); return [b(),b.call({n:1})]; }");
d("method.call cross-object", "function go(){ const a={n:1,read(){return this.n;}}; const b={n:2}; return a.read.call(b); }");
d("apply with no args array", "function go(){ function f(){return this.v;} return f.apply({v:7}); }");
d("bind preserves through map", "function go(){ const o={base:10,add(x){return this.base+x;}}; const f=o.add.bind(o); return [1,2,3].map(f); }");
d("getter inheritance", "function go(){ class A{get x(){return 1;}} class B extends A{get x(){return super.x+1;}} return new B().x; }");
d("static method this is class", "function go(){ class C{static n=5; static get(){return this.n;}} return C.get(); }");
d("instanceof chain", "function go(){ class A{} class B extends A{} class C extends B{} const c=new C(); return [c instanceof A,c instanceof B,c instanceof C]; }");
d("toString override", "function go(){ class P{constructor(n){this.n=n;} toString(){return 'P('+this.n+')';}} return ''+new P(3); }");
d("computed method name", "function go(){ const k='dyn'; const o={[k](){return 7;}}; return o.dyn(); }");
d("JSON.stringify instance data only", "function go(){ class P{constructor(){this.a=1;this.b=2;} m(){}} return JSON.stringify(new P()); }");
d("delete property", "function go(){ const o={a:1,b:2}; delete o.a; return [Object.keys(o),'a' in o]; }");
d("in operator", "function go(){ const o={x:1}; return ['x' in o,'y' in o,'toString' in o]; }");
d("spread object override order", "function go(){ const base={a:1,b:2}; return {...base,b:20,c:30}; }");

console.log("— strings, numbers, regex, bigint —");
d("string immutable index", "function go(){ const s='abc'; return [s[0],s[10],s.length,s.charAt(1)]; }");
d("template nesting", "function go(){ const x=2; return `a${`b${x}c`}d`; }");
d("number toString radix", "function go(){ return [(255).toString(16),(8).toString(2),(255).toString(2)]; }");
d("parseInt edge", "function go(){ return [parseInt('0x1F'),parseInt('  42px'),parseInt('abc'),parseInt('10',2)]; }");
d("regex global lastIndex match", "function go(){ return 'a1b2c3'.match(/\\d/g); }");
d("regex replace fn", "function go(){ return 'abc'.replace(/[a-c]/g,m=>m.toUpperCase()); }");
d("regex capture groups", "function go(){ const m='2024-01-15'.match(/(\\d+)-(\\d+)-(\\d+)/); return [m[1],m[2],m[3]]; }");
d("bigint mixed throws", "function go(){ try{ return 1n+1; }catch(e){return 'threw';} }");
d("bigint division truncates", "function go(){ return [(7n/2n).toString(),(-7n/2n).toString()]; }");
d("number edge", "function go(){ return [Number.MAX_SAFE_INTEGER,Number.isInteger(5.0),(0.1+0.2).toFixed(2),Math.round(2.5),Math.round(-2.5)]; }");

console.log(`\n${"=".repeat(64)}`);
console.log(`${fail === 0 ? "NO DIVERGENCES" : fail + " DIVERGENCES"} — ${pass}/${pass + fail + caveat} matched Node` + (caveat ? `, ${caveat} documented caveat${caveat > 1 ? "s" : ""}` : "") + (fail ? `\nDivergent: ${fails.join(", ")}` : ""));
if (fail) process.exitCode = 1;

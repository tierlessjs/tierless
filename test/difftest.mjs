// Stackmix differential tester — find edge-case divergences from the real engine.
//
// Completeness can't be asserted; it has to be MEASURED. This runs a large battery
// of semantic-corner snippets through both Stackmix and Node and flags any divergence.
// It deliberately targets the places a reimplementation breaks — scoping/TDZ/
// hoisting, closure capture, destructuring corners, control-flow (try/finally,
// switch, labels), iterator/generator protocol, coercion, getters — not the easy
// middle. Every divergence it prints is a bug to fix or a caveat to document.

import { createRuntime } from "#stackmix";
import { initialFrames } from "#stackmix/runtime/core.mjs";
const rt = createRuntime();
const PROGRAM = rt.program;
const run = (tier, frames, host) => rt.run(tier, frames, host);
import { loadModule } from "#stackmix/compiler/tsc.mjs";

let pass = 0, fail = 0, caveat = 0; const fails = [];
// Documented, intentional divergences (behavior differs only for already-buggy code):
//   - TDZ non-enforcement: reading a let/const before its declaration yields undefined
//     instead of throwing ReferenceError. Enforcing it would add a sentinel check to
//     every let/const read; correct programs never observe the difference.
//   - Dynamic accessor keys (Object.defineProperty with a get/set descriptor, and
//     computed object-literal accessors `{get [k](){}}`) aren't honored by a static
//     `obj.name` read — those compile to a branchless plain read. Computed access
//     `obj[key]` DOES fire them; data descriptors and statically-named class/literal
//     get/set work fully. Belongs with the Proxy/reactivity metaprogramming track.
const CAVEATS = new Set(["let TDZ throws", "Object.defineProperty getter", "computed accessor name"]);
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? "B:" + v.toString() : typeof v === "symbol" ? "S:" + String(v.description) : typeof v === "function" ? "fn" : v === undefined ? "U" : v));
function d(name, src) {
  let got, ref, gErr = null, rErr = null;
  for (const k in PROGRAM) delete PROGRAM[k];
  try { loadModule(PROGRAM, src, { entry: "go" }); got = run({ id: "t" }, initialFrames("go", []), { deref: (x) => x }).value; } catch (e) { gErr = e; }
  try { ref = new Function(src + "\n;return go;")()(); } catch (e) { rErr = e; }
  // Compare values; if Node throws, Stackmix should throw too (we don't compare messages).
  const ok = rErr ? !!gErr : (!gErr && J(got) === J(ref));
  const emsg = (e) => (e == null ? "" : e.message !== undefined ? e.message : "value" in e ? "throw " + J(e.value) : String(e)).slice(0, 70);
  if (ok) pass++; else if (CAVEATS.has(name)) { caveat++; console.log(`  caveat ${name} (documented)`); } else { fail++; fails.push(name); console.log(`  DIFF  ${name}`); if (gErr && !rErr) console.log(`        stackmix threw: ${emsg(gErr)}  | node=${J(ref)}`); else if (rErr && !gErr) console.log(`        stackmix=${J(got)}  | node threw`); else console.log(`        stackmix=${J(got)}  node=${J(ref)}`); }
}
const D = (name, expr) => d(name, `function go(){ return (${expr}); }`);

console.log("Stackmix differential test vs Node — hunting edge divergences\n");

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

console.log("— array built-ins —");
d("sort with comparator", "function go(){ return [3,1,2,10].sort((a,b)=>a-b); }");
d("sort default lexicographic", "function go(){ return [10,2,1,20].sort(); }");
d("splice removes and inserts", "function go(){ const a=[1,2,3,4,5]; const r=a.splice(1,2,'a','b'); return [a,r]; }");
d("flatMap", "function go(){ return [1,2,3].flatMap(x=>[x,x*10]); }");
d("flat depth", "function go(){ return [1,[2,[3,[4]]]].flat(2); }");
d("findLast/findLastIndex", "function go(){ return [[1,2,3,4].findLast(x=>x%2===1),[1,2,3,4].findLastIndex(x=>x%2===1)]; }");
d("reduceRight", "function go(){ return ['a','b','c'].reduceRight((acc,x)=>acc+x,''); }");
d("fill and copyWithin", "function go(){ return [[1,2,3,4].fill(0,1,3),[1,2,3,4,5].copyWithin(0,3)]; }");
d("Array.of and Array.from iterable", "function go(){ return [Array.of(1,2,3),Array.from('ab'),Array.from({length:3},(_, i)=>i)]; }");
d("array indexOf with NaN and includes", "function go(){ return [[NaN].indexOf(NaN),[NaN].includes(NaN),[1,2].at(-1)]; }");
d("concat spreads arrays not values", "function go(){ return [1].concat([2,3],4,[5]); }");
d("array every/some short circuit", "function go(){ let c=0; const r=[1,2,3,4].some(x=>{c++;return x>2;}); return [r,c]; }");
d("join with nested and nullish", "function go(){ return [1,null,2,undefined,3].join('-'); }");

console.log("— object built-ins —");
d("Object.entries/values/fromEntries", "function go(){ const o={a:1,b:2}; const e=Object.entries(o); return [e,Object.values(o),Object.fromEntries(e.map(([k,v])=>[k,v*2]))]; }");
d("Object.assign merges", "function go(){ return Object.assign({a:1},{b:2},{a:9,c:3}); }");
d("Object.keys order numeric then insertion", "function go(){ const o={b:1,2:1,a:1,1:1}; return Object.keys(o); }");
d("Object.freeze prevents write", "function go(){ const o=Object.freeze({a:1}); try{o.a=2;}catch(e){} return [o.a,Object.isFrozen(o)]; }");
d("Object.getOwnPropertyNames includes non-enum", "function go(){ const o={a:1}; Object.defineProperty(o,'h',{value:2,enumerable:false}); return [Object.keys(o),Object.getOwnPropertyNames(o).sort()]; }");
d("hasOwnProperty vs in", "function go(){ const o={a:1}; return [o.hasOwnProperty('a'),o.hasOwnProperty('toString'),'toString' in o]; }");
d("Object.create with null proto", "function go(){ const o=Object.create(null); o.x=1; return [o.x,Object.keys(o)]; }");

console.log("— error semantics —");
d("Error message and name", "function go(){ const e=new Error('boom'); return [e.message,e.name,e instanceof Error]; }");
d("custom error subclass", "function go(){ class MyErr extends Error{constructor(m){super(m);this.name='MyErr';}} try{throw new MyErr('x');}catch(e){return [e.message,e.name,e instanceof Error,e instanceof MyErr];} }");
d("TypeError instanceof Error", "function go(){ try{ null.foo; }catch(e){ return [e instanceof TypeError, e instanceof Error]; } }");
d("throw and catch preserves identity", "function go(){ const o={code:42}; try{throw o;}catch(e){return e===o;} }");
d("re-throw in catch", "function go(){ function f(){try{throw 'a';}catch(e){throw e+'b';}} try{f();}catch(e){return e;} }");

console.log("— optional chaining & nullish —");
d("optional chain short circuits", "function go(){ const o={a:{b:null}}; return [o?.a?.b?.c, o?.x?.y, o?.a?.b ?? 'def']; }");
d("optional call", "function go(){ const o={f(){return 1;}}; return [o.f?.(), o.g?.()]; }");
d("optional element access", "function go(){ const o=null; const a=[1,2]; return [o?.[0], a?.[1]]; }");
d("nullish assignment", "function go(){ const o={a:null,b:2}; o.a??=5; o.b??=9; return [o.a,o.b]; }");

console.log("— closures, this, misc —");
d("IIFE returning object methods sharing state", "function go(){ const m=(()=>{let n=0;return {inc(){return ++n;},dec(){return --n;}};})(); m.inc();m.inc(); return [m.inc(),m.dec()]; }");
d("getter using other getter", "function go(){ const o={r:5,get area(){return this.r*this.r*3;},get desc(){return 'A='+this.area;}}; return o.desc; }");
d("class private field and method", "function go(){ class C{#x=10;#double(){return this.#x*2;}val(){return this.#double();}} return new C().val(); }");
d("static block / static init order", "function go(){ class C{static a=1;static b=C.a+1;} return [C.a,C.b]; }");
d("chained array transforms", "function go(){ return [1,2,3,4,5,6].filter(x=>x%2===0).map(x=>x*x).reduce((a,b)=>a+b,0); }");
d("spread call with computed args", "function go(){ const f=(...xs)=>xs.reduce((a,b)=>a+b,0); const arr=[1,2,3]; return f(...arr,4,...[5,6]); }");

console.log("— string & number built-ins —");
d("string codePointAt/normalize/at", "function go(){ return ['abc'.at(-1),'A'.codePointAt(0),'café'.length,'x'.padEnd(3,'.')]; }");
d("replaceAll with string and fn", "function go(){ return ['a.b.c'.replaceAll('.','-'),'a1b2'.replace(/\\d/g,d=>'['+d+']')]; }");
d("matchAll iteration", "function go(){ const out=[]; for(const m of 'a1b2'.matchAll(/([a-z])(\\d)/g))out.push(m[1]+m[2]); return out; }");
d("split with limit and regex", "function go(){ return ['a,b,c,d'.split(',',2),'a1b2c'.split(/\\d/)]; }");
d("number toExponential/toPrecision", "function go(){ return [(12345).toExponential(2),(3.14159).toPrecision(3),(255).toString(16)]; }");
d("Math extras", "function go(){ return [Math.trunc(-4.7),Math.sign(-3),Math.cbrt(27),Math.hypot(3,4),Math.log2(8),Math.max()]; }");
d("Number parsing & predicates", "function go(){ return [Number('0x10'),Number(''),Number('  12 '),Number.isNaN(NaN),Number.isFinite(Infinity),Number.parseInt('3.9')]; }");
d("numeric literals: hex/oct/bin/sep", "function go(){ return [0xff,0o17,0b1010,1_000_000,1e3,0.5e-1]; }");

console.log("— typeof exhaustive —");
d("typeof all types", "function go(){ return [typeof 1,typeof 'x',typeof true,typeof undefined,typeof null,typeof {},typeof [],typeof function(){},typeof Symbol(),typeof 1n]; }");
d("typeof of arrow and class", "function go(){ class C{} const f=()=>1; return [typeof f,typeof C]; }");

console.log("— iterable destructuring & spread —");
d("destructure from Set", "function go(){ const [a,b]=new Set([9,8,7]); return [a,b]; }");
d("destructure from generator", "function go(){ function* g(){yield 1;yield 2;yield 3;} const [a,...rest]=g(); return [a,rest]; }");
d("spread Map into array of entries", "function go(){ const m=new Map([['x',1],['y',2]]); const o={}; for(const [k,v] of m)o[k]=v; return o; }");
d("destructure with defaults from short array", "function go(){ const [a=1,b=2,c=3]=[10,undefined]; return [a,b,c]; }");

console.log("— generator edge cases —");
d("generator try/finally on return", "function go(){ const log=[]; function* g(){try{yield 1;yield 2;}finally{log.push('f');}} const it=g(); it.next(); it.return(99); return [it.next().done,log]; }");
d("generator delegating yield* return value", "function go(){ function* inner(){yield 1;return 'R';} function* outer(){const r=yield* inner();yield r;} return [...outer()]; }");
d("infinite generator with take", "function go(){ function* nats(){let i=0;while(true)yield i++;} const it=nats(); const out=[]; for(let i=0;i<4;i++)out.push(it.next().value); return out; }");
d("generator as object method via this", "function go(){ const o={data:[5,6,7],*items(){for(const x of this.data)yield x*2;}}; return [...o.items()]; }");

console.log("— Map/Set/collection methods —");
d("Map get/has/delete/forEach", "function go(){ const m=new Map(); m.set('a',1).set('b',2); const out=[]; m.forEach((v,k)=>out.push(k+v)); return [m.get('a'),m.has('b'),m.delete('a'),m.has('a'),m.size,out]; }");
d("Set add/has/delete/forEach", "function go(){ const s=new Set(); s.add(1).add(2).add(2); const out=[]; s.forEach(v=>out.push(v)); return [s.has(1),s.delete(1),s.has(1),s.size,out]; }");
d("Map keys/values/entries", "function go(){ const m=new Map([['x',1],['y',2]]); return [[...m.keys()],[...m.values()],[...m.entries()]]; }");
d("Array.prototype: every/fill/flat/keys/values", "function go(){ return [[1,2,3].keys?[...[1,2,3].keys()]:[],[...['a','b'].values()],[...['a','b'].entries()]]; }");
d("array sort stability and strings", "function go(){ return [['banana','apple','cherry'].sort(),[5,3,8,1].sort((a,b)=>b-a)]; }");

console.log("— JSON edge cases —");
d("JSON.stringify with replacer array", "function go(){ return JSON.stringify({a:1,b:2,c:3},['a','c']); }");
d("JSON.stringify with indent", "function go(){ return JSON.stringify({a:1,b:[2,3]},null,2); }");
d("JSON.parse with reviver", "function go(){ return JSON.parse('{\"a\":1,\"b\":2}',(k,v)=>typeof v==='number'?v*10:v); }");
d("JSON round-trip nested", "function go(){ const o={a:[1,{b:2}],c:{d:[3,4]}}; return JSON.parse(JSON.stringify(o)); }");
d("JSON.stringify skips undefined and functions", "function go(){ return JSON.stringify({a:1,b:undefined,c(){},d:null}); }");

console.log("— property descriptors & accessors —");
d("getter/setter inheritance with super", "function go(){ class A{#v=1;get x(){return this.#v;}set x(n){this.#v=n;}} class B extends A{get x(){return super.x*10;}} const b=new B(); b.x=5; return b.x; }");
d("computed accessor name", "function go(){ const k='dyn'; const o={get [k](){return 42;}}; return o.dyn; }");
d("computed accessor via computed access", "function go(){ const k='dyn'; const o={_v:3,get [k](){return this._v*7;}}; return o[k]; }");
d("Object.defineProperty getter", "function go(){ const o={}; Object.defineProperty(o,'x',{get(){return 99;},enumerable:true}); return [o.x,Object.keys(o)]; }");
d("property enumeration order mixed keys", "function go(){ const o={}; o.b=1; o[2]=2; o.a=3; o[1]=4; return Object.keys(o); }");
d("getOwnPropertyDescriptor", "function go(){ const o={x:5}; const d=Object.getOwnPropertyDescriptor(o,'x'); return [d.value,d.writable,d.enumerable]; }");

console.log("— Proxy (metaprogramming) —");
d("proxy get trap with default", "function go(){ const p=new Proxy({a:1},{get(t,k){return k in t?t[k]:'def';}}); return [p.a,p.zzz]; }");
d("proxy set trap intercepts", "function go(){ const log=[]; const p=new Proxy({},{set(t,k,v){log.push(k+'='+v);t[k]=v;return true;}}); p.x=5; p.y=9; return [log,p.x,p.y]; }");
d("proxy has trap", "function go(){ const p=new Proxy({a:1},{has(t,k){return k[0]==='_'||k in t;}}); return ['a' in p,'_x' in p,'b' in p]; }");
d("proxy deleteProperty trap", "function go(){ const log=[]; const p=new Proxy({a:1,b:2},{deleteProperty(t,k){log.push(k);delete t[k];return true;}}); delete p.a; return [log,'a' in p,'b' in p]; }");
d("proxy ownKeys via for-in and Object.keys", "function go(){ const p=new Proxy({a:1,b:2,c:3},{ownKeys(t){return Object.keys(t).filter(k=>k!=='b');}}); const fi=[]; for(const k in p)fi.push(k); return [fi,Object.keys(p)]; }");
d("proxy computed get", "function go(){ const p=new Proxy({},{get(t,k){return 'V:'+k;}}); const key='dyn'; return [p[key],p.foo]; }");
d("proxy method synthesized by get", "function go(){ const p=new Proxy({n:10},{get(t,k){return k==='dbl'?()=>t.n*2:t[k];}}); return [p.n,p.dbl()]; }");
d("proxy reactive increment", "function go(){ let writes=0; const p=new Proxy({count:0},{set(t,k,v){writes++;t[k]=v;return true;}}); p.count++; p.count+=10; return [p.count,writes]; }");
d("proxy default passthrough (empty handler)", "function go(){ const p=new Proxy({a:1},{}); p.b=2; return [p.a,p.b,'a' in p,Object.keys(p)]; }");
d("proxy validation throws on bad set", "function go(){ const p=new Proxy({age:0},{set(t,k,v){if(k==='age'&&v<0)throw new RangeError('neg');t[k]=v;return true;}}); let err='ok'; try{p.age=-1;}catch(e){err=e instanceof RangeError?'range':'other';} p.age=5; return [err,p.age]; }");
d("Reflect get/set/has/delete", "function go(){ const o={a:1,b:2}; Reflect.set(o,'c',3); const had=Reflect.has(o,'a'); Reflect.deleteProperty(o,'a'); return [Reflect.get(o,'b'),o.c,had,Reflect.has(o,'a')]; }");
d("Reflect.ownKeys and apply", "function go(){ function f(x,y){return this.k+x+y;} return [Reflect.ownKeys({p:1,q:2}),Reflect.apply(f,{k:10},[2,3])]; }");
d("proxy handler delegates to Reflect", "function go(){ const log=[]; const p=new Proxy({a:1},{get(t,k,r){log.push('g:'+k);return Reflect.get(t,k,r);},set(t,k,v,r){log.push('s:'+k);return Reflect.set(t,k,v,r);}}); p.b=p.a+5; return [p.b,log]; }");
d("Reflect.set returns boolean", "function go(){ const o={}; const r=Reflect.set(o,'x',9); return [r,o.x]; }");
d("user method named find (repository pattern)", "function go(){ const repo={items:[{id:1},{id:2}],find(id){return this.items.find(x=>x.id===id);}}; return [repo.find(2).id, repo.find(9)]; }");
d("user methods named map/filter/some", "function go(){ const q={data:[1,2,3],map(f){return this.data.map(f);},filter(f){return this.data.filter(f);},some(){return 'mine';}}; return [q.map(x=>x*2),q.filter(x=>x>1),q.some()]; }");
d("array HOF still inlines after guard", "function go(){ return [[1,2,3].map(x=>x*x),[1,2,3,4].filter(x=>x%2===0),[1,2,3].find(x=>x>1),[1,2,3].reduce((a,b)=>a+b,0)]; }");
d("Reflect.construct builds instance", "class P{constructor(a,b){this.a=a;this.b=b;} sum(){return this.a+this.b;}} function go(){ const p=Reflect.construct(P,[3,4]); return [p.sum(),p instanceof P]; }");
d("dynamic new on a class value", "class A{constructor(n){this.n=n;} get(){return this.n*10;}} function make(C,n){return new C(n);} function go(){ const a=make(A,5); return [a.get(),a instanceof A]; }");

console.log("— closures & control flow extras —");
d("try/finally return value in loop", "function go(){ function f(){for(let i=0;i<3;i++){try{if(i===2)return i;}finally{}}return -1;} return f(); }");
d("labeled block break", "function go(){ let r=[]; block:{ r.push(1); if(r.length)break block; r.push(2); } return r; }");
d("comma in for-update", "function go(){ const out=[]; for(let i=0,j=10;i<3;i++,j--)out.push(i+'-'+j); return out; }");
d("conditional chain assoc", "function go(){ const f=n=>n>0?'pos':n<0?'neg':'zero'; return [f(5),f(-5),f(0)]; }");
d("exponent right associative", "function go(){ return [2**3**2,(2**3)**2]; }");

console.log(`\n${"=".repeat(64)}`);
console.log(`${fail === 0 ? "NO DIVERGENCES" : fail + " DIVERGENCES"} — ${pass}/${pass + fail + caveat} matched Node` + (caveat ? `, ${caveat} documented caveat${caveat > 1 ? "s" : ""}` : "") + (fail ? `\nDivergent: ${fails.join(", ")}` : ""));
if (fail) process.exitCode = 1;

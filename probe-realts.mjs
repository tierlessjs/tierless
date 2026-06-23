// Probe: compile real JS/TS and check Stackmix runs it IDENTICALLY to Node.
//
// Each snippet is valid JavaScript. We compile it with the Stackmix frontend and run
// it on the interpreter, AND we eval it in Node, and compare outputs. This is
// the honest test for "unlock real existing apps": fidelity against the actual
// JS engine across the new constructs (templates, default params, for-of, array
// literals, nested function declarations, destructuring, closures, control flow).

import { PROGRAM, run, initialFrames } from "./stackmix-core.mjs";
import { loadModule } from "./stackmix-tsc.mjs";

let pass = true;
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? "B:" + v.toString() : v)); // BigInt isn't JSON-safe
function check(name, src, entry, args) {
  let got, ref, err = null;
  try {
    loadModule(PROGRAM, src, { entry });
    got = run({ id: "t" }, initialFrames(entry, args), { deref: (x) => x }).value;
    ref = new Function(src + "\n;return " + entry + ";")()(...args); // Node's own execution
  } catch (e) { err = e; }
  const ok = !err && J(got) === J(ref);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { pass = false; if (err) console.log(`        error: ${err.message}`); else console.log(`        stackmix=${J(got)}  node=${J(ref)}`); }
}

console.log("Probe: compile real JS, compare Stackmix output to Node's eval\n");

check("templates + default param + for-of + nested fn decl",
`function summarize(rows, prefix = "row") {
  function tag(n) { return prefix + "#" + n; }
  const out = [];
  for (const r of rows) { out.push(\`\${tag(r.id)}=\${r.score}\`); }
  return out;
}`, "summarize", [[{ id: 1, score: 10 }, { id: 2, score: 20 }, { id: 3, score: 30 }]]);

check("array literals + ternary + while + break/continue",
`function fizz(n) {
  const out = [0, -1];
  let i = 1;
  while (true) {
    if (i > n) { break; }
    if (i === 4) { i = i + 1; continue; }
    out.push((i % 3 === 0) ? "fizz" : ("" + i));
    i = i + 1;
  }
  return out;
}`, "fizz", [6]);

check("object + array destructuring + template",
`function describe(p) {
  const { name, age } = p;
  const [first, second] = p.tags;
  return \`\${name} (\${age}) \${first}/\${second}\`;
}`, "describe", [{ name: "Ann", age: 30, tags: ["x", "y"] }]);

check("closures in an array + higher-order over for-of",
`function makeAdder(n) { return (x) => x + n; }
function applyAll(fns, x) { const out = []; for (const f of fns) { out.push(f(x)); } return out; }
function go() { const fns = [makeAdder(1), makeAdder(10), makeAdder(100)]; return applyAll(fns, 5); }`,
  "go", []);

check("nested destructuring + default + compound assignment",
`function total(order) {
  const { items, tax = 0 } = order;
  let sum = 0;
  for (const { price, qty } of items) { sum += price * qty; }
  return sum + sum * tax;
}`, "total", [{ items: [{ price: 10, qty: 2 }, { price: 5, qty: 3 }], tax: 0.1 }]);

check("array higher-order: map / filter / reduce (closures as callbacks)",
`function pipeline(xs) {
  const evens = xs.filter((x) => x % 2 === 0);
  const doubled = evens.map((x, i) => x * 2 + i);
  return doubled.reduce((a, b) => a + b, 0);
}`, "pipeline", [[1, 2, 3, 4, 5, 6]]);

check("string methods via CALLM + templates",
`function slugify(title) {
  return title.trim().toLowerCase().split(" ").join("-");
}`, "slugify", ["  Hello World Again  "]);

check("try / catch / throw (value thrown, caught, recovered)",
`function safeDiv(a, b) {
  try {
    if (b === 0) { throw { code: "DIV0" }; }
    return a / b;
  } catch (e) {
    return e.code === "DIV0" ? -1 : -2;
  }
}
function go() { return [safeDiv(10, 2), safeDiv(1, 0)]; }`, "go", []);

check("throw propagates across a call into an outer catch",
`function inner(x) { if (x < 0) { throw "negative"; } return x * 2; }
function outer(xs) {
  const out = [];
  for (const x of xs) {
    try { out.push(inner(x)); } catch (e) { out.push(e); }
  }
  return out;
}`, "outer", [[3, -1, 5]]);

check("class: constructor, fields, methods, this, new",
`class Counter {
  constructor(start) { this.n = start; }
  inc() { this.n = this.n + 1; }
  value() { return this.n; }
}
function go() { const c = new Counter(10); c.inc(); c.inc(); c.inc(); return c.value(); }`, "go", []);

check("class: method using a higher-order method + this",
`class Cart {
  constructor(items) { this.items = items; }
  total() { return this.items.reduce((a, it) => a + it.price * it.qty, 0); }
}
function go() { return new Cart([{ price: 10, qty: 2 }, { price: 5, qty: 3 }]).total(); }`, "go", []);

check("class: method calling another method + string method",
`class Greeter {
  constructor(name) { this.name = name; }
  greeting() { return "Hi " + this.name; }
  shout() { return this.greeting().toUpperCase() + "!"; }
}
function go() { return new Greeter("ann").shout(); }`, "go", []);

check("class with field defaults (no explicit constructor)",
`class Box {
  width = 4;
  height = 5;
  area() { return this.width * this.height; }
}
function go() { return new Box().area(); }`, "go", []);

check("class extends / super (constructor + method) / override",
`class Animal {
  constructor(name) { this.name = name; }
  speak() { return this.name + " makes a sound"; }
}
class Dog extends Animal {
  constructor(name) { super(name); this.legs = 4; }
  speak() { return super.speak() + " (woof)"; }
  describe() { return this.speak() + ", legs=" + this.legs; }
}
function go() { const d = new Dog("Rex"); return [d.name, d.legs, d.speak(), d.describe()]; }`, "go", []);

check("instanceof (incl. inheritance + negative cases)",
`class Animal { constructor(n) { this.n = n; } }
class Dog extends Animal { constructor(n) { super(n); } }
class Cat extends Animal { constructor(n) { super(n); } }
function go() {
  const d = new Dog("Rex"), c = new Cat("Tom");
  return [d instanceof Dog, d instanceof Animal, d instanceof Cat, c instanceof Animal, (5) instanceof Animal];
}`, "go", []);

check("getters/setters: get/set pair, read-only getter, compound through accessor",
`class Temp {
  constructor(c) { this._c = c; }
  get celsius() { return this._c; }
  set celsius(v) { this._c = v; }
  get fahrenheit() { return this._c * 9 / 5 + 32; }
  set fahrenheit(f) { this._c = (f - 32) * 5 / 9; }
}
class Rect {
  constructor(w, h) { this.w = w; this.h = h; }
  get area() { return this.w * this.h; }          // read-only computed
}
function go() {
  const t = new Temp(100);
  const f0 = t.fahrenheit;                          // 212 (getter)
  t.fahrenheit = 32;                                // setter -> _c = 0
  const c0 = t.celsius;                             // 0
  t.celsius += 25;                                  // compound: get then set -> 25
  const r = new Rect(3, 4);
  return { f0, c0, c: t.celsius, area: r.area };
}`, "go", []);

check("getter override through inheritance (derived wins)",
`class Shape { constructor(n) { this.n = n; } get label() { return "shape:" + this.n; } }
class Circle extends Shape { constructor(n) { super(n); } get label() { return "circle:" + this.n; } }
function go() { return [new Shape("a").label, new Circle("b").label]; }`, "go", []);

check("static members: methods, fields, mutation, static this, factory",
`class Counter {
  static total = 0;
  static unit = "n";
  static bump(by) { Counter.total += by; return Counter.tag(Counter.total); }   // mutates a static field
  static tag(v) { return v + this.unit; }                                       // static this = class object
  static make(start) { const c = new Counter(); c.v = start; return c; }        // factory
}
function go() {
  const a = Counter.bump(3);
  const b = Counter.bump(4);
  const made = Counter.make(10);
  return { a, b, total: Counter.total, unit: Counter.unit, made: made.v };
}`, "go", []);

check("static inheritance: derived sees base statics, override wins",
`class Base { static kind() { return "base"; } static shared() { return "S"; } }
class Mid extends Base { static kind() { return "mid"; } }
class Leaf extends Mid {}
function go() { return [Base.kind(), Mid.kind(), Leaf.kind(), Leaf.shared()]; }`, "go", []);

check("static getter/setter on the class object",
`class Config {
  static _level = 1;
  static get level() { return Config._level; }
  static set level(v) { Config._level = v < 0 ? 0 : v; }
}
function go() { const a = Config.level; Config.level = -5; const b = Config.level; Config.level = 9; return [a, b, Config.level]; }`, "go", []);

check("generators: yield, for-of consumption, return value, two-way next()",
`function* range(a, b) { for (let i = a; i < b; i++) { yield i; } return "done"; }
function* fib(n) { let x = 0, y = 1; for (let i = 0; i < n; i++) { yield x; const t = x + y; x = y; y = t; } }
function go() {
  const out = [];
  for (const a of range(1, 5)) { out.push(a); }   // for-of drives the generator
  const fibs = [];
  for (const b of fib(8)) { fibs.push(b); }
  // explicit next(): two-way (a sent value becomes the yield expression's value)
  function* echo() { const a = yield "first"; const b = yield a; return b; }
  const it = echo();
  const r0 = it.next();          // { value: "first", done: false }
  const r1 = it.next("X");       // a -> "X"; yields "X"
  const r2 = it.next("Y");       // b -> "Y"; returns "Y"
  return { out, fibs, r0, r1, r2 };
}`, "go", []);

check("generators: yield* delegation + spread-via-for-of into array",
`function* inner() { yield 1; yield 2; return 99; }
function* outer() { yield 0; const r = yield* inner(); yield r; yield 3; }
function collect(it) { const out = []; for (const v of it) { out.push(v); } return out; }
function go() { return collect(outer()); }`, "go", []);

check("generator methods + spread [...gen()] + f(...gen())",
`class Range {
  constructor(a, b) { this.a = a; this.b = b; }
  *values() { for (let i = this.a; i < this.b; i++) { yield i; } }   // generator method (this-bound)
}
function sum3(a, b, c) { return a + b + c; }
function go() {
  const r = new Range(1, 4);
  const viaForOf = [];
  for (const v of r.values()) { viaForOf.push(v); }
  const spread = [0, ...r.values(), 9];           // spread a fresh generator
  const called = sum3(...r.values());             // spread into a call
  return { viaForOf, spread, called };
}`, "go", []);

check("generator .return() runs finally on abandon; .throw() caught inside",
`function* withCleanup(log) {
  try { yield 1; yield 2; yield 3; } finally { log.push("cleanup"); }
}
function* catcher() {
  try { yield "a"; } catch (e) { yield "caught:" + e; } yield "after";
}
function go() {
  const log = [];
  const g = withCleanup(log);
  const first = g.next().value;        // 1
  const ret = g.return("STOP");        // runs finally -> { value:"STOP", done:true }
  const done = g.next();               // { value: undefined, done: true }
  const c = catcher();
  const c0 = c.next().value;           // "a"
  const c1 = c.throw("BOOM").value;    // "caught:BOOM"
  const c2 = c.next().value;           // "after"
  return { first, ret, done, log, c0, c1, c2 };
}`, "go", []);

check("stdlib globals: Math / Object / JSON / Array / Number / parseInt",
`function go() {
  const nums = [3, 1, 4, 1, 5];
  return {
    max: Math.max(...nums), min: Math.min(...nums), floor: Math.floor(2.9), abs: Math.abs(-3),
    keys: Object.keys({ a: 1, b: 2 }), values: Object.values({ a: 1, b: 2 }),
    merged: Object.assign({ a: 1 }, { b: 2 }),
    json: JSON.parse(JSON.stringify({ x: [1, 2], y: "z" })),
    isArr: [Array.isArray(nums), Array.isArray("no")], from: Array.from(nums),
    isInt: [Number.isInteger(5), Number.isInteger(5.5)],
    parsed: [parseInt("42px"), parseFloat("3.14"), isNaN(NaN), isFinite(9)],
    coerce: [Number("7") + 1, String(42) + "!", Boolean("")],
  };
}`, "go", []);

check("array higher-order: find / findIndex / some / every (early-terminating)",
`function go() {
  const a = [1, 2, 3, 4, 5];
  return {
    find: a.find((x) => x > 3), findIndex: a.findIndex((x) => x > 3),
    some: a.some((x) => x === 4), someN: a.some((x) => x > 9),
    every: a.every((x) => x > 0), everyN: a.every((x) => x > 2),
    flat: [1, [2, 3], [4, [5]]].flat(),
  };
}`, "go", []);

check("local class declarations (name collisions, capture, instanceof, extends, factory)",
`function a() { class Box { kind() { return "a"; } } return new Box().kind(); }
function b() { class Box { kind() { return "b"; } } return new Box().kind(); }   // same name, distinct class
function makeAdder(n) { class Adder { add(x) { return x + n; } } return new Adder(); } // captures outer n
function go() {
  class Animal { constructor(nm) { this.nm = nm; } speak() { return this.nm; } }
  class Dog extends Animal { speak() { return super.speak() + " woof"; } }  // local extends, no explicit ctor
  const d = new Dog("Rex");
  return { a: a(), b: b(), add: makeAdder(10).add(5), speak: d.speak(), isAnimal: d instanceof Animal, name: d.nm };
}`, "go", []);

check("implicit constructors: base with no ctor + super(), derived field inits after super, multi-level",
`class A { constructor(n) { this.n = n; } }
class B extends A {}                              // implicit ctor forwards args to super
class C extends B { c = this.n + 1; }            // implicit ctor: super() then field init
class Base { x = 5; y = 10; }                     // field-only, no ctor
class Sub extends Base { z = this.x + this.y; }
function go() {
  return { b: new B(7).n, c1: new C(3).n, c2: new C(3).c, base: new Base().x, sub: new Sub().z };
}`, "go", []);

check("arguments object (length, index, with named params, captured by nested arrow, spread)",
`function variadic() { let s = 0; for (let i = 0; i < arguments.length; i++) { s += arguments[i]; } return s; }
function tail(first) { return Array.from(arguments).slice(1); }
function viaArrow() { return (() => arguments[0] + arguments[1])(); }
function go() { return [variadic(1, 2, 3, 4), tail("a", "b", "c"), viaArrow(10, 20)]; }`, "go", []);

check("tagged templates (user tag + method tag + String.raw)",
`function tag(strs, ...vals) { let s = strs[0]; for (let i = 0; i < vals.length; i++) { s += "[" + vals[i] + "]" + strs[i + 1]; } return s; }
function go() {
  const x = 2, y = 3;
  const obj = { join(strs, ...v) { return strs[0] + v.join(",") + strs[strs.length - 1]; } };
  return [tag\`sum \${x}+\${y}\`, obj.join\`p\${x}q\${y}r\`, String.raw\`a\\nb\`];
}`, "go", []);

check("object literals with methods / getters / setters / generator methods (this-bound, data enumerable)",
`function go() {
  const o = {
    _v: 1, label: "x",
    get v() { return this._v; },
    set v(n) { this._v = n * 2; },
    dbl() { return this._v * 2; },
    chain() { return this.dbl() + 1; },
    *seq() { yield this._v; yield this._v + 1; },
  };
  const a = o.v; o.v = 5; const seq = []; for (const k of o.seq()) { seq.push(k); }
  return { a, after: o.v, dbl: o.dbl(), chain: o.chain(), seq, dataKeys: Object.keys(o).filter((k) => k !== "v") };
}`, "go", []);

check("++ / -- as expression values (postfix old / prefix new), props, elements, unary +/-",
`function go() {
  let i = 5;
  const post = i++;        // 5, i now 6
  const pre = ++i;         // 7, i now 7
  const o = { n: 10 };
  const op = o.n++;        // 10, o.n now 11
  const a = [1, 2, 3];
  const ae = a[1]--;       // 2, a[1] now 1
  const acc = [];
  let j = 0; while (j < 3) { acc.push(j++); }   // [0,1,2]
  return { post, pre, i, op, on: o.n, ae, a1: a[1], acc, coerce: [+"5", +"3.14", -"-2"] };
}`, "go", []);

check("instances enumerate like JS: JSON/keys/for-in see data only; computed access fires accessors",
`class Account {
  constructor(owner, balance) { this.owner = owner; this.balance = balance; }
  get summary() { return this.owner + ":" + this.balance; }
  set summary(v) { this.owner = v; }
  deposit(n) { this.balance += n; return this.balance; }
}
function go() {
  const a = new Account("ann", 100);
  a.deposit(50);
  const keys = []; for (const k in a) { keys.push(k); }
  const dynKey = "summary";
  const viaIndex = a[dynKey];        // computed access fires the getter
  a[dynKey] = "bob";                 // computed access fires the setter
  return { json: JSON.stringify(a), keys, objKeys: Object.keys(a), viaIndex, owner: a.owner, bal: a.balance };
}`, "go", []);

check("destructuring parameters (object/array, mixed, nested, defaults, capture)",
`function pt({ x, y }) { return x + y; }
function mix(a, [b, c], { d }) { return a + b + c + d; }
function opts({ scale = 2, offset = 0 } = {}) { return (n) => n * scale + offset; }
function nested({ p: { q } }) { return q; }
function go() {
  return [pt({ x: 3, y: 4 }), mix(1, [2, 3], { d: 4 }), opts()(10), opts({ scale: 3 })(10), opts({ scale: 3, offset: 1 })(10), nested({ p: { q: 9 } })];
}`, "go", []);

check("arrow functions capture lexical this (incl. nested) + private fields/methods",
`class Counter {
  #count = 0;                                   // private field
  #step() { return 2; }                         // private method
  constructor(items) { this.items = items; this.mult = 10; }
  scaledMap() { return this.items.map((x) => x * this.mult); }   // arrow sees this.mult
  nested() { const f = () => () => this.mult + 1; return f()(); } // nested arrows
  bump() { this.#count += this.#step(); return this.#count; }
}
function go() {
  const c = new Counter([1, 2, 3]);
  return { scaled: c.scaledMap(), nested: c.nested(), bumps: [c.bump(), c.bump()], ty: [typeof nope, typeof c.mult] };
}`, "go", []);

check("Map / Set: construct, methods, for-of, spread, size",
`function go() {
  const m = new Map([["a", 1], ["b", 2]]);
  m.set("c", 3);
  let total = 0; for (const [k, v] of m) { total += v; }
  const s = new Set([1, 2, 2, 3]); s.add(4);
  const doubled = []; for (const v of s) { doubled.push(v * 2); }
  return { get: m.get("b"), has: [m.has("a"), m.has("z")], size: m.size, total, keys: [...m.keys()], setHas: s.has(2), setSize: s.size, doubled, spread: [...s] };
}`, "go", []);

check("user methods named get/set/has are NOT hijacked by host-method dispatch",
`class Box { constructor(v) { this.v = v; } get() { return this.v * 2; } set(x) { this.v = x; } has() { return this.v > 0; } }
function go() { const b = new Box(5); const a = b.get(); b.set(10); return [a, b.get(), b.has()]; }`, "go", []);

check("for-of over a string",
`function go() { const out = []; for (const c of "hi!") { out.push(c); } return out; }`, "go", []);

check("destructuring defaults + rest (object & array, nested, for-of)",
`function go() {
  const { a = 5, b = 2, ...restO } = { a: 10, c: 3, d: 4 };
  const [x = 1, y = 2, ...restA] = [100, undefined, 7, 8];
  const { p: { q = 9 } = {} } = { p: {} };
  const collected = [];
  for (const { v = -1 } of [{ v: 1 }, {}, { v: 3 }]) { collected.push(v); }
  return { a, b, restO, x, y, restA, q, collected };
}`, "go", []);

check("yield* forwards sent values + delegates return value",
`function* inner() { const a = yield "first"; const b = yield a; return [a, b]; }
function* outer() { const r = yield* inner(); yield r; }
function go() {
  const it = outer();
  return [it.next().value, it.next("A").value, it.next("B").value, it.next().value, it.next().done];
}`, "go", []);

check("functions/generators with no explicit return yield undefined (not 0)",
`function go() {
  function noReturn() {}
  function emptyReturn(x) { if (x) { return; } return 5; }
  function* genNoReturn() { yield 1; }
  const it = genNoReturn();
  return [noReturn(), emptyReturn(true), emptyReturn(false), it.next().value, it.next().value, it.next().done];
}`, "go", []);

check("block scoping: same name in sibling/nested blocks, shadowing",
`function go() {
  const out = [];
  for (const v of [1, 2, 3]) { out.push(v); }   // two loops reuse \`v\`
  for (const v of [10, 20]) { out.push(v); }
  let x = 1;
  { let x = 2; out.push(x); { let x = 3; out.push(x); } out.push(x); }
  out.push(x);
  if (out.length > 0) { let t = "a"; out.push(t); } else { let t = "b"; out.push(t); }
  return out;
}`, "go", []);

check("per-iteration let binding: closures capture each iteration's value",
`function go() {
  const fns = [];
  for (let i = 0; i < 3; i++) { fns.push(() => i); }              // [0,1,2], not [3,3,3]
  const nested = [];
  for (let i = 0; i < 2; i++) { for (let j = 0; j < 2; j++) { nested.push(() => i * 10 + j); } }
  const withSkip = [];
  for (let i = 0; i < 4; i++) { if (i === 1) { continue; } withSkip.push(() => i); }
  return { simple: fns.map((f) => f()), nested: nested.map((f) => f()), withSkip: withSkip.map((f) => f()) };
}`, "go", []);

check("for-in + computed object keys + delete",
`function go(o) {
  const out = {};
  for (const k in o) { out[k] = o[k] * 2; }
  const key = "z";
  out[key] = 99;
  const tag = { [key + "1"]: 1, ["k" + 2]: 2 };
  delete out.a;
  return { out, tag };
}`, "go", [{ a: 1, b: 2, c: 3 }]);

check("try / finally (runs on normal and on throw) + comma + bitwise",
`function go() {
  const log = [];
  function attempt(x) {
    try {
      if (x < 0) { throw "neg"; }
      return x;
    } finally {
      log.push("cleanup");
    }
  }
  let caught = "none";
  try { attempt(-1); } catch (e) { caught = e; }
  const ok = attempt(5);
  const bits = (5 & 3) | (8 >> 1);
  const c = (log.push("x"), bits);
  return { log, caught, ok, bits, c, masked: ~0 };
}`, "go", []);

check("finally runs on return / break / continue, and nested + override",
`function go() {
  const log = [];
  function ret(x) { try { if (x < 0) { return "neg"; } return "pos"; } finally { log.push("f" + x); } }
  function loopBreak() {
    const seen = [];
    for (let i = 0; i < 5; i++) {
      try { if (i === 2) { break; } if (i === 1) { continue; } seen.push(i); } finally { log.push("L" + i); }
    }
    return seen;
  }
  function nested() {
    try { try { return "inner"; } finally { log.push("a"); } } finally { log.push("b"); }
  }
  function override() { try { return "x"; } finally { return "y"; } }   // finally's return wins
  const r1 = ret(5), r2 = ret(-1);
  const sb = loopBreak();
  const n = nested();
  const ov = override();
  return { r1, r2, sb, n, ov, log };
}`, "go", []);

check("do-while + labeled break/continue across nested loops",
`function go() {
  const out = [];
  let i = 0;
  do { out.push("d" + i); i++; } while (i < 3);
  outer: for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      if (b === 1) { continue outer; }
      if (a === 2) { break outer; }
      out.push(a + "," + b);
    }
  }
  return out;
}`, "go", []);

check("labeled continue runs finally on the way out",
`function go() {
  const log = [];
  loop: for (let i = 0; i < 3; i++) {
    try { if (i === 1) { continue loop; } log.push("body" + i); } finally { log.push("fin" + i); }
  }
  return log;
}`, "go", []);

check("return value computed before finally mutates it",
`function go() {
  let n = 1;
  function f() { try { return n; } finally { n = 99; } }   // returns 1, not 99
  const r = f();
  return { r, n };
}`, "go", []);

check("BigInt: literals, arithmetic, division-truncates, **, compare, typeof, BigInt()",
`function go() {
  const a = 9007199254740993n;        // > Number.MAX_SAFE_INTEGER, exact in BigInt
  const b = a + 1n;
  const fact = (n) => { let p = 1n; for (let i = 1n; i <= n; i++) { p *= i; } return p; };
  return {
    sum: (a + b).toString(),
    div: (7n / 2n).toString(),         // truncates to 3n
    pow: (2n ** 64n).toString(),
    mod: (10n % 3n).toString(),
    bits: ((255n & 0x0fn) | (1n << 8n)).toString(),
    cmp: [1n < 2n, 2n === 2n, 1n == 1, 1n === 1],
    ty: typeof a,
    conv: (BigInt(42) + 8n).toString(),
    big: fact(25n).toString(),
  };
}`, "go", []);

check("regex: test / match / replace",
`function go(s) {
  const re = /[a-z]+/g;
  return { has: /\\d/.test(s), words: s.match(/[a-z]+/g), up: s.replace(/o/g, "0") };
}`, "go", ["foo 12 bar"]);

check("nullish ?? + let-no-init + typeof",
`function pick(a, b) {
  let chosen;
  chosen = a ?? b;
  return typeof chosen + ":" + chosen;
}
function go() { return [pick(0, 9), pick(undefined, 9), pick(null, 7), pick("x", 1)]; }`, "go", []);

check("switch with fall-through + default",
`function classify(n) {
  switch (n) {
    case 0: return "zero";
    case 1:
    case 2: return "small";
    case 3: { const s = "thr" + "ee"; return s; }
    default: return "big";
  }
}
function go() { return [0,1,2,3,9].map((n) => classify(n)); }`, "go", []);

check("logical assignment ??= ||= &&=",
`function norm(o) {
  o.a ??= 10;
  o.b ||= 20;
  o.c &&= 30;
  return o;
}
function go() { return norm({ a: undefined, b: 0, c: 5 }); }`, "go", []);

check("exponent ** + void + switch break",
`function go() {
  let out = [];
  for (let i = 0; i < 4; i++) {
    switch (i) {
      case 1: out.push(-1); break;
      case 2: out.push(2 ** 10); break;
      default: out.push(i);
    }
  }
  out.push(void 99);
  return out;
}`, "go", []);

check("optional chaining ?. (property, index, call) with short-circuit",
`function read(o) {
  return [o?.a?.b ?? "none", o?.list?.[0], o?.fn?.(3)];
}
function go() {
  return [
    read({ a: { b: 5 }, list: [9], fn: (x) => x * 2 }),
    read({ a: null }),
    read(null),
  ];
}`, "go", []);

check("rest parameters + spread call into them",
`function sum(first, ...rest) {
  let s = first;
  for (const x of rest) { s += x; }
  return s;
}
function go() { const more = [4, 5]; return [sum(1), sum(1, 2, 3), sum(10, 20), sum(1, ...more, 6)]; }`, "go", []);

check("spread: array, object, and call",
`function add3(a, b, c) { return a + b + c; }
function go() {
  const xs = [1, 2];
  const arr = [0, ...xs, 3];
  const base = { a: 1, b: 2 };
  const obj = { ...base, b: 20, c: 30 };
  const args = [4, 5, 6];
  return { arr, obj, sum: add3(...args) };
}`, "go", []);

// Async snippets: no genuine async resource, so Stackmix runs them synchronously
// (await of a plain value = identity); Node runs them as real Promises, so we
// await its result and compare the resolved values.
async function checkAsync(name, src, entry, args) {
  let got, ref, err = null;
  try {
    loadModule(PROGRAM, src, { entry });
    got = run({ id: "t" }, initialFrames(entry, args), { deref: (x) => x }).value;
    ref = await new Function(src + "\n;return " + entry + ";")()(...args);
  } catch (e) { err = e; }
  const ok = !err && J(got) === J(ref);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { pass = false; if (err) console.log(`        error: ${err.message}`); else console.log(`        stackmix=${J(got)}  node=${J(ref)}`); }
}

await checkAsync("async generator + for await (yield + await compose)",
`async function* numbers(n) {
  for (let i = 0; i < n; i++) { const v = await Promise.resolve(i * 10); yield v; }
}
async function go() {
  const out = [];
  for await (const x of numbers(4)) { out.push(x + 1); }
  return out;
}`, "go", []);

await checkAsync("async/await between functions (no Promise object)",
`async function double(x) { return x * 2; }
async function go() { const a = await double(5); const b = await double(a); return a + b; }`, "go", []);

await checkAsync("Promise.resolve + Promise.all + reduce",
`async function go() {
  const xs = await Promise.all([Promise.resolve(1), Promise.resolve(2), 3]);
  return xs.reduce((a, b) => a + b, 0);
}`, "go", []);

await checkAsync("Promise.reject caught via try/catch around await",
`async function risky(fail) { if (fail) { return Promise.reject({ code: "X" }); } return "ok"; }
async function go() {
  let r1, r2;
  try { r1 = await risky(false); } catch (e) { r1 = "caught:" + e.code; }
  try { r2 = await risky(true); } catch (e) { r2 = "caught:" + e.code; }
  return [r1, r2];
}`, "go", []);

console.log(`\nResult: ${pass ? "all PASS" : "FAILURES"} — Stackmix compiles real JS and matches Node's own`);
console.log(`execution across templates, default params, for-of, array/object literals,`);
console.log(`destructuring (incl. nested), nested function declarations, and closures.`);
if (!pass) process.exitCode = 1;

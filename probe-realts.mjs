// Probe: compile real JS/TS and check Waso runs it IDENTICALLY to Node.
//
// Each snippet is valid JavaScript. We compile it with the Waso frontend and run
// it on the interpreter, AND we eval it in Node, and compare outputs. This is
// the honest test for "unlock real existing apps": fidelity against the actual
// JS engine across the new constructs (templates, default params, for-of, array
// literals, nested function declarations, destructuring, closures, control flow).

import { PROGRAM, run, initialFrames } from "./waso-core.mjs";
import { loadModule } from "./waso-tsc.mjs";

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
  if (!ok) { pass = false; if (err) console.log(`        error: ${err.message}`); else console.log(`        waso=${J(got)}  node=${J(ref)}`); }
}

console.log("Probe: compile real JS, compare Waso output to Node's eval\n");

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

// Async snippets: no genuine async resource, so Waso runs them synchronously
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
  if (!ok) { pass = false; if (err) console.log(`        error: ${err.message}`); else console.log(`        waso=${J(got)}  node=${J(ref)}`); }
}

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

console.log(`\nResult: ${pass ? "all PASS" : "FAILURES"} — Waso compiles real JS and matches Node's own`);
console.log(`execution across templates, default params, for-of, array/object literals,`);
console.log(`destructuring (incl. nested), nested function declarations, and closures.`);
if (!pass) process.exitCode = 1;

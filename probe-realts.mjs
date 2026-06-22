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
function check(name, src, entry, args) {
  let got, ref, err = null;
  try {
    loadModule(PROGRAM, src, { entry });
    got = run({ id: "t" }, initialFrames(entry, args), { deref: (x) => x }).value;
    ref = new Function(src + "\n;return " + entry + ";")()(...args); // Node's own execution
  } catch (e) { err = e; }
  const ok = !err && JSON.stringify(got) === JSON.stringify(ref);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { pass = false; if (err) console.log(`        error: ${err.message}`); else console.log(`        waso=${JSON.stringify(got)}  node=${JSON.stringify(ref)}`); }
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

console.log(`\nResult: ${pass ? "all PASS" : "FAILURES"} — Waso compiles real JS and matches Node's own`);
console.log(`execution across templates, default params, for-of, array/object literals,`);
console.log(`destructuring (incl. nested), nested function declarations, and closures.`);
if (!pass) process.exitCode = 1;

// Probe: the AOT compiler runs classes — and still matches the interpreter.
//
// The frontend desugars a class to plain machinery the compiler already has: an
// instance is an object (NEWOBJ), each method is a closure that captures the
// instance as `this` and is stored as a hidden property (SETHIDDEN), `new` runs
// the constructor closure, a method call looks the closure up and calls it
// (CALLMETHOD), `this` reads the captured instance (LOADTHIS), and super is just
// MAKECLOSURE of the parent method/constructor re-capturing the instance (the
// "E" capture) + CALLV. instanceof (ISA) searches the instance's hidden
// __class__ name list. Each program runs interpreted (tsc.mjs + core.mjs) and
// compiled to native wasm; the decoded native value must equal the interpreter's.

import { createRuntime, initialFrames } from "#stackmix";
import { compileModuleToWasm } from "#stackmix/wasm/frontend.mjs";
import { BUMP_ADDR, HEAP_BASE, readValue, stdlibHost } from "#stackmix/wasm/aot.mjs";

const programs = [
  ["constructor + field + methods + this", `
    class Counter { constructor(s) { this.n = s; } inc() { this.n = this.n + 1; } value() { return this.n; } }
    function main() { const c = new Counter(10); c.inc(); c.inc(); c.inc(); return c.value(); }`], // 13
  ["field defaults, no explicit constructor", `
    class Box { w = 4; h = 5; area() { return this.w * this.h; } }
    function main() { return new Box().area(); }`],                                                  // 20
  ["two instances keep independent state", `
    class P { constructor(x) { this.x = x; } get() { return this.x; } }
    function main() { const a = new P(1), b = new P(2); b.get(); return a.get() + b.get(); }`],       // 3
  ["a method calls another method (this-bound)", `
    class Cart { constructor(items) { this.items = items; } unit() { return 10; } total() { return this.items * this.unit(); } }
    function main() { return new Cart(3).total(); }`],                                                // 30
  ["string field through methods", `
    class Greeter { constructor(name) { this.name = name; } greeting() { return "Hi " + this.name; } shout() { return this.greeting() + "!"; } }
    function main() { return new Greeter("ann").shout(); }`],                                         // "Hi ann!"
  ["inheritance: super in constructor + method override", `
    class Animal { constructor(name) { this.name = name; } speak() { return this.name + " sound"; } }
    class Dog extends Animal { constructor(name) { super(name); this.legs = 4; } speak() { return super.speak() + " woof"; } describe() { return this.speak() + " legs=" + this.legs; } }
    function main() { return new Dog("Rex").describe(); }`],                                          // "Rex sound woof legs=4"
  ["multi-level field via super", `
    class A { constructor(n) { this.n = n; } }
    class B extends A { constructor(n) { super(n); this.k = 2; } sum() { return this.n + this.k; } }
    function main() { return new B(7).sum(); }`],                                                     // 9
  ["instanceof: derived is its base", `
    class A { constructor() {} }
    class B extends A { constructor() { super(); } }
    function main() { const b = new B(); return b instanceof A; }`],                                  // true
  ["instanceof: unrelated class is false", `
    class A { constructor() {} }
    class C { constructor() {} }
    function main() { return new A() instanceof C; }`],                                               // false
  ["instanceof: a non-object is false", `
    class A { constructor() {} }
    function main() { return 5 instanceof A; }`],                                                     // false
  ["instanceof: own class is true", `
    class A { constructor() {} }
    function main() { return new A() instanceof A; }`],                                               // true
  ["a method extracted as a value keeps its this", `
    class C { constructor() { this.n = 3; } get() { return this.n; } }
    function main() { const c = new C(); const f = c.get; return f(); }`],                            // 3 (method captured this)
  ["method value through a variable", `
    class Box { constructor(v) { this.v = v; } val() { return this.v + 1; } }
    function main() { const b = new Box(7); const m = b.val; return m(); }`],                         // 8
  ["getter computes from a field", `
    class C { constructor() { this._v = 1; } get x() { return this._v * 2; } }
    function main() { return new C().x; }`],                                                          // 2
  ["getter + setter round-trip", `
    class C { constructor() { this._v = 1; } get x() { return this._v * 2; } set x(n) { this._v = n; } }
    function main() { const c = new C(); c.x = 10; return c.x; }`],                                   // set _v=10, get 20
  ["a setter mutates through to another getter", `
    class Temp { constructor(c) { this._c = c; } get celsius() { return this._c; } set celsius(v) { this._c = v + 1; } }
    function main() { const t = new Temp(0); t.celsius = 24; return t.celsius; }`],                   // 25
  ["plain fields coexist with accessors", `
    class C { constructor() { this.n = 5; this._v = 2; } get x() { return this._v * 10; } }
    function main() { const c = new C(); return c.n + c.x; }`],                                       // 5 + 20 = 25
  ["static field", `
    class C { static count = 5; }
    function main() { return C.count; }`],                                                            // 5
  ["static method", `
    class C { static make(n) { return n * 2; } }
    function main() { return C.make(3); }`],                                                          // 6
  ["static field and method together", `
    class C { static s = 5; static make(n) { return n * 2; } }
    function main() { return C.s + C.make(3); }`],                                                    // 11
  ["statics coexist with an instance", `
    class C { static s = 1; constructor(x) { this.n = x; } get() { return this.n; } }
    function main() { const c = new C(15); return c.get() + C.s; }`],                                 // 16
  ["a static method calls another static method", `
    class C { static base() { return 10; } static plus(n) { return C.base() + n; } }
    function main() { return C.plus(5); }`],                                                          // 15
  ["a mutated static field is memoized", `
    class C { static n = 5; static bump() { C.n = C.n + 1; return C.n; } }
    function main() { C.bump(); return C.bump(); }`],                                                 // 6 then 7
];

function interp(src) {
  const rt = createRuntime();
  rt.load(src, { entry: "main", resources: [] });
  return rt.run({ id: "t" }, initialFrames("main", []), { deref: (x) => x }).value;
}
function native(src) {
  const sh = stdlibHost();
  const inst = new WebAssembly.Instance(new WebAssembly.Module(compileModuleToWasm(src, { entry: "main", resources: [] })), { env: sh.imports });
  sh.bind(inst);
  new DataView(inst.exports.memory.buffer).setInt32(BUMP_ADDR, HEAP_BASE, true);
  return readValue(inst.exports.memory, inst.exports.main());
}

const results = [];
for (const [name, src] of programs) {
  const i = interp(src), n = native(src);
  const ok = Object.is(i, n);
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: interpreter ${JSON.stringify(i)} == native ${JSON.stringify(n)}`);
}
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — the AOT compiler runs classes (fields, methods, this, new, inheritance, super, instanceof) and matches the interpreter`);
process.exit(ok ? 0 : 1);

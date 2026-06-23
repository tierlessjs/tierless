// Probe: does a COMPILED-to-wasm continuation survive serialize + resume in a
// FRESH instance? (de-risks the IR->wasm + Asyncify direction — design §4.1/§8)
//
// We build a tiny wasm module with Binaryen — main() calls inner() calls an
// imported resource() — and run it through the Asyncify pass. At the resource
// call we UNWIND (Asyncify writes the live call stack, both frames' locals, into
// linear memory), slice those bytes out, ship them through JSON (proving they're
// plain serializable data), load them into a SECOND fresh instance of the same
// module, and REWIND to resume. The result can only match the non-suspended run
// if BOTH frames' locals (main's y=100 and inner's x=10) crossed the wire. This
// is the compiled-code analog of the JS-interpreter capture, and the foundational
// proof for compiling the IR to wasm while keeping continuations migratable.

import binaryen from "binaryen";

const DATA_PTR = 16;            // Asyncify data struct in linear memory: [i32 cur, i32 end]
const STACK_BASE = 1024;        // where the unwound call stack gets written
const STACK_END = 8192;         // end of that region (and how many bytes we ship)
const RESOURCE_RESULT = 42;     // what the (stubbed) resource resolves to
const EXPECT = 100 + (10 + RESOURCE_RESULT); // main = y + (x + resource) = 152

function buildModule() {
  const m = new binaryen.Module();
  m.setMemory(1, 1, "memory");
  m.addFunctionImport("resource", "env", "resource", binaryen.none, binaryen.i32);
  // inner(): x=10; r=resource(); return x+r     (x must survive the suspend)
  m.addFunction("inner", binaryen.none, binaryen.i32, [binaryen.i32, binaryen.i32],
    m.block(null, [
      m.local.set(0, m.i32.const(10)),
      m.local.set(1, m.call("resource", [], binaryen.i32)),
      m.return(m.i32.add(m.local.get(0, binaryen.i32), m.local.get(1, binaryen.i32))),
    ], binaryen.i32));
  // main(): y=100; s=inner(); return y+s        (y is a SECOND live frame)
  m.addFunction("main", binaryen.none, binaryen.i32, [binaryen.i32, binaryen.i32],
    m.block(null, [
      m.local.set(0, m.i32.const(100)),
      m.local.set(1, m.call("inner", [], binaryen.i32)),
      m.return(m.i32.add(m.local.get(0, binaryen.i32), m.local.get(1, binaryen.i32))),
    ], binaryen.i32));
  m.addFunctionExport("main", "main");
  if (!m.validate()) throw new Error("module did not validate");
  m.runPasses(["asyncify"]);     // instrument: unwind/rewind the stack to/from linear memory
  return m.emitBinary().slice(); // detached copy of the bytes
}

function instantiate(bytes, onResource) {
  const holder = {};
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: { resource: () => onResource(holder.ex) },
  });
  holder.ex = inst.exports;
  return inst.exports;
}

const i32 = (mem, addr) => new DataView(mem.buffer).getInt32(addr, true);
const seti32 = (mem, addr, v) => new DataView(mem.buffer).setInt32(addr, v, true);

const results = [];
const check = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };

const bytes = buildModule();

// --- baseline: same module, resource returns straight through (no unwind) -----
const baseEx = instantiate(bytes, () => RESOURCE_RESULT);
check(`baseline (no suspend) == ${EXPECT}`, baseEx.main() === EXPECT);

// --- migrate: instance A suspends at resource, fresh instance B resumes --------
// A: resource UNWINDS — Asyncify writes the live stack into memory at STACK_BASE.
const A = instantiate(bytes, (ex) => { ex.asyncify_start_unwind(DATA_PTR); return 0; });
seti32(A.memory, DATA_PTR, STACK_BASE);        // data struct: cur, end
seti32(A.memory, DATA_PTR + 4, STACK_END);
A.main();                                       // runs, unwinds back out to here
A.asyncify_stop_unwind();

const used = i32(A.memory, DATA_PTR) - STACK_BASE;              // bytes the live stack actually took
const blob = Array.from(new Uint8Array(A.memory.buffer, 0, STACK_END));
const shipped = JSON.parse(JSON.stringify(blob));               // prove it's plain serializable data

// B: a FRESH instance of the SAME module; load the bytes and REWIND to resume.
const B = instantiate(bytes, (ex) => { ex.asyncify_stop_rewind(); return RESOURCE_RESULT; });
new Uint8Array(B.memory.buffer).set(Uint8Array.from(shipped)); // restore the continuation
B.asyncify_start_rewind(DATA_PTR);
const resumed = B.main();

check(`resumed in a FRESH instance == ${EXPECT} (both frames' locals survived)`, resumed === EXPECT);
check(`continuation was plain serializable bytes`, Array.isArray(shipped) && shipped.length === STACK_END);
check(`a second, independent migration is reproducible`, (() => {
  const A2 = instantiate(bytes, (ex) => { ex.asyncify_start_unwind(DATA_PTR); return 0; });
  seti32(A2.memory, DATA_PTR, STACK_BASE); seti32(A2.memory, DATA_PTR + 4, STACK_END);
  A2.main(); A2.asyncify_stop_unwind();
  const wire = JSON.parse(JSON.stringify(Array.from(new Uint8Array(A2.memory.buffer, 0, STACK_END))));
  const B2 = instantiate(bytes, (ex) => { ex.asyncify_stop_rewind(); return RESOURCE_RESULT; });
  new Uint8Array(B2.memory.buffer).set(Uint8Array.from(wire));
  B2.asyncify_start_rewind(DATA_PTR);
  return B2.main() === EXPECT;
})());

console.log(`\n  live continuation captured: ${used} B (a 2-frame compiled-wasm call stack)`);
const ok = results.every(Boolean);
console.log(`\nResult: ${ok ? "ALL PASS" : "FAILURES"} — a compiled-wasm continuation serialized and resumed in a fresh instance`);
process.exit(ok ? 0 : 1);

// Stackmix — AOT compiler: Stackmix IR -> WASM, via Binaryen (the start of the
// browser execution path; design §4.1). This is the *compiler* track, distinct
// from the interpreter in interpreter.wat: here each IR function becomes a real
// WASM function, so the program runs natively rather than being stepped.
//
// Scope (first slice): a straight-line numeric subset — PUSH, LOAD, STORE, POP,
// ADD/SUB/MUL/LT/GE, CALL (user function), RES (resource = the suspend point),
// RET. Control flow (JMP/JMPF via Binaryen's Relooper) and a real value model
// are the next slices; this one exists to prove the codegen integrates with
// Asyncify so a *compiled* continuation stays serializable/migratable.
//
// Key lowering choice: the IR operand stack is spilled into WASM locals (one
// scratch local per stack slot), not built as expression trees. So at a RES the
// entire live state of a frame is in WASM locals — exactly what Asyncify saves
// when it unwinds a frame into linear memory. That is what keeps the compiled
// continuation capturable.

import binaryen from "binaryen";

const DELTA = { PUSH: 1, LOAD: 1, STORE: -1, POP: -1, ADD: -1, SUB: -1, MUL: -1, LT: -1, GE: -1, RET: -1 };
const stackDelta = (ins) => (ins[0] === "CALL" || ins[0] === "RES" ? 1 - (ins[2] || 0) : DELTA[ins[0]] ?? 0);

function maxStack(code) {
  let h = 0, max = 0;
  for (const ins of code) { h += stackDelta(ins); if (h > max) max = h; }
  return max;
}

// program: { name: { argc?, nlocals, code } }. resources: import names a RES can
// call. Returns wasm bytes, Asyncify-instrumented unless asyncify:false.
export function compileToWasm(program, { entry = "main", resources = [], asyncify = true } = {}) {
  const m = new binaryen.Module();
  m.setMemory(1, 1, "memory");
  const I32 = binaryen.i32;
  for (const r of resources) m.addFunctionImport(r, "env", r, binaryen.createType([]), I32); // 0-arg i32 resources (subset)

  for (const [name, fn] of Object.entries(program)) {
    const argc = fn.argc || 0;
    const nl = fn.nlocals;
    const scratch = (k) => nl + k;            // operand-stack slots live above the IR locals
    const get = (i) => m.local.get(i, I32);
    let h = 0;                                 // compile-time stack height
    const stmts = [];
    let result = null;
    for (const ins of fn.code) {
      switch (ins[0]) {
        case "PUSH": stmts.push(m.local.set(scratch(h), m.i32.const(ins[1]))); h++; break;
        case "LOAD": stmts.push(m.local.set(scratch(h), get(ins[1]))); h++; break;
        case "STORE": h--; stmts.push(m.local.set(ins[1], get(scratch(h)))); break;
        case "POP": h--; break;
        case "ADD": case "SUB": case "MUL": case "LT": case "GE": {
          h -= 2; const a = get(scratch(h)), b = get(scratch(h + 1));
          const e = ins[0] === "ADD" ? m.i32.add(a, b) : ins[0] === "SUB" ? m.i32.sub(a, b)
            : ins[0] === "MUL" ? m.i32.mul(a, b) : ins[0] === "LT" ? m.i32.lt_s(a, b) : m.i32.ge_s(a, b);
          stmts.push(m.local.set(scratch(h), e)); h++; break;
        }
        case "CALL": case "RES": {              // RES targets an import of the same name; both leave a value
          const ac = ins[2] || 0; h -= ac;
          const args = []; for (let k = 0; k < ac; k++) args.push(get(scratch(h + k)));
          stmts.push(m.local.set(scratch(h), m.call(ins[1], args, I32))); h++; break;
        }
        case "RET": h--; result = get(scratch(h)); break;
        default: throw new Error("aot: unsupported opcode " + ins[0]);
      }
    }
    const extra = (nl - argc) + maxStack(fn.code);  // IR locals beyond params + scratch slots
    const body = m.block(null, result ? [...stmts, result] : stmts, result ? I32 : binaryen.none);
    m.addFunction(name, binaryen.createType(new Array(argc).fill(I32)), I32, new Array(extra).fill(I32), body);
  }

  m.addFunctionExport(entry, entry);
  if (!m.validate()) { const txt = m.emitText(); throw new Error("aot: module did not validate\n" + txt); }
  if (asyncify) m.runPasses(["asyncify"]); // unwind/rewind frames to/from linear memory
  return m.emitBinary().slice();
}

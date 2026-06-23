// Stackmix — AOT compiler: Stackmix IR -> WASM, via Binaryen (the browser
// execution path; design §4.1). Each IR function becomes a real WASM function,
// so the program runs natively rather than being stepped by an interpreter.
//
// Scope: a numeric subset with control flow — PUSH, LOAD, STORE, POP,
// ADD/SUB/MUL/LT/GE, CALL (user function), RES (resource = the suspend point),
// RET, and JMP/JMPF (resolved label or index targets). A real value model (WASM
// GC / tagged) and the §5 heap are the next slices.
//
// Two load-bearing choices:
//   - Control flow: the IR is split into basic blocks and handed to Binaryen's
//     Relooper, which turns the arbitrary JMP/JMPF graph into structured WASM
//     control flow. The IR is assumed balanced — operand stack empty at every
//     block boundary (true of IR compiled from structured source); a block that
//     leaves the stack non-empty is rejected.
//   - Capture: the operand stack is spilled into WASM locals (one scratch local
//     per slot), so at a RES the whole live frame is in locals — exactly what
//     Asyncify saves when it unwinds a frame into linear memory, which is what
//     keeps a *compiled* continuation serializable/migratable.

import binaryen from "binaryen";

const DELTA = { PUSH: 1, LOAD: 1, STORE: -1, POP: -1, ADD: -1, SUB: -1, MUL: -1, LT: -1, GE: -1, RET: -1, JMPF: -1, JMP: 0 };
const delta = (ins) => (ins[0] === "CALL" || ins[0] === "RES" ? 1 - (ins[2] || 0) : DELTA[ins[0]] ?? 0);

// Labeled asm -> instruction list with JMP/JMPF targets resolved to indices.
function resolveLabels(rawCode) {
  const labels = {}, code = [];
  for (const item of rawCode) { if (typeof item === "string") labels[item] = code.length; else code.push(item); }
  return code.map((ins) => ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string" ? [ins[0], labels[ins[1]]] : ins));
}

// Basic-block leaders: index 0, every branch target, and the instruction after
// every branch or RET.
function leaderSet(code) {
  const L = new Set([0]);
  code.forEach((ins, i) => {
    if (ins[0] === "JMP" || ins[0] === "JMPF") { L.add(ins[1]); if (i + 1 < code.length) L.add(i + 1); }
    else if (ins[0] === "RET" && i + 1 < code.length) L.add(i + 1);
  });
  return [...L].filter((x) => x >= 0 && x < code.length).sort((a, b) => a - b);
}

const maxStack = (code) => { let h = 0, max = 0; for (const ins of code) { h += delta(ins); if (h > max) max = h; } return max; };

function compileFn(m, name, fn) {
  const I32 = binaryen.i32;
  const argc = fn.argc || 0, nl = fn.nlocals;
  const code = resolveLabels(fn.code);
  const leaders = leaderSet(code);
  const maxH = maxStack(code);
  const scratch = (k) => nl + k;     // operand-stack slots live above the IR locals
  const labelHelper = nl + maxH;     // the Relooper's scratch local
  const get = (i) => m.local.get(i, I32);

  const r = new binaryen.Relooper(m);
  const refOf = new Map();           // leader index -> Relooper block
  const blocks = [];                 // { ref, term }

  for (let bi = 0; bi < leaders.length; bi++) {
    const start = leaders[bi];
    const end = bi + 1 < leaders.length ? leaders[bi + 1] : code.length;
    const stmts = [];
    let h = 0, result = null, term = { kind: "fall", next: end };
    for (const ins of code.slice(start, end)) {
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
        case "CALL": case "RES": {
          const ac = ins[2] || 0; h -= ac;
          const args = []; for (let j = 0; j < ac; j++) args.push(get(scratch(h + j)));
          stmts.push(m.local.set(scratch(h), m.call(ins[1], args, I32))); h++; break;
        }
        case "JMP": term = { kind: "jmp", target: ins[1] }; break;
        case "JMPF": h--; term = { kind: "jmpf", target: ins[1], cond: scratch(h), next: end }; break;
        case "RET": h--; result = get(scratch(h)); term = { kind: "ret" }; break;
        default: throw new Error("aot: unsupported opcode " + ins[0]);
      }
    }
    if (h !== 0) throw new Error(`aot: ${name} block @${start} left operand stack at height ${h} (blocks must be balanced)`);
    const body = term.kind === "ret" ? m.block(null, [...stmts, m.return(result)], binaryen.none) : m.block(null, stmts, binaryen.none);
    const ref = r.addBlock(body);
    refOf.set(start, ref);
    blocks.push({ ref, term });
  }

  for (const { ref, term } of blocks) {
    if (term.kind === "ret") continue;
    if (term.kind === "jmp") { r.addBranch(ref, refOf.get(term.target), 0, 0); continue; }
    if (term.kind === "jmpf") {
      r.addBranch(ref, refOf.get(term.target), m.i32.eqz(get(term.cond)), 0); // JMPF jumps when the condition is false
      r.addBranch(ref, refOf.get(term.next), 0, 0);                            // else fall through
      continue;
    }
    const next = refOf.get(term.next);                                         // plain fall-through
    if (!next) throw new Error(`aot: ${name} falls off the end without a RET`);
    r.addBranch(ref, next, 0, 0);
  }

  const body = r.renderAndDispose(refOf.get(0), labelHelper);
  const varTypes = new Array((nl - argc) + maxH + 1).fill(I32);               // IR locals beyond params + scratch + label helper
  m.addFunction(name, binaryen.createType(new Array(argc).fill(I32)), I32, varTypes, body);
}

// program: { name: { argc?, nlocals, code } }. resources: import names a RES may
// call. Returns wasm bytes, Asyncify-instrumented unless asyncify:false.
export function compileToWasm(program, { entry = "main", resources = [], asyncify = true } = {}) {
  const m = new binaryen.Module();
  m.setMemory(1, 1, "memory");
  for (const res of resources) m.addFunctionImport(res, "env", res, binaryen.createType([]), binaryen.i32); // 0-arg i32 resources (subset)
  for (const [name, fn] of Object.entries(program)) compileFn(m, name, fn);
  m.addFunctionExport(entry, entry);
  if (!m.validate()) { const txt = m.emitText(); throw new Error("aot: module did not validate\n" + txt); }
  if (asyncify) m.runPasses(["asyncify"]); // unwind/rewind frames to/from linear memory
  return m.emitBinary().slice();
}

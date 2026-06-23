// Stackmix — AOT compiler: Stackmix IR -> WASM, via Binaryen (the browser
// execution path; design §4.1). Each IR function becomes a real WASM function,
// so the program runs natively rather than being stepped by an interpreter.
//
// Scope: a numeric subset with control flow, a linear-memory heap, and a tagged
// value model — PUSH, LOAD, STORE, POP, ADD/SUB/MUL/LT/GE, CALL (user function),
// RES (resource = the suspend point), RET, JMP/JMPF (resolved label or index
// targets), and ALLOC/AGET/ASET (length-prefixed heap arrays). The §5
// small-vs-handle split is the next slice.
//
// Values are low-bit tagged so a continuation is self-describing: an int is
// (n << 1) (bit 0 = 0), a heap pointer is (addr | 1) (bit 0 = 1, addr 4-aligned).
// That lets a walker tell a pointer from an integer per slot — the property §5
// needs to decide what ships inline vs. becomes a handle. Each heap object also
// carries a raw length word at offset 0, so objects are self-describing too.
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

// Linear-memory heap: a bump pointer at BUMP_ADDR, objects from HEAP_BASE. The
// value model lives in linear memory, not WASM GC, because a *migrated*
// continuation must be byte-serializable: GC references live in tables / the GC
// heap — never in the linear-memory slice that crosses the wire — and an
// externref points at a host object that can't travel anyway. (Asyncify's own
// handling of reference-typed locals is inconsistent — sometimes instrumented,
// sometimes a Binaryen abort — but the decisive constraint is serialization, not
// Asyncify mechanics.) So anything live across a suspend must be memory-backed.
export const BUMP_ADDR = 8;
export const HEAP_BASE = 64;
export const RESIDENT_BASE = 8192; // receiver-local bitmap: has a given handle been fetched yet

// Growable arrays: a stable 3-word header [ARRTAG, length, backing] plus a
// separate backing store [capacity, ...slots], so push() can grow the backing
// (via memory.copy) without moving the header — the array's identity is stable.
const ARRTAG = -1, INITCAP = 4;

// Host-side array helpers: build/read a growable array in an instance's linear
// memory (so resources can pass number[] across the boundary). Layout matches
// the array runtime: header [ARRTAG, length, backing], backing [cap, ...slots].
export function hostArray(memory, values) {
  const dv = new DataView(memory.buffer);
  const backing = dv.getInt32(BUMP_ADDR, true), cap = Math.max(values.length, 1);
  dv.setInt32(backing, cap, true);
  for (let i = 0; i < values.length; i++) dv.setInt32(backing + 4 + i * 4, values[i] << 1, true); // tagged ints
  const header = backing + (cap + 1) * 4;
  dv.setInt32(header, -1, true); dv.setInt32(header + 4, values.length, true); dv.setInt32(header + 8, backing, true);
  dv.setInt32(BUMP_ADDR, header + 12, true);
  return header | 1; // tagged array pointer
}
export function hostArrayValues(memory, taggedPtr) {
  const dv = new DataView(memory.buffer), addr = taggedPtr & ~3;
  const len = dv.getInt32(addr + 4, true), backing = dv.getInt32(addr + 8, true), out = [];
  for (let i = 0; i < len; i++) out.push(dv.getInt32(backing + 4 + i * 4, true) >> 1); // untag ints
  return out;
}

// Tagged-value helpers (also used to read/write values across the host boundary).
// Pointers use two low bits: bit 0 = pointer, bit 1 = remote (a §5 handle whose
// object stayed on the owning tier). Heap addresses are 4-aligned, so both bits
// are free. A resident pointer is (addr|1); a handle is (addr|3).
export const tagInt = (n) => (n << 1);
export const untagInt = (v) => (v >> 1);
export const isPointer = (v) => (v & 1) === 1;
export const isRemote = (v) => (v & 3) === 3;
export const pointerAddr = (v) => (v & ~3);
export const makeResident = (addr) => (addr | 1);
export const makeHandle = (addr) => (addr | 3);

const DELTA = { PUSH: 1, LOAD: 1, STORE: -1, POP: -1, ADD: -1, SUB: -1, MUL: -1, LT: -1, LE: -1, GT: -1, GE: -1, RET: -1, JMPF: -1, JMP: 0, ALLOC: 0, AGET: -1, ASET: -3, NEWARR: 1, ARRPUSH: -2, ARRGET: -1, ARRLEN: 0 };
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

function compileFn(m, name, fn, handles) {
  const I32 = binaryen.i32;
  const argc = fn.argc || 0, nl = fn.nlocals;
  const code = resolveLabels(fn.code);
  const leaders = leaderSet(code);
  const maxH = maxStack(code) + 1;   // +1 scratch headroom for ALLOC's temp
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
        case "PUSH": stmts.push(m.local.set(scratch(h), m.i32.const(ins[1] << 1))); h++; break; // tagged int
        case "LOAD": stmts.push(m.local.set(scratch(h), get(ins[1]))); h++; break;
        case "STORE": h--; stmts.push(m.local.set(ins[1], get(scratch(h)))); break;
        case "POP": h--; break;
        case "ADD": case "SUB": case "MUL": case "LT": case "LE": case "GT": case "GE": {
          h -= 2; const a = get(scratch(h)), b = get(scratch(h + 1));
          // tagged ints: a+b / a-b are already correctly tagged (2n±2m = 2(n±m));
          // MUL untags one operand ((a>>1)*b = 2nm); comparisons are monotonic on
          // tagged ints, so compare directly then tag the 0/1 boolean.
          const e = ins[0] === "ADD" ? m.i32.add(a, b) : ins[0] === "SUB" ? m.i32.sub(a, b)
            : ins[0] === "MUL" ? m.i32.mul(m.i32.shr_s(a, m.i32.const(1)), b)
            : ins[0] === "LT" ? m.i32.shl(m.i32.lt_s(a, b), m.i32.const(1))
            : ins[0] === "LE" ? m.i32.shl(m.i32.le_s(a, b), m.i32.const(1))
            : ins[0] === "GT" ? m.i32.shl(m.i32.gt_s(a, b), m.i32.const(1))
            : m.i32.shl(m.i32.ge_s(a, b), m.i32.const(1));
          stmts.push(m.local.set(scratch(h), e)); h++; break;
        }
        case "CALL": case "RES": {
          const ac = ins[2] || 0; h -= ac;
          const args = []; for (let j = 0; j < ac; j++) args.push(get(scratch(h + j)));
          stmts.push(m.local.set(scratch(h), m.call(ins[1], args, I32))); h++; break;
        }
        case "ALLOC": {                        // pop n (tagged); allocate [len | n fields]; push a tagged pointer
          h--; const nRaw = () => m.i32.shr_s(get(scratch(h)), m.i32.const(1));
          stmts.push(m.local.set(scratch(h + 1), m.i32.load(0, 4, m.i32.const(BUMP_ADDR))));                      // tmp = *bump (raw addr)
          stmts.push(m.i32.store(0, 4, get(scratch(h + 1)), nRaw()));                                             // header: mem[tmp] = n
          stmts.push(m.i32.store(0, 4, m.i32.const(BUMP_ADDR), m.i32.add(get(scratch(h + 1)), m.i32.mul(m.i32.add(nRaw(), m.i32.const(1)), m.i32.const(4))))); // *bump = tmp + (n+1)*4
          stmts.push(m.local.set(scratch(h), m.i32.or(get(scratch(h + 1)), m.i32.const(1)))); h++; break;         // result = tmp | 1 (tagged pointer)
        }
        case "AGET": {
          h -= 2;
          const addr = () => m.i32.and(get(scratch(h)), m.i32.const(~3));
          const field = () => m.i32.add(addr(), m.i32.mul(m.i32.shr_s(get(scratch(h + 1)), m.i32.const(1)), m.i32.const(4)));
          if (handles) { // §5: a remote handle not yet resident -> __fetch (suspend), then load
            const slot = m.i32.shr_u(m.i32.sub(addr(), m.i32.const(HEAP_BASE)), m.i32.const(2));
            stmts.push(m.if(
              m.i32.and(m.i32.ne(m.i32.and(get(scratch(h)), m.i32.const(2)), m.i32.const(0)), m.i32.eqz(m.i32.load8_u(RESIDENT_BASE, 1, slot))),
              m.drop(m.call("__fetch", [get(scratch(h))], I32))));
          }
          stmts.push(m.local.set(scratch(h), m.i32.load(4, 4, field()))); h++; break; // field = mem[addr + 4 + idx*4]
        }
        case "ASET": { h -= 3; const addr = m.i32.and(get(scratch(h)), m.i32.const(~3)), idx = m.i32.shr_s(get(scratch(h + 1)), m.i32.const(1)), v = get(scratch(h + 2));
          stmts.push(m.i32.store(4, 4, m.i32.add(addr, m.i32.mul(idx, m.i32.const(4))), v)); break; } // mem[addr + 4 + idx*4] = val
        case "NEWARR": stmts.push(m.local.set(scratch(h), m.call("__newarr", [], I32))); h++; break;
        case "ARRPUSH": { h -= 2; stmts.push(m.drop(m.call("__arrpush", [get(scratch(h)), get(scratch(h + 1))], I32))); break; } // arr.push(v)
        case "ARRGET": { h -= 2; const backing = m.i32.load(8, 4, m.i32.and(get(scratch(h)), m.i32.const(~3))); const idx = m.i32.shr_s(get(scratch(h + 1)), m.i32.const(1));
          stmts.push(m.local.set(scratch(h), m.i32.load(4, 4, m.i32.add(backing, m.i32.mul(idx, m.i32.const(4)))))); h++; break; } // arr[idx] = backing[idx]
        case "ARRLEN": stmts.push(m.local.set(scratch(h - 1), m.i32.shl(m.i32.load(4, 4, m.i32.and(get(scratch(h - 1)), m.i32.const(~3))), m.i32.const(1)))); break; // tagInt(length)
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

// Runtime helpers for growable arrays (added only when a program uses them).
function addArrayRuntime(m) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const st = (off, p, v) => m.i32.store(off, 4, p, v);
  const bump = () => m.i32.load(0, 4, c(BUMP_ADDR));
  const setBump = (v) => m.i32.store(0, 4, c(BUMP_ADDR), v);

  // __newarr() -> tagged array pointer.  locals: 0=backing, 1=header
  m.addFunction("__newarr", binaryen.createType([]), I32, [I32, I32], m.block(null, [
    m.local.set(0, bump()), st(0, g(0), c(INITCAP)), setBump(m.i32.add(g(0), c((INITCAP + 1) * 4))), // backing = [cap, ...slots]
    m.local.set(1, bump()), st(0, g(1), c(ARRTAG)), st(4, g(1), c(0)), st(8, g(1), g(0)), setBump(m.i32.add(g(1), c(12))), // header = [ARRTAG, len=0, backing]
    m.return(m.i32.or(g(1), c(1))),
  ], binaryen.none));

  // __arrpush(arr, v) -> 0.  locals: 0=arr,1=v (params); 2=addr,3=backing,4=len,5=cap,6=newBacking
  m.addFunction("__arrpush", binaryen.createType([I32, I32]), I32, [I32, I32, I32, I32, I32], m.block(null, [
    m.local.set(2, m.i32.and(g(0), c(~3))), m.local.set(3, ld(8, g(2))), m.local.set(4, ld(4, g(2))), m.local.set(5, ld(0, g(3))),
    m.if(m.i32.ge_s(g(4), g(5)), m.block(null, [           // full -> grow (double capacity, memory.copy the elements)
      m.local.set(6, bump()), st(0, g(6), m.i32.mul(g(5), c(2))), setBump(m.i32.add(g(6), m.i32.add(m.i32.mul(g(5), c(8)), c(4)))),
      m.memory.copy(m.i32.add(g(6), c(4)), m.i32.add(g(3), c(4)), m.i32.mul(g(5), c(4))),
      st(8, g(2), g(6)), m.local.set(3, g(6)),
    ], binaryen.none)),
    m.i32.store(0, 4, m.i32.add(g(3), m.i32.add(c(4), m.i32.mul(g(4), c(4)))), g(1)),  // backing[len] = v
    st(4, g(2), m.i32.add(g(4), c(1))),                                                // length = len + 1
    m.return(c(0)),
  ], binaryen.none));
}

// program: { name: { argc?, nlocals, code } }. resources: import names a RES may
// call. Returns wasm bytes, Asyncify-instrumented unless asyncify:false.
export function compileToWasm(program, { entry = "main", resources = [], asyncify = true, handles = false } = {}) {
  const m = new binaryen.Module();
  m.setMemory(1, 1, "memory");
  const usesArrays = Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && (i[0] === "NEWARR" || i[0] === "ARRPUSH" || i[0] === "ARRGET" || i[0] === "ARRLEN")));
  if (usesArrays) m.setFeatures(binaryen.Features.All); // enable memory.copy (bulk memory) for the array runtime
  const arity = {}; // each resource is imported with the arity it is called with
  for (const fn of Object.values(program)) for (const i of fn.code) if (Array.isArray(i) && i[0] === "RES") arity[i[1]] = i[2] || 0;
  for (const res of resources) m.addFunctionImport(res, "env", res, binaryen.createType(new Array(arity[res] || 0).fill(binaryen.i32)), binaryen.i32);
  if (handles) m.addFunctionImport("__fetch", "env", "__fetch", binaryen.createType([binaryen.i32]), binaryen.i32); // §5 deref-miss suspends here
  for (const [name, fn] of Object.entries(program)) compileFn(m, name, fn, handles);
  if (usesArrays) addArrayRuntime(m);
  m.addFunctionExport(entry, entry);
  if (!m.validate()) { const txt = m.emitText(); throw new Error("aot: module did not validate\n" + txt); }
  if (asyncify) m.runPasses(["asyncify"]); // unwind/rewind frames to/from linear memory
  return m.emitBinary().slice();
}

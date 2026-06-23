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
// A closure (tsc.mjs lowers every function to one): a heap object [CLOSTAG,
// fnTableIndex, ...captured env]. CALLV calls through the function table.
const CLOSTAG = -2;
// A string-keyed object: a stable header [OBJTAG, count, backing] plus a backing
// store [cap, k0, v0, k1, v1, ...] of (internedKeyId, taggedValue) pairs. Keys
// are interned to small ints at compile time, so property access is an id match.
const OBJTAG = -3, INITCAP_OBJ = 2;
// A string: [STRTAG, byteLength, ...bytes] (one byte per char, padded to a word).
// "+" and "===" become polymorphic — string-aware — through the runtime helpers.
const STRTAG = -4;
// A generator object: [GENTAG, bodyFnIndex, ip, done, ...savedLocals]. A generator
// function compiles to a trampoline (called normally, returns one of these) plus a
// dispatch body (resumed by GENNEXT) that saves/restores its locals here at YIELD.
const GENTAG = -5;

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

// Primitive singletons: undefined / null / false / true. Each is odd (so never a
// fixnum) with a reserved "address" below HEAP_BASE, so it reads as a pointer
// into [0, HEAP_BASE) — a range the heap walker and §5 both skip (inHeap requires
// addr >= HEAP_BASE), so a singleton never aliases a real object. This keeps
// undefined/null/false distinct from the fixnum 0 (JS: 0 !== false, null !== undefined).
export const UNDEF = 0x1, NULL = 0x5, FALSE = 0x9, TRUE = 0xD;
export const tagBool = (b) => (b ? TRUE : FALSE);
// Decode a tagged value back to a JS value (a pointer stays opaque — walk the heap).
export function decodeValue(v) {
  switch (v) { case UNDEF: return undefined; case NULL: return null; case TRUE: return true; case FALSE: return false; }
  return (v & 1) === 0 ? v >> 1 : { ptr: pointerAddr(v) };
}
// Like decodeValue but reads the heap, so a string comes back as a JS string.
export function readValue(memory, v) {
  if (!isPointer(v) || v === UNDEF || v === NULL || v === TRUE || v === FALSE) return decodeValue(v);
  const dv = new DataView(memory.buffer), addr = pointerAddr(v);
  if (dv.getInt32(addr, true) === STRTAG) {
    const len = dv.getInt32(addr + 4, true); let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(addr + 8 + i));
    return s;
  }
  return { ptr: addr };
}
// Map an IR PUSH literal to its tagged immediate (floats/strings: a later slice).
function immediate(x) {
  if (x === undefined) return UNDEF;
  if (x === null) return NULL;
  if (x === true) return TRUE;
  if (x === false) return FALSE;
  if (typeof x === "number" && Number.isInteger(x)) return x << 1;
  throw new Error("aot: unsupported literal " + JSON.stringify(x));
}

const DELTA = { PUSH: 1, LOAD: 1, LOADENV: 1, LOADTHIS: 1, DUP: 1, STORE: -1, POP: -1, ADD: -1, SUB: -1, MUL: -1, LT: -1, LE: -1, GT: -1, GE: -1, RET: -1, JMPF: -1, JMP: 0, ALLOC: 0, AGET: -1, ASET: -3, NEWARR: 1, ARRPUSH: -2, ARRGET: -1, ARRLEN: 0, BIN: -1, MAKECLOSURE: 1, NEWOBJ: 1, GETPROP: 0, SETPROP: -1, SETHIDDEN: -1, ISA: 0, TYPEOF: 0, YIELD: 0, ITER: 0, GENNEXT: -1 };
const delta = (ins) => ins[0] === "CALL" || ins[0] === "RES" ? 1 - (ins[2] || 0) : ins[0] === "CALLV" ? -ins[1] : ins[0] === "CALLDYN" ? -(ins[1] + 1) : ins[0] === "CALLMETHOD" ? -ins[2] : DELTA[ins[0]] ?? 0;

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

// Per-block operand-stack entry heights, by propagating over the CFG. Structured
// IR keeps the height consistent at every block boundary — but not always zero
// (e.g. for-of keeps the result object on the stack across the done-check branch),
// so a block indexes its scratch slots from its entry height, not from zero.
// Also returns the max absolute height, for sizing the scratch locals.
function blockHeights(code, leaders) {
  const blockAt = new Map(leaders.map((s, i) => [s, i]));
  const endOf = (bi) => (bi + 1 < leaders.length ? leaders[bi + 1] : code.length);
  const entry = new Array(leaders.length).fill(undefined);
  entry[0] = 0; let maxAbs = 0; const q = [0];
  while (q.length) {
    const bi = q.shift(); let h = entry[bi]; if (h > maxAbs) maxAbs = h;
    for (let k = leaders[bi]; k < endOf(bi); k++) { h += delta(code[k]); if (h > maxAbs) maxAbs = h; }
    const last = code[endOf(bi) - 1], succ = [];
    if (last[0] === "JMP") succ.push(blockAt.get(last[1]));
    else if (last[0] === "JMPF") { succ.push(blockAt.get(last[1])); succ.push(blockAt.get(endOf(bi))); }
    else if (last[0] !== "RET") succ.push(blockAt.get(endOf(bi))); // fall-through
    for (const s of succ) {
      if (s === undefined) continue;
      if (entry[s] === undefined) { entry[s] = h; q.push(s); }
      else if (entry[s] !== h) throw new Error(`aot: inconsistent stack height entering block @${leaders[s]} (${entry[s]} vs ${h})`);
    }
  }
  return { entryH: entry, maxAbs };
}

function compileFn(m, name, fn, handles, fnIndex, keyIds, strings) {
  const I32 = binaryen.i32;
  const argc = fn.argc || 0, nl = fn.nlocals;
  const code = resolveLabels(fn.code);
  const leaders = leaderSet(code);
  const { entryH, maxAbs } = blockHeights(code, leaders);
  const maxH = maxAbs + 1;           // +1 scratch headroom for ALLOC / build temps
  // Calling convention: WASM local 0 is the closure environment — the receiver of
  // a CALLV, the implicit (unused) arg of a direct CALL, and where LOADENV /
  // capturing MAKECLOSUREs read and write. So IR local i is WASM local i+1, and
  // the operand-stack scratch slots live above the IR locals.
  const ENV = 0;
  const loc = (i) => i + 1;
  const scratch = (k) => 1 + nl + k;
  const labelHelper = 1 + nl + maxH; // the Relooper's scratch local
  const get = (i) => m.local.get(i, I32);
  const bool = (cond) => m.select(cond, m.i32.const(TRUE), m.i32.const(FALSE));   // i32 0/1 -> tagged boolean
  // JS truthiness of the value in local `i`: falsy is 0, undefined, null, false.
  // Takes the local index (not an expression) so each use is a fresh local.get —
  // a Binaryen IR node can't be shared between parents.
  const falsy = (i) => m.i32.or(m.i32.or(m.i32.eqz(get(i)), m.i32.eq(get(i), m.i32.const(UNDEF))), m.i32.or(m.i32.eq(get(i), m.i32.const(NULL)), m.i32.eq(get(i), m.i32.const(FALSE))));
  // Build a string literal [STRTAG, len, ...bytes] into local `slot`, using that
  // slot as its own address temp (raw addr while writing, tagged at the end).
  const buildStrInto = (slot, s) => {
    const out = [m.local.set(slot, m.i32.load(0, 4, m.i32.const(BUMP_ADDR))),
      m.i32.store(0, 4, get(slot), m.i32.const(STRTAG)), m.i32.store(4, 4, get(slot), m.i32.const(s.length))];
    for (let k = 0; k < s.length; k++) out.push(m.i32.store8(8 + k, 1, get(slot), m.i32.const(s.charCodeAt(k))));
    out.push(m.i32.store(0, 4, m.i32.const(BUMP_ADDR), m.i32.add(get(slot), m.i32.const(8 + ((s.length + 3) & ~3)))));
    out.push(m.local.set(slot, m.i32.or(get(slot), m.i32.const(1))));
    return out;
  };

  const r = new binaryen.Relooper(m);
  const refOf = new Map();           // leader index -> Relooper block
  const blocks = [];                 // { ref, term }

  for (let bi = 0; bi < leaders.length; bi++) {
    const start = leaders[bi];
    const end = bi + 1 < leaders.length ? leaders[bi + 1] : code.length;
    const stmts = [];
    let h = entryH[bi], result = null, term = { kind: "fall", next: end };
    for (const ins of code.slice(start, end)) {
      switch (ins[0]) {
        case "PUSH": {
          const v = ins[1];
          if (typeof v === "string") { stmts.push(...buildStrInto(scratch(h), v)); h++; break; } // string literal
          if (Array.isArray(v)) {              // constant array (e.g. a class's __class__ name list): NEWARR + ARRPUSH each element
            stmts.push(m.local.set(scratch(h), m.call("__newarr", [], I32)));
            for (const el of v) {
              if (typeof el === "string") stmts.push(...buildStrInto(scratch(h + 1), el));
              else stmts.push(m.local.set(scratch(h + 1), m.i32.const(immediate(el))));
              stmts.push(m.drop(m.call("__arrpush", [get(scratch(h)), get(scratch(h + 1))], I32)));
            }
            h++; break;
          }
          stmts.push(m.local.set(scratch(h), m.i32.const(immediate(v)))); h++; break; // tagged immediate
        }
        case "LOAD": stmts.push(m.local.set(scratch(h), get(loc(ins[1])))); h++; break;
        case "STORE": h--; stmts.push(m.local.set(loc(ins[1]), get(scratch(h)))); break;
        case "LOADENV": stmts.push(m.local.set(scratch(h), m.i32.load(8 + ins[1] * 4, 4, m.i32.and(get(ENV), m.i32.const(~3))))); h++; break; // env[idx] from the closure
        case "LOADTHIS": {                     // `this`: methods capture the instance into env, so this = env[idx]
          if (ins[1] < 0) throw new Error("aot: dynamic LOADTHIS (no lexical this) not yet supported");
          stmts.push(m.local.set(scratch(h), m.i32.load(8 + ins[1] * 4, 4, m.i32.and(get(ENV), m.i32.const(~3))))); h++; break;
        }
        case "DUP": stmts.push(m.local.set(scratch(h), get(scratch(h - 1)))); h++; break; // duplicate the operand-stack top
        case "POP": h--; break;
        case "ADD": case "SUB": case "MUL": case "LT": case "LE": case "GT": case "GE": {
          h -= 2; const a = get(scratch(h)), b = get(scratch(h + 1));
          // tagged ints: a+b / a-b are already correctly tagged (2n±2m = 2(n±m));
          // MUL untags one operand ((a>>1)*b = 2nm); comparisons are monotonic on
          // tagged ints, so compare directly then map the 0/1 to a tagged boolean.
          const e = ins[0] === "ADD" ? m.i32.add(a, b) : ins[0] === "SUB" ? m.i32.sub(a, b)
            : ins[0] === "MUL" ? m.i32.mul(m.i32.shr_s(a, m.i32.const(1)), b)
            : ins[0] === "LT" ? bool(m.i32.lt_s(a, b))
            : ins[0] === "LE" ? bool(m.i32.le_s(a, b))
            : ins[0] === "GT" ? bool(m.i32.gt_s(a, b))
            : bool(m.i32.ge_s(a, b));
          stmts.push(m.local.set(scratch(h), e)); h++; break;
        }
        case "CALL": case "RES": {
          const ac = ins[2] || 0; h -= ac;
          const args = []; for (let j = 0; j < ac; j++) args.push(get(scratch(h + j)));
          // user functions take the env as param 0 (a direct call has no closure, so 0);
          // resources are host imports, called with their natural arity.
          const callArgs = ins[0] === "CALL" ? [m.i32.const(0), ...args] : args;
          stmts.push(m.local.set(scratch(h), m.call(ins[1], callArgs, I32))); h++; break;
        }
        case "BIN": {                          // tsc.mjs binary op. With strings present, + and === are polymorphic (JS semantics)
          h -= 2; const sa = scratch(h), sb = scratch(h + 1), op = ins[1];
          const a = () => get(sa), b = () => get(sb); let e;                  // thunks: a fresh local.get per use (no IR-node sharing)
          if (op === "+") e = strings                                         // numeric fast path when both are fixnums; else concat/coerce
            ? m.if(m.i32.eqz(m.i32.and(m.i32.or(a(), b()), m.i32.const(1))), m.i32.add(a(), b()), m.call("__add", [a(), b()], I32))
            : m.i32.add(a(), b());
          else if (op === "-") e = m.i32.sub(a(), b());
          else if (op === "*") e = m.i32.mul(m.i32.shr_s(a(), m.i32.const(1)), b());
          else if (op === "<") e = bool(m.i32.lt_s(a(), b()));
          else if (op === "<=") e = bool(m.i32.le_s(a(), b()));
          else if (op === ">") e = bool(m.i32.gt_s(a(), b()));
          else if (op === ">=") e = bool(m.i32.ge_s(a(), b()));
          else if (op === "===" || op === "==") e = strings ? bool(m.call("__eq", [a(), b()], I32)) : bool(m.i32.eq(a(), b())); // __eq: strings by value
          else if (op === "!==" || op === "!=") e = strings ? bool(m.i32.eqz(m.call("__eq", [a(), b()], I32))) : bool(m.i32.ne(a(), b()));
          else throw new Error("aot: unsupported BIN " + op);
          stmts.push(m.local.set(scratch(h), e)); h++; break;
        }
        case "MAKECLOSURE": {                  // box a function as a closure [CLOSTAG, fnIndex, ...env]
          // ins[3] = generator flag: ignored here — a generator function compiles to a
          // trampoline at fnIndex[name] that returns a generator object when called.
          const idx = fnIndex[ins[1]]; if (idx === undefined) throw new Error("aot: MAKECLOSURE of unknown fn " + ins[1]);
          const caps = ins[2] || [], tmp = scratch(h + 1);                                                        // tmp = the new closure's base addr
          stmts.push(m.local.set(tmp, m.i32.load(0, 4, m.i32.const(BUMP_ADDR))));
          stmts.push(m.i32.store(0, 4, get(tmp), m.i32.const(CLOSTAG)));
          stmts.push(m.i32.store(4, 4, get(tmp), m.i32.const(idx)));                                              // fn table index
          caps.forEach(([kind, ci], j) => {                                                                       // env[j] = each captured value
            let v;
            if (kind === "L") v = get(loc(ci));                                                                  // capture a local
            else if (kind === "E") v = m.i32.load(8 + ci * 4, 4, m.i32.and(get(ENV), m.i32.const(~3)));          // re-capture an outer env slot
            else throw new Error("aot: closure capture kind " + kind + " not yet supported");                    // "T" (this): arrives with classes
            stmts.push(m.i32.store(8 + j * 4, 4, get(tmp), v));
          });
          stmts.push(m.i32.store(0, 4, m.i32.const(BUMP_ADDR), m.i32.add(get(tmp), m.i32.const(8 + caps.length * 4))));
          stmts.push(m.local.set(scratch(h), m.i32.or(get(tmp), m.i32.const(1)))); h++; break;                    // tagged closure pointer
        }
        case "CALLV": {                        // call a closure value: stack is [closure, arg0..arg_{argc-1}]
          const argc = ins[1]; h -= argc + 1;
          const fn = m.i32.load(4, 4, m.i32.and(get(scratch(h)), m.i32.const(~3)));                              // closure[1] = fn table index
          const args = [get(scratch(h))]; for (let k = 0; k < argc; k++) args.push(get(scratch(h + 1 + k)));    // env (the closure itself) is param 0
          stmts.push(m.local.set(scratch(h), m.call_indirect("0", fn, args, binaryen.createType(new Array(argc + 1).fill(I32)), I32))); h++; break;
        }
        case "CALLDYN": {                      // recv[key](args): dynamic dispatch. Supported receiver is an array
          const argc = ins[1]; h -= argc + 2;  // (a closure held in a collection, e.g. fns[j]()); the array element IS the closure.
          const recv = scratch(h);             // stack: [recv, key, arg0..arg_{argc-1}]
          const backing = m.i32.load(8, 4, m.i32.and(get(recv), m.i32.const(~3)));
          const callee = m.i32.load(4, 4, m.i32.add(backing, m.i32.mul(m.i32.shr_s(get(scratch(h + 1)), m.i32.const(1)), m.i32.const(4)))); // recv[untag(key)]
          stmts.push(m.local.set(recv, callee));                                                                 // stash the closure in the receiver slot
          const fn = m.i32.load(4, 4, m.i32.and(get(recv), m.i32.const(~3)));
          const args = [get(recv)]; for (let k = 0; k < argc; k++) args.push(get(scratch(h + 2 + k)));           // env (the closure) is param 0; `this` (recv) is dropped (no method use yet)
          stmts.push(m.local.set(scratch(h), m.call_indirect("0", fn, args, binaryen.createType(new Array(argc + 1).fill(I32)), I32))); h++; break;
        }
        case "TYPEOF": stmts.push(m.local.set(scratch(h - 1), m.call("__typeof", [get(scratch(h - 1))], I32))); break; // value -> type string
        case "ITER": break;                    // normalize an iterable -> iterator; a generator is already its own iterator (no-op)
        case "GENNEXT": {                      // [gen, sentValue] -> [{value, done}]; drive the generator one step
          h -= 2; stmts.push(m.local.set(scratch(h), m.call("__gennext", [get(scratch(h)), get(scratch(h + 1))], I32))); h++; break;
        }
        case "NEWOBJ": stmts.push(m.local.set(scratch(h), m.call("__newobj", [], I32))); h++; break;
        case "GETPROP": {                      // [obj] -> [obj.key]; key interned to an id
          const v = m.call("__getprop", [get(scratch(h - 1)), m.i32.const(keyIds.get(ins[1]))], I32);
          stmts.push(m.local.set(scratch(h - 1), v)); break;
        }
        case "SETPROP": case "SETHIDDEN": {    // [obj, val] -> [obj]; obj.key = val (hidden = same store; non-enumerable only matters for reflection)
          h -= 2; const r = m.call("__setprop", [get(scratch(h)), m.i32.const(keyIds.get(ins[1])), get(scratch(h + 1))], I32);
          stmts.push(m.local.set(scratch(h), r)); h++; break;
        }
        case "CALLMETHOD": {                   // recv.name(args): the method closure captured `this`, so call it with env = the method
          const argc = ins[2]; h -= argc + 1;  // stack: [recv, arg0..arg_{argc-1}]
          stmts.push(m.local.set(scratch(h), m.call("__getprop", [get(scratch(h)), m.i32.const(keyIds.get(ins[1]))], I32))); // recv[name] = method closure
          const fn = m.i32.load(4, 4, m.i32.and(get(scratch(h)), m.i32.const(~3)));
          const args = [get(scratch(h))]; for (let k = 0; k < argc; k++) args.push(get(scratch(h + 1 + k)));
          stmts.push(m.local.set(scratch(h), m.call_indirect("0", fn, args, binaryen.createType(new Array(argc + 1).fill(I32)), I32))); h++; break;
        }
        case "ISA": {                          // obj instanceof <name>: is the name string in obj.__class__?
          stmts.push(...buildStrInto(scratch(h), ins[1]));   // name string into the free slot above the operand
          const res = m.call("__isa", [get(scratch(h - 1)), get(scratch(h)), m.i32.const(keyIds.get("__class__"))], I32);
          stmts.push(m.local.set(scratch(h - 1), bool(res))); break;
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
    const body = term.kind === "ret" ? m.block(null, [...stmts, m.return(result)], binaryen.none) : m.block(null, stmts, binaryen.none);
    const ref = r.addBlock(body);
    refOf.set(start, ref);
    blocks.push({ ref, term });
  }

  for (const { ref, term } of blocks) {
    if (term.kind === "ret") continue;
    if (term.kind === "jmp") { r.addBranch(ref, refOf.get(term.target), 0, 0); continue; }
    if (term.kind === "jmpf") {
      r.addBranch(ref, refOf.get(term.target), falsy(term.cond), 0);           // JMPF jumps when the condition is falsy (JS truthiness)
      r.addBranch(ref, refOf.get(term.next), 0, 0);                            // else fall through
      continue;
    }
    const next = refOf.get(term.next);                                         // plain fall-through
    if (!next) throw new Error(`aot: ${name} falls off the end without a RET`);
    r.addBranch(ref, next, 0, 0);
  }

  const body = r.renderAndDispose(refOf.get(0), labelHelper);
  const varTypes = new Array((nl - argc) + maxH + 1).fill(I32);               // IR locals beyond params + scratch + label helper
  m.addFunction(name, binaryen.createType(new Array(argc + 1).fill(I32)), I32, varTypes, body); // +1 leading param: the env
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

// Runtime helpers for string-keyed objects (added only when a program uses them).
// An object is a stable header [OBJTAG, count, backing] + backing [cap, (key,val)...].
function addObjectRuntime(m) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const st = (off, p, v) => m.i32.store(off, 4, p, v);
  const bump = () => m.i32.load(0, 4, c(BUMP_ADDR));
  const setBump = (v) => m.i32.store(0, 4, c(BUMP_ADDR), v);
  const pair = (backing, i) => m.i32.add(g(backing), m.i32.mul(g(i), c(8))); // address of the i-th (key,val) pair, minus the cap word

  // __newobj() -> tagged object pointer.  locals: 0=backing, 1=header
  m.addFunction("__newobj", binaryen.createType([]), I32, [I32, I32], m.block(null, [
    m.local.set(0, bump()), st(0, g(0), c(INITCAP_OBJ)), setBump(m.i32.add(g(0), c((1 + 2 * INITCAP_OBJ) * 4))), // backing = [cap, ...pairs]
    m.local.set(1, bump()), st(0, g(1), c(OBJTAG)), st(4, g(1), c(0)), st(8, g(1), g(0)), setBump(m.i32.add(g(1), c(12))), // header = [OBJTAG, count=0, backing]
    m.return(m.i32.or(g(1), c(1))),
  ], binaryen.none));

  // __getprop(obj, key) -> value or undefined.  params 0=obj,1=key; locals 2=addr,3=backing,4=count,5=i
  m.addFunction("__getprop", binaryen.createType([I32, I32]), I32, [I32, I32, I32, I32], m.block(null, [
    m.local.set(2, m.i32.and(g(0), c(~3))), m.local.set(3, ld(8, g(2))), m.local.set(4, ld(4, g(2))), m.local.set(5, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_u(g(5), g(4)), m.return(c(UNDEF))),            // i >= count -> undefined (missing key)
      m.if(m.i32.eq(ld(4, pair(3, 5)), g(1)), m.return(ld(8, pair(3, 5)))), // key match -> value
      m.local.set(5, m.i32.add(g(5), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ], binaryen.none));

  // __setprop(obj, key, val) -> obj.  params 0=obj,1=key,2=val; locals 3=addr,4=backing,5=count,6=i,7=cap,8=newBacking
  m.addFunction("__setprop", binaryen.createType([I32, I32, I32]), I32, [I32, I32, I32, I32, I32, I32], m.block(null, [
    m.local.set(3, m.i32.and(g(0), c(~3))), m.local.set(4, ld(8, g(3))), m.local.set(5, ld(4, g(3))), m.local.set(6, c(0)),
    m.block("append", [
      m.loop("L", m.block(null, [
        m.br_if("append", m.i32.ge_u(g(6), g(5))),                // no existing key -> append
        m.if(m.i32.eq(ld(4, pair(4, 6)), g(1)), m.block(null, [st(8, pair(4, 6), g(2)), m.return(g(0))])), // overwrite in place
        m.local.set(6, m.i32.add(g(6), c(1))), m.br("L"),
      ])),
    ]),
    m.local.set(7, ld(0, g(4))),                                  // cap
    m.if(m.i32.ge_s(g(5), g(7)), m.block(null, [                  // full -> grow (double, memory.copy the pairs)
      m.local.set(8, bump()), st(0, g(8), m.i32.mul(g(7), c(2))), setBump(m.i32.add(g(8), m.i32.add(m.i32.mul(g(7), c(16)), c(4)))),
      m.memory.copy(m.i32.add(g(8), c(4)), m.i32.add(g(4), c(4)), m.i32.mul(g(5), c(8))),
      st(8, g(3), g(8)), m.local.set(4, g(8)),
    ], binaryen.none)),
    st(4, pair(4, 5), g(1)), st(8, pair(4, 5), g(2)),             // backing pair[count] = (key, val)
    st(4, g(3), m.i32.add(g(5), c(1))),                           // count++
    m.return(g(0)),
  ], binaryen.none));
}

// Runtime helpers for strings (added only when a program has a string literal).
// A string is [STRTAG, byteLength, ...bytes]; "+" and "===" dispatch here.
function addStringRuntime(m) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const st = (off, p, v) => m.i32.store(off, 4, p, v);
  const ld8 = (off, p) => m.i32.load8_u(off, 1, p);
  const st8 = (off, p, v) => m.i32.store8(off, 1, p, v);
  const bump = () => m.i32.load(0, 4, c(BUMP_ADDR));
  const setBump = (v) => m.i32.store(0, 4, c(BUMP_ADDR), v);
  const addr = (i) => m.i32.and(g(i), c(~3));                            // raw heap address of a tagged pointer in local i
  const isStr = (i) => m.if(m.i32.and(g(i), c(1)), m.i32.eq(ld(0, addr(i)), c(STRTAG)), c(0)); // string? (guarded load: only deref a pointer)
  const pad = (lenExpr) => m.i32.and(m.i32.add(lenExpr, c(3)), c(~3));   // byte count rounded up to a word

  // __numstr(v) -> string of a tagged fixnum.  locals: 1=n,2=neg,3=len,4=q,5=str,6=i
  m.addFunction("__numstr", binaryen.createType([I32]), I32, [I32, I32, I32, I32, I32, I32], m.block(null, [
    m.local.set(1, m.i32.shr_s(g(0), c(1))),                            // n = untag
    m.if(m.i32.eqz(g(1)), m.block(null, [                              // n == 0 -> "0"
      m.local.set(5, bump()), st(0, g(5), c(STRTAG)), st(4, g(5), c(1)), st8(8, g(5), c(48)), setBump(m.i32.add(g(5), c(12))),
      m.return(m.i32.or(g(5), c(1))),
    ], binaryen.none)),
    m.local.set(2, m.i32.lt_s(g(1), c(0))),                            // neg?
    m.if(g(2), m.local.set(1, m.i32.sub(c(0), g(1)))),                 // n = -n
    m.local.set(3, c(0)), m.local.set(4, g(1)),                        // count digits (do-while: n != 0 here)
    m.loop("C", m.block(null, [m.local.set(3, m.i32.add(g(3), c(1))), m.local.set(4, m.i32.div_u(g(4), c(10))), m.br_if("C", g(4))])),
    m.local.set(3, m.i32.add(g(3), g(2))),                            // len = digits + sign
    m.local.set(5, bump()), st(0, g(5), c(STRTAG)), st(4, g(5), g(3)), setBump(m.i32.add(g(5), m.i32.add(c(8), pad(g(3))))),
    m.if(g(2), st8(8, g(5), c(45))),                                  // '-'
    m.local.set(6, g(3)), m.local.set(4, g(1)),                       // fill digits from the end
    m.loop("F", m.block(null, [
      m.local.set(6, m.i32.sub(g(6), c(1))),
      st8(8, m.i32.add(g(5), g(6)), m.i32.add(c(48), m.i32.rem_u(g(4), c(10)))),
      m.local.set(4, m.i32.div_u(g(4), c(10))),
      m.br_if("F", m.i32.ne(g(4), c(0))),
    ])),
    m.return(m.i32.or(g(5), c(1))),
  ], binaryen.none));

  // __tostr(v) -> string.  string: itself; fixnum: __numstr; else: "" (coercion of bool/null is a later slice)
  m.addFunction("__tostr", binaryen.createType([I32]), I32, [I32], m.block(null, [
    m.if(isStr(0), m.return(g(0))),
    m.if(m.i32.eqz(m.i32.and(g(0), c(1))), m.return(m.call("__numstr", [g(0)], I32))),
    m.local.set(1, bump()), st(0, g(1), c(STRTAG)), st(4, g(1), c(0)), setBump(m.i32.add(g(1), c(8))),
    m.return(m.i32.or(g(1), c(1))),
  ], binaryen.none));

  // __concat(sa, sb) -> string.  locals: 2=la,3=lb,4=len,5=str
  m.addFunction("__concat", binaryen.createType([I32, I32]), I32, [I32, I32, I32, I32], m.block(null, [
    m.local.set(2, ld(4, addr(0))), m.local.set(3, ld(4, addr(1))), m.local.set(4, m.i32.add(g(2), g(3))),
    m.local.set(5, bump()), st(0, g(5), c(STRTAG)), st(4, g(5), g(4)), setBump(m.i32.add(g(5), m.i32.add(c(8), pad(g(4))))),
    m.memory.copy(m.i32.add(g(5), c(8)), m.i32.add(addr(0), c(8)), g(2)),
    m.memory.copy(m.i32.add(m.i32.add(g(5), c(8)), g(2)), m.i32.add(addr(1), c(8)), g(3)),
    m.return(m.i32.or(g(5), c(1))),
  ], binaryen.none));

  // __add(a, b): at least one operand is non-fixnum. Either a string -> concat; else best-effort numeric.
  m.addFunction("__add", binaryen.createType([I32, I32]), I32, [], m.block(null, [
    m.if(m.i32.or(isStr(0), isStr(1)), m.return(m.call("__concat", [m.call("__tostr", [g(0)], I32), m.call("__tostr", [g(1)], I32)], I32))),
    m.return(m.i32.add(g(0), g(1))),
  ], binaryen.none));

  // __typeof(v) -> the JS typeof string.  local 1 holds the built string.
  const retStr = (s) => {                                               // statements that build s and return its tagged pointer
    const out = [m.local.set(1, bump()), st(0, g(1), c(STRTAG)), st(4, g(1), c(s.length))];
    for (let k = 0; k < s.length; k++) out.push(st8(8 + k, g(1), c(s.charCodeAt(k))));
    out.push(setBump(m.i32.add(g(1), c(8 + ((s.length + 3) & ~3)))), m.return(m.i32.or(g(1), c(1))));
    return m.block(null, out, binaryen.none);
  };
  m.addFunction("__typeof", binaryen.createType([I32]), I32, [I32], m.block(null, [
    m.if(m.i32.eq(g(0), c(UNDEF)), retStr("undefined")),
    m.if(m.i32.or(m.i32.eq(g(0), c(TRUE)), m.i32.eq(g(0), c(FALSE))), retStr("boolean")),
    m.if(m.i32.eq(g(0), c(NULL)), retStr("object")),                   // typeof null === "object" (the JS quirk)
    m.if(m.i32.eqz(m.i32.and(g(0), c(1))), retStr("number")),         // fixnum
    m.if(m.i32.eq(ld(0, addr(0)), c(STRTAG)), retStr("string")),      // a pointer: dispatch on the heap tag
    m.if(m.i32.eq(ld(0, addr(0)), c(CLOSTAG)), retStr("function")),
    retStr("object"),                                                 // arrays / objects
  ], binaryen.none));

  // __eq(a, b) -> 0/1.  identical bits, or equal strings by value.  locals: 2=la,3=i
  m.addFunction("__eq", binaryen.createType([I32, I32]), I32, [I32, I32], m.block(null, [
    m.if(m.i32.eq(g(0), g(1)), m.return(c(1))),                       // identical bits: fixnums, same pointer, same singleton
    m.if(m.i32.eqz(m.i32.and(isStr(0), isStr(1))), m.return(c(0))),   // different and not both strings -> not equal
    m.local.set(2, ld(4, addr(0))),
    m.if(m.i32.ne(g(2), ld(4, addr(1))), m.return(c(0))),             // different lengths
    m.local.set(3, c(0)),
    m.loop("E", m.block(null, [
      m.if(m.i32.ge_u(g(3), g(2)), m.return(c(1))),                   // all bytes matched
      m.if(m.i32.ne(ld8(8, m.i32.add(addr(0), g(3))), ld8(8, m.i32.add(addr(1), g(3)))), m.return(c(0))),
      m.local.set(3, m.i32.add(g(3), c(1))), m.br("E"),
    ])),
    m.unreachable(),
  ], binaryen.none));
}

// Runtime helper for instanceof (added when a program uses ISA). A user class
// tags each instance with a hidden __class__ array of its class-name chain.
function addClassRuntime(m) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const addr = (i) => m.i32.and(g(i), c(~3));
  // __isa(obj, name, classKey) -> 0/1.  locals: 3=arr,4=backing,5=len,6=i
  m.addFunction("__isa", binaryen.createType([I32, I32, I32]), I32, [I32, I32, I32, I32], m.block(null, [
    m.if(m.i32.eqz(m.i32.and(g(0), c(1))), m.return(c(0))),               // not a pointer -> false
    m.if(m.i32.ne(ld(0, addr(0)), c(OBJTAG)), m.return(c(0))),            // not a plain object -> false
    m.local.set(3, m.call("__getprop", [g(0), g(2)], I32)),               // arr = obj.__class__
    m.if(m.i32.eqz(m.i32.and(g(3), c(1))), m.return(c(0))),
    m.if(m.i32.ne(ld(0, addr(3)), c(ARRTAG)), m.return(c(0))),            // __class__ isn't an array -> false
    m.local.set(4, ld(8, addr(3))), m.local.set(5, ld(4, addr(3))), m.local.set(6, c(0)),
    m.loop("I", m.block(null, [
      m.if(m.i32.ge_u(g(6), g(5)), m.return(c(0))),                       // exhausted -> false
      m.if(m.call("__eq", [ld(4, m.i32.add(g(4), m.i32.mul(g(6), c(4)))), g(1)], I32), m.return(c(1))), // backing[i] === name
      m.local.set(6, m.i32.add(g(6), c(1))), m.br("I"),
    ])),
    m.unreachable(),
  ], binaryen.none));
}

// A generator function compiles to two wasm functions. The TRAMPOLINE keeps the
// original name and is what CALLV calls: it allocates a generator object holding
// the body's table index and the initial args, and returns it (so no CALLV
// change is needed — a generator call just returns an object). locals: tmp.
function emitGenTrampoline(m, name, fn, bodyIdx) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const argc = fn.argc || 0, nl = fn.nlocals, tmp = argc + 1; // params 0..argc (env + args); tmp local after them
  const out = [
    m.local.set(tmp, m.i32.load(0, 4, c(BUMP_ADDR))),                                  // tmp = bump
    m.i32.store(0, 4, g(tmp), c(GENTAG)), m.i32.store(4, 4, g(tmp), c(bodyIdx)),
    m.i32.store(8, 4, g(tmp), c(0)), m.i32.store(12, 4, g(tmp), c(0)),                 // ip = 0, done = 0
  ];
  for (let k = 0; k < argc; k++) out.push(m.i32.store(20 + k * 4, 4, g(tmp), g(k + 1))); // slots[k] = arg_k (param k+1); offset 16 holds the sent value
  out.push(m.i32.store(0, 4, c(BUMP_ADDR), m.i32.add(g(tmp), c(20 + nl * 4))));         // bump past the object (extra slots are fresh 0)
  out.push(m.return(m.i32.or(g(tmp), c(1))));
  m.addFunction(name, binaryen.createType(new Array(argc + 1).fill(I32)), I32, [I32], m.block(null, out, binaryen.none));
}

// The dispatch BODY (`name$gen`), called by GENNEXT through the generator object.
// It restores its locals from the object, br_tables on the saved ip to the right
// basic block, runs to the next YIELD (save locals + ip, return the yielded
// value, done=0) or RET (done=1, return the value). A second, self-contained
// codegen path: a generator is inherently resumable, so it can't use the
// straight-line Relooper body. Numeric bodies for now (the common generator).
function compileGenBody(m, bodyName, fn) {
  const I32 = binaryen.i32;
  const nl = fn.nlocals, code = resolveLabels(fn.code), maxH = maxStack(code) + 1;
  const loc = (i) => i + 1, scratch = (k) => 1 + nl + k, ipLocal = 1 + nl + maxH;
  const get = (i) => m.local.get(i, I32);
  const genAddr = () => m.i32.and(get(0), m.i32.const(~3));                            // param 0 = the generator object
  const bool = (cond) => m.select(cond, m.i32.const(TRUE), m.i32.const(FALSE));
  const falsy = (i) => m.i32.or(m.i32.or(m.i32.eqz(get(i)), m.i32.eq(get(i), m.i32.const(UNDEF))), m.i32.or(m.i32.eq(get(i), m.i32.const(NULL)), m.i32.eq(get(i), m.i32.const(FALSE))));
  const goto = (b) => [m.local.set(ipLocal, m.i32.const(b)), m.br("L")]; // intra-call jump: update the dispatch local, re-dispatch
  const saveIp = (b) => m.i32.store(8, 4, genAddr(), m.i32.const(b));     // persist the resume point into the object (across calls)
  const setDone = (d) => m.i32.store(12, 4, genAddr(), m.i32.const(d));
  const saveLocals = () => { const out = []; for (let i = 0; i < nl; i++) out.push(m.i32.store(20 + i * 4, 4, genAddr(), get(loc(i)))); return out; };

  const Lset = new Set([0]);             // basic-block leaders (YIELD's successor is a resume point)
  code.forEach((ins, i) => {
    if (ins[0] === "JMP" || ins[0] === "JMPF") { Lset.add(ins[1]); if (i + 1 < code.length) Lset.add(i + 1); }
    else if ((ins[0] === "RET" || ins[0] === "YIELD") && i + 1 < code.length) Lset.add(i + 1);
  });
  const leaders = [...Lset].filter((x) => x >= 0 && x < code.length).sort((a, b) => a - b);
  const blockOf = (ip) => leaders.indexOf(ip);

  const rendered = [];                   // per block: [...stmts, ...terminator]
  for (let bi = 0; bi < leaders.length; bi++) {
    const start = leaders[bi], end = bi + 1 < leaders.length ? leaders[bi + 1] : code.length;
    const resume = start > 0 && code[start - 1][0] === "YIELD"; // entered on resume: the sent value sits on the operand stack
    const stmts = []; let h = resume ? 1 : 0, term = [];
    if (resume) stmts.push(m.local.set(scratch(0), m.i32.load(16, 4, genAddr()))); // the value passed to next() becomes the yield expression's value
    for (const ins of code.slice(start, end)) {
      switch (ins[0]) {
        case "PUSH": stmts.push(m.local.set(scratch(h), m.i32.const(immediate(ins[1])))); h++; break;
        case "LOAD": stmts.push(m.local.set(scratch(h), get(loc(ins[1])))); h++; break;
        case "STORE": h--; stmts.push(m.local.set(loc(ins[1]), get(scratch(h)))); break;
        case "POP": h--; break;
        case "DUP": stmts.push(m.local.set(scratch(h), get(scratch(h - 1)))); h++; break;
        case "BIN": {
          h -= 2; const a = get(scratch(h)), b = get(scratch(h + 1)), op = ins[1]; let e;
          if (op === "+") e = m.i32.add(a, b);
          else if (op === "-") e = m.i32.sub(a, b);
          else if (op === "*") e = m.i32.mul(m.i32.shr_s(a, m.i32.const(1)), b);
          else if (op === "<") e = bool(m.i32.lt_s(a, b));
          else if (op === "<=") e = bool(m.i32.le_s(a, b));
          else if (op === ">") e = bool(m.i32.gt_s(a, b));
          else if (op === ">=") e = bool(m.i32.ge_s(a, b));
          else if (op === "===" || op === "==") e = bool(m.i32.eq(a, b));
          else if (op === "!==" || op === "!=") e = bool(m.i32.ne(a, b));
          else throw new Error("aot: generator BIN " + op + " not yet supported");
          stmts.push(m.local.set(scratch(h), e)); h++; break;
        }
        case "JMP": term = goto(blockOf(ins[1])); break;
        case "JMPF": h--; term = [m.if(falsy(scratch(h)), m.block(null, goto(blockOf(ins[1])), binaryen.none))]; break;
        case "YIELD": h--; term = [...saveLocals(), saveIp(blockOf(end)), setDone(0), m.return(get(scratch(h)))]; break; // suspend: resume at the next block
        case "RET": h--; term = [setDone(1), m.return(get(scratch(h)))]; break;
        default: throw new Error("aot: opcode " + ins[0] + " not supported in a generator body yet");
      }
    }
    rendered.push([...stmts, ...term]); // a "fall" terminator is empty — control flows naturally to the next block's code
  }

  const N = leaders.length;
  const labels = leaders.map((_, i) => "b" + i);
  let node = m.block("b0", [m.switch(labels, "D", get(ipLocal))], binaryen.none); // br_table on ip, then b0 code follows
  for (let bi = 0; bi < N - 1; bi++) node = m.block("b" + (bi + 1), [node, ...rendered[bi]], binaryen.none);
  const dispatch = m.block("D", [node, ...rendered[N - 1]], binaryen.none);
  const prologue = [];
  for (let i = 0; i < nl; i++) prologue.push(m.local.set(loc(i), m.i32.load(20 + i * 4, 4, genAddr())));
  prologue.push(m.local.set(ipLocal, m.i32.load(8, 4, genAddr())));
  const body = m.block(null, [...prologue, m.loop("L", m.block(null, [dispatch, m.unreachable()], binaryen.none))], binaryen.none);
  m.addFunction(bodyName, binaryen.createType([I32]), I32, new Array(nl + maxH + 1).fill(I32), body);
}

// Runtime: drive a generator one step (added when a program uses generators).
function addGenRuntime(m, valueKey, doneKey) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const genAddr = () => m.i32.and(g(0), c(~3));
  // {value, done} result object.  locals: 3 = the object
  const mkResult = (valExpr, doneExpr) => m.block(null, [
    m.local.set(3, m.call("__newobj", [], I32)),
    m.local.set(3, m.call("__setprop", [g(3), c(valueKey), valExpr], I32)),
    m.local.set(3, m.call("__setprop", [g(3), c(doneKey), doneExpr], I32)),
    m.return(g(3)),
  ], binaryen.none);
  // __gennext(gen, sent) -> {value, done}.  locals: 2=ret, 3=obj
  m.addFunction("__gennext", binaryen.createType([I32, I32]), I32, [I32, I32], m.block(null, [
    m.if(m.i32.load(12, 4, genAddr()), mkResult(c(UNDEF), c(TRUE))),                    // already finished
    m.i32.store(16, 4, genAddr(), g(1)),                                               // the sent value (becomes the paused yield's value)
    m.local.set(2, m.call_indirect("0", m.i32.load(4, 4, genAddr()), [g(0)], binaryen.createType([I32]), I32)), // run to the next yield/return
    mkResult(g(2), m.select(m.i32.load(12, 4, genAddr()), c(TRUE), c(FALSE))),          // value + done (the body set done)
  ], binaryen.none));
}

// program: { name: { argc?, nlocals, code } }. resources: import names a RES may
// call. Returns wasm bytes, Asyncify-instrumented unless asyncify:false.
//
// Calling convention: every user function takes the closure environment as a
// leading param, so the exported entry's signature is (env, ...args). A host
// invoking it passes a dummy env (0) first — e.g. render(0, threshold). An
// entry with no args needs nothing extra (the missing env coerces to 0).
export function compileToWasm(program, { entry = "main", resources = [], asyncify = true, handles = false } = {}) {
  const m = new binaryen.Module();
  m.setMemory(1, 1, "memory");
  const uses = (...ops) => Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && ops.includes(i[0])));
  const usesClasses = uses("ISA");                          // instanceof needs the class runtime
  // A generator function is one a generator MAKECLOSURE (ins[3]) targets — not
  // just one that yields, so `function*(){}` with no yield still counts. Each is
  // compiled as a trampoline + dispatch body.
  const gens = [...new Set(Object.values(program).flatMap((fn) => fn.code.filter((i) => Array.isArray(i) && i[0] === "MAKECLOSURE" && i[3]).map((i) => i[1])))];
  const usesGenerators = gens.length > 0 || uses("GENNEXT", "YIELD"); // gen runtime + {value, done} objects
  const usesConstArray = Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && i[0] === "PUSH" && Array.isArray(i[1])));
  const usesArrays = uses("NEWARR", "ARRPUSH", "ARRGET", "ARRLEN") || usesConstArray; // __class__ name lists build arrays
  const usesObjects = uses("NEWOBJ", "GETPROP", "SETPROP", "SETHIDDEN", "CALLMETHOD") || usesClasses || usesGenerators; // instances, method dispatch, {value,done} results
  const usesStrings = usesClasses || Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && ((i[0] === "PUSH" && typeof i[1] === "string") || i[0] === "TYPEOF"))); // ISA compares class-name strings (__eq)
  if (usesArrays || usesObjects || usesStrings) m.setFeatures(binaryen.Features.All); // enable memory.copy (bulk memory) for the grow/concat paths
  // Property and method keys are interned to small ints at compile time, so
  // GETPROP/SETPROP/SETHIDDEN/CALLMETHOD are id matches in the object runtime.
  const keyIds = new Map();
  for (const fn of Object.values(program)) for (const i of fn.code) if (Array.isArray(i) && (i[0] === "GETPROP" || i[0] === "SETPROP" || i[0] === "SETHIDDEN" || i[0] === "CALLMETHOD") && !keyIds.has(i[1])) keyIds.set(i[1], keyIds.size + 1);
  if (usesGenerators) for (const k of ["value", "done"]) if (!keyIds.has(k)) keyIds.set(k, keyIds.size + 1); // GENNEXT builds {value, done}
  const arity = {}; // each resource is imported with the arity it is called with
  for (const fn of Object.values(program)) for (const i of fn.code) if (Array.isArray(i) && i[0] === "RES") arity[i[1]] = i[2] || 0;
  for (const res of resources) m.addFunctionImport(res, "env", res, binaryen.createType(new Array(arity[res] || 0).fill(binaryen.i32)), binaryen.i32);
  if (handles) m.addFunctionImport("__fetch", "env", "__fetch", binaryen.createType([binaryen.i32]), binaryen.i32); // §5 deref-miss suspends here
  // Closures call through a function table: every user function sits at its
  // program-order index, and a closure carries that index (MAKECLOSURE / CALLV).
  // A generator function adds a second entry — its dispatch body `name$gen`.
  const fnNames = [...Object.keys(program), ...gens.map((g) => g + "$gen")];
  const fnIndex = Object.fromEntries(fnNames.map((n, i) => [n, i]));
  const usesClosures = fnNames.length > 0 && uses("MAKECLOSURE", "CALLV", "CALLDYN", "CALLMETHOD"); // all call through the function table
  for (const [name, fn] of Object.entries(program)) {
    if (gens.includes(name)) { emitGenTrampoline(m, name, fn, fnIndex[name + "$gen"]); compileGenBody(m, name + "$gen", fn); } // generator: trampoline + dispatch body
    else compileFn(m, name, fn, handles, fnIndex, keyIds, usesStrings);
  }
  if (usesArrays) addArrayRuntime(m);
  if (usesObjects) addObjectRuntime(m);
  if (usesStrings) addStringRuntime(m);
  if (usesClasses) addClassRuntime(m);
  if (usesGenerators) addGenRuntime(m, keyIds.get("value"), keyIds.get("done"));
  if (usesClosures) {
    m.addTable("0", fnNames.length, fnNames.length, binaryen.funcref);
    m.addActiveElementSegment("0", "fns", fnNames, m.i32.const(0));
  }
  m.addFunctionExport(entry, entry);
  if (!m.validate()) { const txt = m.emitText(); throw new Error("aot: module did not validate\n" + txt); }
  if (asyncify) m.runPasses(["asyncify"]); // unwind/rewind frames to/from linear memory
  return m.emitBinary().slice();
}

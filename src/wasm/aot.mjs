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
// Class-object registry: one word per class (memoized class object for statics),
// in the free tail of the ctrl region [24, HEAP_BASE), so it ships with a
// migrated continuation. Up to (HEAP_BASE-24)/4 = 10 classes.
const CLSREG_BASE = 24;
// Exception state (the sentinel-return protocol): a pending-exception flag and
// the thrown value, in the ctrl region [0, 8). A throw with no local handler
// sets these and returns; each call site checks the flag and unwinds. Cleared
// when a handler catches, so it is 0 at any suspend point (no mid-throw migrate).
export const EXC_FLAG = 0, EXC_VALUE = 4; // exported so a host harness (e.g. the test262 runner) can detect an uncaught throw and read the thrown value
// The count of arguments actually passed to the current call, at ctrl word 12 (the
// gap between EXC_VALUE/BUMP_ADDR and the asyncify struct at 16). The uniform call
// signature pads missing args with undefined, so this is how `arguments` and a
// rest param recover the real count. A caller writes it immediately before the
// call; the callee reads it at entry (ARGUMENTS/GATHERREST run before any nested
// call can overwrite it). Only emitted when a program needs it.
const ARGC_ADDR = 12;

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
// A non-enumerable (SETHIDDEN) pair stores its key with HIDDEN_FLAG set — so
// hiddenness is PER PAIR, not per key id: a name can be a hidden method on one
// object and an enumerable data key on another (property matching masks the flag off,
// enumeration skips pairs that have it).
const OBJTAG = -3, INITCAP_OBJ = 2, HIDDEN_FLAG = 0x40000000;
// A string: [STRTAG, byteLength, ...bytes] (one byte per char, padded to a word).
// "+" and "===" become polymorphic — string-aware — through the runtime helpers.
const STRTAG = -4;
// A generator object: [GENTAG, bodyFnIndex, ip, done, ...savedLocals]. A generator
// function compiles to a trampoline (called normally, returns one of these) plus a
// dispatch body (resumed by GENNEXT) that saves/restores its locals here at YIELD.
const GENTAG = -5;
// A rejected promise: [REJTAG, value]. Promise.reject(v) (MKREJECT) builds one;
// awaiting it (AWAIT / Promise.all) throws v through the exception protocol. (In
// this synchronous model a resolved promise is its value, so only rejection is
// reified.)
const REJTAG = -6;
// A for-of iterator over an array (or other indexable collection): [ITERTAG, coll,
// idx]. ITER wraps the collection in one; GENNEXT advances it. A generator is
// already its own iterator, so ITER leaves a generator (and any iterator) as-is.
const ITERTAG = -7;
// Map and Set. Both are [tag, count, backing]; a Map backing is [cap, k0,v0,k1,v1,
// ...] (entries, like an object but keys are values compared by __eq, not interned
// ids), a Set backing is [cap, v0,v1,...] (so it iterates exactly like an array).
const MAPTAG = -8, SETTAG = -9;
// A boxed double: [FLOATTAG, f64]. Non-integer numbers (and ±Infinity/NaN) live
// here; a whole-valued result in tagged-int range normalizes back to a fixnum so
// === and the bitwise ops keep working. Integer arithmetic stays on the fast path.
const FLOATTAG = -10;
// A BigInt: [BIGTAG, sign, nlimbs, ...limbs] — sign (0 = non-negative, 1 = negative)
// and an arbitrary-precision magnitude in base-2^32, little-endian, normalized (zero
// is sign=0, nlimbs=0). The wasm side only builds literals and reads them back; every
// operation (+ - * / % ** & | ^ << >> compare toString) is delegated to the host's
// native BigInt (see stdlibHost), so semantics are exactly ECMAScript's — including
// negatives and true multi-limb division, which the in-module version never had.
const BIGTAG = -11;
// BigInt ops are delegated to the host: __big_bin(op, a, b) switches on this code
// (unary inc/neg ignore b). Shared by the compiler (which emits the code) and the
// host (which switches on it) so the two can never drift.
const BIGOPS = { add: 0, sub: 1, mul: 2, div: 3, mod: 4, pow: 5, and: 6, or: 7, xor: 8, shl: 9, shr: 10, inc: 11, neg: 12 };
// A regex: [REGEXTAG, sourceStr, flagsStr]. Matching is delegated to the host's
// real RegExp (see stdlibHost) — the pattern is just a string the host reads, so
// runtime-built patterns (new RegExp(s)) work the same as literals, and semantics
// are exactly ECMAScript's. The host reads source/flags/input from linear memory,
// runs RegExp, and writes the result (bool / string array / string) back.
const REGEXTAG = -12;


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

// The host side of the delegated stdlib: pure, synchronous, complex operations
// (regex, BigInt) handed to the platform's own RegExp / BigInt instead of being
// hand-rolled in wasm. Each import reads its operands out of the instance's linear
// memory, runs the real operation, and writes the result back through the bump
// pointer. Bound to the instance's memory + table after instantiation (none of these
// run during instantiation, so the late binding is safe). This is the model for any
// pure, synchronous, complex stdlib: delegate to the host, marshal at the edge.
export function stdlibHost() {
  let mem, table, exp;
  const dv = () => new DataView(mem.buffer);
  const readStr = (d, t) => { const a = t & ~3, n = d.getInt32(a + 4, true); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(a + 8 + i)); return s; };
  const allocStr = (d, s) => { const b = d.getInt32(BUMP_ADDR, true); d.setInt32(b, STRTAG, true); d.setInt32(b + 4, s.length, true); for (let i = 0; i < s.length; i++) d.setUint8(b + 8 + i, s.charCodeAt(i) & 0xff); d.setInt32(BUMP_ADDR, b + 8 + ((s.length + 3) & ~3), true); return b | 1; };
  const allocArr = (d, items) => { const cap = Math.max(items.length, 1), bk = d.getInt32(BUMP_ADDR, true); d.setInt32(bk, cap, true); for (let i = 0; i < items.length; i++) d.setInt32(bk + 4 + i * 4, items[i], true); const h = bk + (cap + 1) * 4; d.setInt32(h, ARRTAG, true); d.setInt32(h + 4, items.length, true); d.setInt32(h + 8, bk, true); d.setInt32(BUMP_ADDR, h + 12, true); return h | 1; };
  const allocFloat = (d, x) => { const b = d.getInt32(BUMP_ADDR, true); d.setInt32(b, FLOATTAG, true); d.setFloat64(b + 4, x, true); d.setInt32(BUMP_ADDR, b + 12, true); return b | 1; }; // a non-integer / out-of-fixnum-range JSON number
  const readRe = (d, p) => { const a = p & ~3; return new RegExp(readStr(d, d.getInt32(a + 4, true)), readStr(d, d.getInt32(a + 8, true))); };
  // JSON.parse: parse on the host, then rebuild the value tree IN the heap by calling
  // the runtime's own exported constructors — so this needs no heap-layout knowledge.
  // Numbers normalize exactly like __boxf (whole & |v| < 2^30 -> fixnum, else boxed).
  const encode = (v) => {
    if (v === null) return NULL;
    if (v === true) return TRUE;
    if (v === false) return FALSE;
    if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) < 0x40000000 ? v << 1 : allocFloat(dv(), v);
    if (typeof v === "string") return allocStr(dv(), v);
    if (Array.isArray(v)) { const a = exp.__newarr(); for (const x of v) exp.__arrpush(a, encode(x)); return a; }
    const o = exp.__newobj();
    for (const k of Object.keys(v)) { const id = exp.__keyid(allocStr(dv(), k)); exp.__setprop(o, id, encode(v[k])); } // intern the key (same id as a static .k access), then store
    return o;
  };
  // BigInt marshaling: [BIGTAG, sign, nlimbs, ...limbs] <-> a JS BigInt.
  const isBig = (d, t) => (t & 1) === 1 && (t & ~3) >= HEAP_BASE && d.getInt32(t & ~3, true) === BIGTAG;
  const isStr = (d, t) => (t & 1) === 1 && (t & ~3) >= HEAP_BASE && d.getInt32(t & ~3, true) === STRTAG;
  const readBig = (d, t) => { const a = t & ~3, sign = d.getInt32(a + 4, true), n = d.getInt32(a + 8, true); let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 32n) | BigInt(d.getUint32(a + 12 + i * 4, true)); return sign ? -v : v; };
  const writeBig = (d, val) => {
    const neg = val < 0n; let x = neg ? -val : val; const limbs = [];
    while (x > 0n) { limbs.push(Number(x & 0xffffffffn) >>> 0); x >>= 32n; }
    const b = d.getInt32(BUMP_ADDR, true);
    d.setInt32(b, BIGTAG, true); d.setInt32(b + 4, neg ? 1 : 0, true); d.setInt32(b + 8, limbs.length, true);
    for (let i = 0; i < limbs.length; i++) d.setUint32(b + 12 + i * 4, limbs[i], true);
    d.setInt32(BUMP_ADDR, b + 12 + limbs.length * 4, true);
    return b | 1;
  };
  const readNum = (d, t) => ((t & 1) === 0 ? t >> 1 : d.getFloat64((t & ~3) + 4, true)); // a fixnum or a boxed double
  const BINOP = { // every binary/unary op the compiler delegates (BIGOPS); unary inc/neg ignore y
    [BIGOPS.add]: (x, y) => x + y, [BIGOPS.sub]: (x, y) => x - y, [BIGOPS.mul]: (x, y) => x * y,
    [BIGOPS.div]: (x, y) => x / y, [BIGOPS.mod]: (x, y) => x % y, [BIGOPS.pow]: (x, y) => x ** y,
    [BIGOPS.and]: (x, y) => x & y, [BIGOPS.or]: (x, y) => x | y, [BIGOPS.xor]: (x, y) => x ^ y,
    [BIGOPS.shl]: (x, y) => x << y, [BIGOPS.shr]: (x, y) => x >> y, [BIGOPS.inc]: (x) => x + 1n, [BIGOPS.neg]: (x) => -x,
  };
  const imports = {
    __re_test: (re, str) => { const d = dv(); return readRe(d, re).test(readStr(d, str)) ? TRUE : FALSE; },
    __re_match: (re, str) => { const d = dv(); const m = readStr(d, str).match(readRe(d, re)); if (m === null) return NULL; return allocArr(d, m.map((x) => (x == null ? UNDEF : allocStr(d, x)))); },
    __re_replace: (re, str, repl, isFn) => {
      const d = dv(), rx = readRe(d, re), s = readStr(d, str);
      let out;
      if (isFn) { const f = table.get(d.getInt32((repl & ~3) + 4, true)); out = s.replace(rx, (mm) => { const mp = allocStr(dv(), mm), args = [repl, mp]; while (args.length < f.length) args.push(UNDEF); return readStr(dv(), f(...args)); }); } // host drives the loop, calls back into the wasm closure per match
      else { const r = readStr(d, repl); out = s.replace(rx, () => r); }
      return allocStr(dv(), out);
    },
    __big_bin: (op, a, b) => { const d = dv(); const r = BINOP[op](readBig(d, a), readBig(d, b)); return writeBig(dv(), r); }, // re-fetch dv: writeBig allocates
    __big_cmp: (a, b) => { const d = dv(), x = readBig(d, a), y = readBig(d, b); return x < y ? -1 : x > y ? 1 : 0; },
    __big_str: (a) => { const d = dv(); return allocStr(dv(), readBig(d, a).toString()); },
    __big_from: (taggedInt) => { const d = dv(); return writeBig(d, BigInt(taggedInt >> 1)); }, // BigInt(fixnum)
    __big_eq: (a, b) => { // loose ==: bigint vs bigint / number / numeric string, else value-equal strings, else identical bits
      if (a === b) return 1;
      const d = dv(), ab = isBig(d, a), bb = isBig(d, b);
      if (ab || bb) {
        if (ab && bb) return readBig(d, a) === readBig(d, b) ? 1 : 0;
        const big = ab ? readBig(d, a) : readBig(d, b), other = ab ? b : a;
        if (isStr(d, other)) { try { return big === BigInt(readStr(d, other)) ? 1 : 0; } catch { return 0; } } // "1" == 1n
        const nv = readNum(d, other);                                  // a fixnum or boxed double
        return Number.isInteger(nv) && big === BigInt(nv) ? 1 : 0;      // a bigint never loosely equals a non-integer
      }
      return isStr(d, a) && isStr(d, b) && readStr(d, a) === readStr(d, b) ? 1 : 0;
    },
    __num_str: (v) => { const d = dv(); return allocStr(dv(), String(d.getFloat64((v & ~3) + 4, true))); }, // a boxed double -> its JS string (shortest round-trip, exponent rules — the platform's own)
    __num_pow: (a, b) => { const d = dv(), r = Math.pow(readNum(d, a), readNum(d, b)); return Number.isInteger(r) && Math.abs(r) < 0x40000000 ? r << 1 : allocFloat(dv(), r); }, // a ** b for numbers, normalized like __boxf
    __json_parse: (strPtr) => encode(JSON.parse(readStr(dv(), strPtr))), // the host's own JSON.parse, rebuilt in the heap via the exported constructors
    __parse_int: (s, radix) => { const r = parseInt(readStr(dv(), s), radix >> 1); return Number.isInteger(r) && Math.abs(r) < 0x40000000 ? r << 1 : allocFloat(dv(), r); }, // radix 0 -> auto-detect
    __parse_float: (s) => { const r = parseFloat(readStr(dv(), s)); return Number.isInteger(r) && Math.abs(r) < 0x40000000 ? r << 1 : allocFloat(dv(), r); },
  };
  return { imports, bind: (inst) => { mem = inst.exports.memory; table = inst.exports.__table; exp = inst.exports; } };
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
// A reserved sentinel raised through the exception protocol by a generator's .return()
// (mode 2): it flows through finally handlers (which re-raise it) exactly like a thrown
// value, but __genret recognizes it and completes with the return value instead of
// throwing — so a *real* throw inside a finally (a different EXC value) still propagates.
// Odd and below HEAP_BASE, so it's never a user value (like UNDEF/NULL/...).
const RETSIG = 0x11;
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
  if (dv.getInt32(addr, true) === FLOATTAG) return dv.getFloat64(addr + 4, true);
  if (dv.getInt32(addr, true) === BIGTAG) {
    const sign = dv.getInt32(addr + 4, true), n = dv.getInt32(addr + 8, true);
    let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 32n) | BigInt(dv.getUint32(addr + 12 + i * 4, true));
    return sign ? -v : v;
  }
  if (dv.getInt32(addr, true) === REGEXTAG) {
    const rd = (t) => { const a = t & ~3, n = dv.getInt32(a + 4, true); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(a + 8 + i)); return s; };
    return new RegExp(rd(dv.getInt32(addr + 4, true)), rd(dv.getInt32(addr + 8, true)));
  }
  return { ptr: addr };
}
// Like readValue but fully materializes aggregates (arrays, objects, Map, Set) into
// JS values, recursing through the heap; identity/cycles preserved via a seen-map.
// Object keys resolve through `keystr` (an id -> string fn — e.g. inst.exports.__keystr
// read back through readValue); a key that resolves to null (hidden / non-enumerable)
// is skipped, matching JS's enumerable-only view. Closures/generators come back as
// markers. This host-side walk is the prototype of the in-module __serialize (same
// tag-directed traversal — see docs/native-migration.md).
export function readDeep(memory, v, keystr) {
  const dv = new DataView(memory.buffer);
  const str = (t) => { const a = t & ~3, n = dv.getInt32(a + 4, true); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(a + 8 + i)); return s; };
  const seen = new Map();
  const rec = (v) => {
    if (!isPointer(v) || v === UNDEF || v === NULL || v === TRUE || v === FALSE) return decodeValue(v);
    const addr = pointerAddr(v), tag = dv.getInt32(addr, true);
    if (tag === STRTAG) return str(v);
    if (tag === FLOATTAG) return dv.getFloat64(addr + 4, true);
    if (tag === BIGTAG) { const sign = dv.getInt32(addr + 4, true), n = dv.getInt32(addr + 8, true); let x = 0n; for (let i = n - 1; i >= 0; i--) x = (x << 32n) | BigInt(dv.getUint32(addr + 12 + i * 4, true)); return sign ? -x : x; }
    if (tag === REGEXTAG) return new RegExp(str(dv.getInt32(addr + 4, true)), str(dv.getInt32(addr + 8, true)));
    if (seen.has(addr)) return seen.get(addr);
    if (tag === ARRTAG) {
      const out = []; seen.set(addr, out);
      const len = dv.getInt32(addr + 4, true), backing = dv.getInt32(addr + 8, true);
      for (let i = 0; i < len; i++) out.push(rec(dv.getInt32(backing + 4 + i * 4, true)));
      return out;
    }
    if (tag === OBJTAG) {
      const out = {}; seen.set(addr, out);
      const count = dv.getInt32(addr + 4, true), backing = dv.getInt32(addr + 8, true);
      for (let i = 0; i < count; i++) { const raw = dv.getInt32(backing + 4 + 8 * i, true); if (raw & HIDDEN_FLAG) continue; const key = keystr ? keystr(raw & ~HIDDEN_FLAG) : null; if (key == null) continue; out[key] = rec(dv.getInt32(backing + 8 + 8 * i, true)); }
      return out;
    }
    if (tag === MAPTAG) {
      const out = new Map(); seen.set(addr, out);
      const count = dv.getInt32(addr + 4, true), backing = dv.getInt32(addr + 8, true);
      for (let i = 0; i < count; i++) out.set(rec(dv.getInt32(backing + 4 + 8 * i, true)), rec(dv.getInt32(backing + 8 + 8 * i, true)));
      return out;
    }
    if (tag === SETTAG) {
      const out = new Set(); seen.set(addr, out);
      const count = dv.getInt32(addr + 4, true), backing = dv.getInt32(addr + 8, true);
      for (let i = 0; i < count; i++) out.add(rec(dv.getInt32(backing + 4 + i * 4, true)));
      return out;
    }
    if (tag === CLOSTAG) return "[function]";
    if (tag === GENTAG) return "[generator]";
    return { ptr: addr };
  };
  return rec(v);
}
// Map an IR PUSH literal to its tagged immediate (a fixnum / singleton). Aggregates
// (strings, floats, bigints, regex, const arrays) are built on the heap by pushLit.
function immediate(x) {
  if (x === undefined) return UNDEF;
  if (x === null) return NULL;
  if (x === true) return TRUE;
  if (x === false) return FALSE;
  if (typeof x === "number" && Number.isInteger(x)) return x << 1;
  throw new Error("aot: unsupported literal " + JSON.stringify(x));
}

// Build a PUSH literal `v` into local `slot` (using slot+1 as a temp for regex/array
// elements). Shared by compileFn and the generator-body codegen so the two can't
// drift on literal handling (a string literal in a generator used to throw here).
function pushLit(m, slot, v) {
  const I32 = binaryen.i32, get = (i) => m.local.get(i, I32);
  const buildStr = (sl, s) => {
    const out = [m.local.set(sl, m.i32.load(0, 4, m.i32.const(BUMP_ADDR))),
      m.i32.store(0, 4, get(sl), m.i32.const(STRTAG)), m.i32.store(4, 4, get(sl), m.i32.const(s.length))];
    for (let k = 0; k < s.length; k++) out.push(m.i32.store8(8 + k, 1, get(sl), m.i32.const(s.charCodeAt(k))));
    out.push(m.i32.store(0, 4, m.i32.const(BUMP_ADDR), m.i32.add(get(sl), m.i32.const(8 + ((s.length + 3) & ~3)))));
    out.push(m.local.set(sl, m.i32.or(get(sl), m.i32.const(1))));
    return out;
  };
  if (typeof v === "string") return buildStr(slot, v);
  if (Array.isArray(v)) {                              // a constant array (e.g. a class's __class__ name list)
    const out = [m.local.set(slot, m.call("__newarr", [], I32))];
    for (const el of v) {
      if (typeof el === "string") out.push(...buildStr(slot + 1, el));
      else out.push(m.local.set(slot + 1, m.i32.const(immediate(el))));
      out.push(m.drop(m.call("__arrpush", [get(slot), get(slot + 1)], I32)));
    }
    return out;
  }
  if (typeof v === "bigint") {                          // [BIGTAG, sign, nlimbs, ...limbs]
    const neg = v < 0n; let x = neg ? -v : v; const limbs = [];
    while (x > 0n) { limbs.push(Number(x & 0xffffffffn) | 0); x >>= 32n; }
    const out = [m.local.set(slot, m.i32.load(0, 4, m.i32.const(BUMP_ADDR))),
      m.i32.store(0, 4, get(slot), m.i32.const(BIGTAG)), m.i32.store(4, 4, get(slot), m.i32.const(neg ? 1 : 0)), m.i32.store(8, 4, get(slot), m.i32.const(limbs.length))];
    for (let k = 0; k < limbs.length; k++) out.push(m.i32.store(12 + k * 4, 4, get(slot), m.i32.const(limbs[k])));
    out.push(m.i32.store(0, 4, m.i32.const(BUMP_ADDR), m.i32.add(get(slot), m.i32.const(12 + limbs.length * 4))));
    out.push(m.local.set(slot, m.i32.or(get(slot), m.i32.const(1))));
    return out;
  }
  if (v instanceof RegExp) return [                     // [REGEXTAG, sourceStr, flagsStr]
    m.local.set(slot, m.i32.load(0, 4, m.i32.const(BUMP_ADDR))),
    m.i32.store(0, 4, get(slot), m.i32.const(REGEXTAG)),
    m.i32.store(0, 4, m.i32.const(BUMP_ADDR), m.i32.add(get(slot), m.i32.const(12))),
    ...buildStr(slot + 1, v.source), m.i32.store(4, 4, get(slot), get(slot + 1)),
    ...buildStr(slot + 1, v.flags), m.i32.store(8, 4, get(slot), get(slot + 1)),
    m.local.set(slot, m.i32.or(get(slot), m.i32.const(1))),
  ];
  if (typeof v === "number" && !Number.isInteger(v)) return [   // boxed double [FLOATTAG, f64]
    m.local.set(slot, m.i32.load(0, 4, m.i32.const(BUMP_ADDR))),
    m.i32.store(0, 4, get(slot), m.i32.const(FLOATTAG)), m.f64.store(4, 8, get(slot), m.f64.const(v)),
    m.i32.store(0, 4, m.i32.const(BUMP_ADDR), m.i32.add(get(slot), m.i32.const(12))),
    m.local.set(slot, m.i32.or(get(slot), m.i32.const(1))),
  ];
  return [m.local.set(slot, m.i32.const(immediate(v)))];
}

// The polymorphic result of `a <op> b` (a, b are thunks — a fresh local.get per use,
// no IR-node sharing). Integer fast path with string-/float-/bigint-aware fallbacks
// (JS semantics). Shared by compileFn AND the generator-body codegen so the two can't
// drift on operators (string concat / === / etc. used to be integer-only in generators).
function binExpr(m, op, a, b, strings, floats, bigs) {
  const I32 = binaryen.i32;
  const bool = (cond) => m.select(cond, m.i32.const(TRUE), m.i32.const(FALSE));
  const isBigE = (x) => m.i32.and(m.i32.eq(m.i32.and(x(), m.i32.const(3)), m.i32.const(1)), m.i32.eq(m.i32.load(0, 4, m.i32.and(x(), m.i32.const(0xfffc))), m.i32.const(BIGTAG)));
  const arith = () => {
    const bothInt = () => m.i32.eqz(m.i32.and(m.i32.or(a(), b()), m.i32.const(1)));
    const intAdd = () => m.i32.add(a(), b()), intSub = () => m.i32.sub(a(), b()), intMul = () => m.i32.mul(m.i32.shr_s(a(), m.i32.const(1)), b());
    const cmpSym = { "<": (x) => m.i32.lt_s(x, m.i32.const(0)), "<=": (x) => m.i32.le_s(x, m.i32.const(0)), ">": (x) => m.i32.gt_s(x, m.i32.const(0)), ">=": (x) => m.i32.ge_s(x, m.i32.const(0)) };
    const num = () => {
      if (op === "/") return m.call("__divf", [a(), b()], I32);
      if (op === "+") return (floats || strings) ? m.if(bothInt(), intAdd(), m.call(strings ? "__add" : "__addf", [a(), b()], I32)) : intAdd(); // strings -> concat-or-numeric (__add); floats-only -> pure-numeric (__addf, no string runtime)
      if (op === "-") return floats ? m.if(bothInt(), intSub(), m.call("__subf", [a(), b()], I32)) : intSub();
      if (op === "*") return floats ? m.if(bothInt(), intMul(), m.call("__mulf", [a(), b()], I32)) : intMul();
      const ci = { "<": m.i32.lt_s, "<=": m.i32.le_s, ">": m.i32.gt_s, ">=": m.i32.ge_s }[op];
      const cf = { "<": "__ltf", "<=": "__lef", ">": "__gtf", ">=": "__gef" }[op];
      return floats ? m.if(bothInt(), bool(ci(a(), b())), m.call(cf, [a(), b()], I32)) : bool(ci(a(), b()));
    };
    if (bigs) {
      const bc = { "+": BIGOPS.add, "-": BIGOPS.sub, "*": BIGOPS.mul, "/": BIGOPS.div }[op];
      const bigE = bc !== undefined ? m.call("__big_bin", [m.i32.const(bc), a(), b()], I32) : cmpSym[op] ? bool(cmpSym[op](m.call("__big_cmp", [a(), b()], I32))) : null;
      if (bigE) return m.if(isBigE(a), bigE, num());
    }
    return num();
  };
  const big = (code, intExpr) => bigs ? m.if(isBigE(a), m.call("__big_bin", [m.i32.const(code), a(), b()], I32), intExpr) : intExpr;
  if (op === "+" || op === "-" || op === "*" || op === "/" || op === "<" || op === "<=" || op === ">" || op === ">=") return arith();
  if (op === "===") return (strings || floats || bigs) ? bool(m.call("__eq", [a(), b()], I32)) : bool(m.i32.eq(a(), b()));
  if (op === "!==") return (strings || floats || bigs) ? bool(m.i32.eqz(m.call("__eq", [a(), b()], I32))) : bool(m.i32.ne(a(), b()));
  if (op === "==") return bigs ? bool(m.call("__big_eq", [a(), b()], I32)) : (strings || floats) ? bool(m.call("__eq", [a(), b()], I32)) : bool(m.i32.eq(a(), b()));
  if (op === "!=") return bigs ? bool(m.i32.eqz(m.call("__big_eq", [a(), b()], I32))) : (strings || floats) ? bool(m.i32.eqz(m.call("__eq", [a(), b()], I32))) : bool(m.i32.ne(a(), b()));
  if (op === "**") { const np = m.call("__num_pow", [a(), b()], I32); return bigs ? m.if(isBigE(a), m.call("__big_bin", [m.i32.const(BIGOPS.pow), a(), b()], I32), np) : np; }
  if (op === "&") return big(BIGOPS.and, m.i32.and(a(), b()));
  if (op === "|") return big(BIGOPS.or, m.i32.or(a(), b()));
  if (op === "^") return big(BIGOPS.xor, m.i32.xor(a(), b()));
  if (op === "%") return big(BIGOPS.mod, m.i32.rem_s(a(), b()));
  if (op === "<<") return big(BIGOPS.shl, m.i32.shl(a(), m.i32.shr_s(b(), m.i32.const(1))));
  if (op === ">>") return big(BIGOPS.shr, m.i32.shl(m.i32.shr_s(m.i32.shr_s(a(), m.i32.const(1)), m.i32.shr_s(b(), m.i32.const(1))), m.i32.const(1)));
  if (op === ">>>") return m.i32.shl(m.i32.shr_u(m.i32.shr_s(a(), m.i32.const(1)), m.i32.shr_s(b(), m.i32.const(1))), m.i32.const(1));
  throw new Error("aot: unsupported BIN " + op);
}

const DELTA = { PUSH: 1, LOAD: 1, LOADENV: 1, LOADTHIS: 1, DUP: 1, STORE: -1, POP: -1, ADD: -1, SUB: -1, MUL: -1, NEG: 0, INC: 0, DEC: 0, NOT: 0, BITNOT: 0, LT: -1, LE: -1, GT: -1, GE: -1, RET: -1, JMPF: -1, JMP: 0, ALLOC: 0, AGET: -1, ASET: -3, NEWARR: 1, ARRPUSH: -2, ARRGET: -1, ARRLEN: 0, BIN: -1, MAKECLOSURE: 1, NEWOBJ: 1, GETPROP: 0, SETPROP: -1, SETHIDDEN: -1, GETPROPA: 0, SETPROPA: -1, ISA: 0, TYPEOF: 0, YIELD: 0, ITER: 0, AWAIT: 0, GENNEXT: -1, GENRET: -1, CLSGET: 1, CLSPUT: 0, ISNULLISH: 0, CALLVS: -1, PUSHTRY: 0, POPTRY: 0, THROW: -1, GENTHROW: -1, INDEX: -1, SETINDEX: -3, ISARRAY: 0, GLOBAL: 1, CALLMS: -1, APPENDALL: -1, ARGUMENTS: 1, GATHERREST: 0, TOARRAY: 0, ASSIGNALL: -1, DELPROP: 0, KEYS: 0, JSONSTR: -2, AWAITALL: 0, MKREJECT: 0 };
const delta = (ins) => ins[0] === "CALL" || ins[0] === "RES" ? 1 - (ins[2] || 0) : ins[0] === "CALLV" ? -ins[1] : ins[0] === "CALLDYN" ? -(ins[1] + 1) : ins[0] === "CALLMETHOD" || ins[0] === "CALLM" ? -ins[2] : ins[0] === "CALLG" || ins[0] === "CTORG" ? 1 - (ins[2] || 0) : DELTA[ins[0]] ?? 0;
// Ops that run user code and can therefore propagate an exception — so a block ends
// after one, and the next checks the pending-exception flag.
const CALL_OPS = new Set(["CALL", "CALLV", "CALLMETHOD", "CALLDYN", "CALLVS", "GETPROPA", "SETPROPA", "GENNEXT", "GENTHROW", "GENRET", "AWAIT", "AWAITALL"]);

// Labeled asm -> instruction list with JMP/JMPF targets resolved to indices.
function resolveLabels(rawCode) {
  const labels = {}, code = [];
  for (const item of rawCode) { if (typeof item === "string") labels[item] = code.length; else code.push(item); }
  return code.map((ins) => ((ins[0] === "JMP" || ins[0] === "JMPF") && typeof ins[1] === "string" ? [ins[0], labels[ins[1]]] : ins));
}

// Basic-block leaders: index 0, every branch target, and the instruction after
// every branch or RET. With exceptions on, a catch target, the instruction after
// a THROW, and the instruction after each call all start blocks too (a call ends
// a block so the next can check the pending-exception flag).
function leaderSet(code, hasExc) {
  const L = new Set([0]);
  code.forEach((ins, i) => {
    if (ins[0] === "JMP" || ins[0] === "JMPF") { L.add(ins[1]); if (i + 1 < code.length) L.add(i + 1); }
    else if (ins[0] === "RET" && i + 1 < code.length) L.add(i + 1);
    else if (hasExc && ins[0] === "PUSHTRY") L.add(ins[1]);
    else if (hasExc && (ins[0] === "THROW" || CALL_OPS.has(ins[0])) && i + 1 < code.length) L.add(i + 1);
  });
  return [...L].filter((x) => x >= 0 && x < code.length).sort((a, b) => a - b);
}

const maxStack = (code) => { let h = 0, max = 0; for (const ins of code) { h += delta(ins); if (h > max) max = h; } return max; };

// Per-block operand-stack entry heights, by propagating over the CFG. Structured
// IR keeps the height consistent at every block boundary — but not always zero
// (e.g. for-of keeps the result object on the stack across the done-check branch),
// so a block indexes its scratch slots from its entry height, not from zero.
// Also returns the max absolute height (for sizing the scratch locals) and, for
// exceptions, the lexically-active handler { catch, sp } of each block's throwing
// terminator (a THROW or call) — by tracking PUSHTRY/POPTRY and seeding each
// catch block (reached only via the exception edge) with the thrown value on top.
function blockHeights(code, leaders) {
  const blockAt = new Map(leaders.map((s, i) => [s, i]));
  const endOf = (bi) => (bi + 1 < leaders.length ? leaders[bi + 1] : code.length);
  const entry = new Array(leaders.length).fill(undefined);
  const entryHand = new Array(leaders.length).fill(undefined); // handler stack: [{ catch: ip, sp }]
  const blockHandler = new Array(leaders.length).fill(null);
  entry[0] = 0; entryHand[0] = []; let maxAbs = 0; const q = [0];
  while (q.length) {
    const bi = q.shift(); let h = entry[bi]; if (h > maxAbs) maxAbs = h;
    const hand = entryHand[bi].slice();
    for (let k = leaders[bi]; k < endOf(bi); k++) {
      const ins = code[k];
      if (ins[0] === "PUSHTRY") {
        const cb = blockAt.get(ins[1]);
        if (cb !== undefined && entry[cb] === undefined) { entry[cb] = h + 1; entryHand[cb] = hand.slice(); q.push(cb); } // catch: thrown value on top, enclosing handlers
        hand.push({ catch: ins[1], sp: h });
      } else if (ins[0] === "POPTRY") hand.pop();
      else if (ins[0] === "THROW" || CALL_OPS.has(ins[0])) blockHandler[bi] = hand.length ? hand[hand.length - 1] : null;
      h += delta(ins); if (h > maxAbs) maxAbs = h;
    }
    const last = code[endOf(bi) - 1], succ = [];
    if (last[0] === "JMP") succ.push(blockAt.get(last[1]));
    else if (last[0] === "JMPF") { succ.push(blockAt.get(last[1])); succ.push(blockAt.get(endOf(bi))); }
    else if (last[0] !== "RET" && last[0] !== "THROW") succ.push(blockAt.get(endOf(bi))); // fall-through
    for (const s of succ) {
      if (s === undefined) continue;
      if (entry[s] === undefined) { entry[s] = h; entryHand[s] = hand.slice(); q.push(s); }
      else if (entry[s] !== h) throw new Error(`aot: inconsistent stack height entering block @${leaders[s]} (${entry[s]} vs ${h})`);
    }
  }
  const entryHandler = entryHand.map((hs) => (hs && hs.length ? hs[hs.length - 1] : null)); // active handler when a block is entered (for a resume point inside a try)
  return { entryH: entry, maxAbs, blockHandler, entryHandler };
}

function compileFn(m, name, fn, handles, fnIndex, keyIds, strings, clsIds, exceptions, maxargs, needsArgc, reject, mapSet, floats, bigs) {
  const I32 = binaryen.i32;
  const argc = fn.argc || 0, nl = fn.nlocals;
  const code = resolveLabels(fn.code);
  const leaders = leaderSet(code, exceptions);
  const { entryH, maxAbs, blockHandler } = blockHeights(code, leaders);
  const maxH = maxAbs + 1;           // +1 scratch headroom for ALLOC / build temps
  // Calling convention: WASM local 0 is the closure environment — the receiver of
  // a CALLV, the implicit (unused) arg of a direct CALL, and where LOADENV /
  // capturing MAKECLOSUREs read and write. Every table-reachable function shares
  // ONE signature — env + `maxargs` slots — so an indirect call (a HOF callback,
  // a method) never mismatches the callee's arity; missing args are passed
  // undefined, extras ignored. The P param slots are env + maxargs; an argument i
  // lives in param 1+i, and the non-arg IR locals + scratch sit above all params.
  const ENV = 0, P = 1 + maxargs;
  const loc = (i) => (i < argc ? 1 + i : P + (i - argc));
  const scratch = (k) => P + (nl - argc) + k;
  const labelHelper = P + (nl - argc) + maxH; // the Relooper's scratch local
  const callType = () => binaryen.createType(new Array(P).fill(I32)); // the uniform table signature
  const padTo = (args) => { while (args.length < P) args.push(m.i32.const(UNDEF)); return args; };
  // Publish the actual argument count for the callee's ARGUMENTS/GATHERREST (no-op
  // unless the program uses them). `expr` is an i32 expression (binaryen handles
  // are themselves numbers, so a static count must be wrapped in i32.const first).
  const setArgc = (expr) => needsArgc ? [m.i32.store(0, 4, m.i32.const(ARGC_ADDR), expr)] : [];
  const get = (i) => m.local.get(i, I32);
  const bool = (cond) => m.select(cond, m.i32.const(TRUE), m.i32.const(FALSE));   // i32 0/1 -> tagged boolean
  // JS truthiness of the value in local `i`: falsy is 0, undefined, null, false.
  // Takes the local index (not an expression) so each use is a fresh local.get —
  // a Binaryen IR node can't be shared between parents.
  const falsy = (i) => m.i32.or(m.i32.or(m.i32.eqz(get(i)), m.i32.eq(get(i), m.i32.const(UNDEF))), m.i32.or(m.i32.eq(get(i), m.i32.const(NULL)), m.i32.eq(get(i), m.i32.const(FALSE))));
  // Is the value in local `i` an array? A tagged pointer (low bits == 01) whose
  // heap tag word is ARRTAG. The address is masked to one page so a non-pointer
  // operand can't fault the tag load (the low-bits test then masks the result).
  const isArr = (i) => m.i32.and(m.i32.eq(m.i32.and(get(i), m.i32.const(3)), m.i32.const(1)), m.i32.eq(m.i32.load(0, 4, m.i32.and(get(i), m.i32.const(0xfffc))), m.i32.const(ARRTAG)));
  // Is the value from thunk `a` a bigint? (a tagged pointer whose tag word is BIGTAG)
  const isBigE = (a) => m.i32.and(m.i32.eq(m.i32.and(a(), m.i32.const(3)), m.i32.const(1)), m.i32.eq(m.i32.load(0, 4, m.i32.and(a(), m.i32.const(0xfffc))), m.i32.const(BIGTAG)));
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
  // (bigint / regex / float / const-array literals are built by the shared module-level
  // pushLit; buildStrInto stays because ISA, join's default separator, and the RegExp
  // constructor also build bare strings.)
  // Arithmetic / comparison / bitwise (ADD..GE and BIN) share the module-level
  // binExpr — keeping the integer fast path with float/string/bigint fallbacks in
  // one place, used by both this body codegen and the generator-body codegen.
  // Exception protocol helpers.
  const excFlag = () => m.i32.load(0, 4, m.i32.const(EXC_FLAG));                                // pending?
  const raise = (valSlot) => [m.i32.store(0, 4, m.i32.const(EXC_VALUE), get(valSlot)), m.i32.store(0, 4, m.i32.const(EXC_FLAG), m.i32.const(1))]; // set EXC_VALUE + flag (propagate)
  const propagate = () => m.return(m.i32.const(0));                                             // unwind: return a dummy; the caller checks the flag
  const catchInto = (sp) => m.block(null, [m.local.set(scratch(sp), m.i32.load(0, 4, m.i32.const(EXC_VALUE))), m.i32.store(0, 4, m.i32.const(EXC_FLAG), m.i32.const(0))], binaryen.none); // a caught propagated exception: value onto the operand stack, clear the flag

  const r = new binaryen.Relooper(m);
  const refOf = new Map();           // leader index -> Relooper block
  const blocks = [];                 // { ref, term }

  for (let bi = 0; bi < leaders.length; bi++) {
    if (entryH[bi] === undefined) continue; // unreachable (e.g. a try body that always returns/throws leaves a dead fall-through)
    const start = leaders[bi];
    const end = bi + 1 < leaders.length ? leaders[bi + 1] : code.length;
    const stmts = [];
    let h = entryH[bi], result = null, term = { kind: "fall", next: end };
    for (const ins of code.slice(start, end)) {
      switch (ins[0]) {
        case "PUSH": stmts.push(...pushLit(m, scratch(h), ins[1])); h++; break; // string / array / bigint / regex / float / immediate (shared with the generator-body codegen)
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
          h -= 2; const sa = scratch(h), sb = scratch(h + 1);
          const sym = { ADD: "+", SUB: "-", MUL: "*", LT: "<", LE: "<=", GT: ">", GE: ">=" }[ins[0]];
          stmts.push(m.local.set(scratch(h), binExpr(m, sym, () => get(sa), () => get(sb), strings, floats, bigs))); h++; break;
        }
        case "CALL": case "RES": {
          const ac = ins[2] || 0; h -= ac;
          const args = []; for (let j = 0; j < ac; j++) args.push(get(scratch(h + j)));
          // user functions take the env as param 0 (a direct call has no closure, so 0)
          // and are padded to the uniform arity; resources are host imports, called
          // with their natural arity.
          const callArgs = ins[0] === "CALL" ? padTo([m.i32.const(0), ...args]) : args;
          if (ins[0] === "CALL") stmts.push(...setArgc(m.i32.const(ac)));
          stmts.push(m.local.set(scratch(h), m.call(ins[1], callArgs, I32))); h++; break;
        }
        case "BIN": {                          // tsc.mjs binary op (polymorphic int/float/string/bigint) — shared with the generator-body codegen
          h -= 2; const sa = scratch(h), sb = scratch(h + 1);
          stmts.push(m.local.set(scratch(h), binExpr(m, ins[1], () => get(sa), () => get(sb), strings, floats, bigs))); h++; break;
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
            else if (kind === "E" || (kind === "T" && ci >= 0)) v = m.i32.load(8 + ci * 4, 4, m.i32.and(get(ENV), m.i32.const(~3))); // re-capture an outer env slot; "T" = an arrow snapshotting the owner's lexical `this` (already in env)
            else throw new Error("aot: closure capture kind " + kind + (kind === "T" ? " (dynamic this — no lexical receiver)" : "") + " not yet supported");
            stmts.push(m.i32.store(8 + j * 4, 4, get(tmp), v));
          });
          stmts.push(m.i32.store(0, 4, m.i32.const(BUMP_ADDR), m.i32.add(get(tmp), m.i32.const(8 + caps.length * 4))));
          stmts.push(m.local.set(scratch(h), m.i32.or(get(tmp), m.i32.const(1)))); h++; break;                    // tagged closure pointer
        }
        case "CALLV": {                        // call a closure value: stack is [closure, arg0..arg_{argc-1}]
          const argc = ins[1]; h -= argc + 1;
          const fn = m.i32.load(4, 4, m.i32.and(get(scratch(h)), m.i32.const(~3)));                              // closure[1] = fn table index
          const args = [get(scratch(h))]; for (let k = 0; k < argc; k++) args.push(get(scratch(h + 1 + k)));    // env (the closure itself) is param 0
          stmts.push(...setArgc(m.i32.const(argc)));
          stmts.push(m.local.set(scratch(h), m.call_indirect("0", fn, padTo(args), callType(), I32))); h++; break;
        }
        case "CALLDYN": {                      // recv[key](args): dynamic dispatch. Supported receiver is an array
          const argc = ins[1]; h -= argc + 2;  // (a closure held in a collection, e.g. fns[j]()); the array element IS the closure.
          const recv = scratch(h);             // stack: [recv, key, arg0..arg_{argc-1}]
          const backing = m.i32.load(8, 4, m.i32.and(get(recv), m.i32.const(~3)));
          const callee = m.i32.load(4, 4, m.i32.add(backing, m.i32.mul(m.i32.shr_s(get(scratch(h + 1)), m.i32.const(1)), m.i32.const(4)))); // recv[untag(key)]
          stmts.push(m.local.set(recv, callee));                                                                 // stash the closure in the receiver slot
          const fn = m.i32.load(4, 4, m.i32.and(get(recv), m.i32.const(~3)));
          const args = [get(recv)]; for (let k = 0; k < argc; k++) args.push(get(scratch(h + 2 + k)));           // env (the closure) is param 0; `this` (recv) is dropped (no method use yet)
          stmts.push(...setArgc(m.i32.const(argc)));
          stmts.push(m.local.set(scratch(h), m.call_indirect("0", fn, padTo(args), callType(), I32))); h++; break;
        }
        case "TYPEOF": stmts.push(m.local.set(scratch(h - 1), m.call("__typeof", [get(scratch(h - 1))], I32))); break; // value -> type string
        case "ITER": stmts.push(m.local.set(scratch(h - 1), m.call("__iter", [get(scratch(h - 1))], I32))); break; // normalize an iterable -> iterator (an array gets wrapped; a generator passes through)
        case "AWAIT": if (reject) stmts.push(m.local.set(scratch(h - 1), m.call("__awaitchk", [get(scratch(h - 1))], I32))); break; // await: identity, but a rejected promise throws
        case "AWAITALL": if (reject) stmts.push(m.local.set(scratch(h - 1), m.call("__awaitall", [get(scratch(h - 1))], I32))); break; // Promise.all: the resolved array (already on the stack), but a rejection throws
        case "MKREJECT": stmts.push(m.local.set(scratch(h - 1), m.call("__mkreject", [get(scratch(h - 1))], I32))); break; // Promise.reject(v) -> a rejection cell
        case "CLSGET": {                       // class-object registry read: cached class object for a name, else undefined
          const at = m.i32.const(CLSREG_BASE + clsIds.get(ins[1]) * 4);
          stmts.push(m.local.set(scratch(h), m.i32.load(0, 4, at)));
          stmts.push(m.local.set(scratch(h), m.select(m.i32.eqz(get(scratch(h))), m.i32.const(UNDEF), get(scratch(h))))); h++; break; // 0 = not built -> undefined
        }
        case "CLSPUT": stmts.push(m.i32.store(0, 4, m.i32.const(CLSREG_BASE + clsIds.get(ins[1]) * 4), get(scratch(h - 1)))); break; // memoize, leave on the stack
        case "ISNULLISH": stmts.push(m.local.set(scratch(h - 1), bool(m.i32.or(m.i32.eq(get(scratch(h - 1)), m.i32.const(UNDEF)), m.i32.eq(get(scratch(h - 1)), m.i32.const(NULL)))))); break;
        case "CALLVS": {                       // call a closure with a spread args array: [closure, argsArray] -> result
          h -= 2; const closeSlot = scratch(h), argsSlot = scratch(h + 1);
          const fn = m.i32.load(4, 4, m.i32.and(get(closeSlot), m.i32.const(~3)));
          const len = () => m.i32.load(4, 4, m.i32.and(get(argsSlot), m.i32.const(~3)));
          const elem = (i) => m.i32.load(4 + i * 4, 4, m.i32.load(8, 4, m.i32.and(get(argsSlot), m.i32.const(~3)))); // backing[i]
          // Uniform arity: pass exactly `maxargs` args — backing[j] while in range,
          // undefined past the spread's length. (No function binds beyond maxargs.)
          const args = [get(closeSlot)];
          for (let j = 0; j < maxargs; j++) args.push(m.select(m.i32.gt_s(len(), m.i32.const(j)), elem(j), m.i32.const(UNDEF)));
          stmts.push(...setArgc(len()));                                              // actual count = the spread array's length
          stmts.push(m.local.set(scratch(h), m.call_indirect("0", fn, args, callType(), I32))); h++; break;
        }
        case "GENNEXT": {                      // [gen, sentValue] -> [{value, done}]; drive the generator one step
          h -= 2; stmts.push(m.local.set(scratch(h), m.call("__gennext", [get(scratch(h)), get(scratch(h + 1))], I32))); h++; break;
        }
        case "GENRET": {                       // [gen, value] -> [{value, done:true}]; runs enclosing finally(s); a throw escaping one propagates (CALL_OPS)
          h -= 2; stmts.push(m.local.set(scratch(h), m.call("__genret", [get(scratch(h)), get(scratch(h + 1))], I32))); h++; break;
        }
        case "GENTHROW": {                     // [gen, value] -> [{value, done}]; throw into the generator at its paused yield
          h -= 2; stmts.push(m.local.set(scratch(h), m.call("__genthrow", [get(scratch(h)), get(scratch(h + 1))], I32))); h++; break;
        }
        case "INDEX": { h -= 2; stmts.push(m.local.set(scratch(h), m.call("__index", [get(scratch(h)), get(scratch(h + 1))], I32))); h++; break; } // recv[key]
        case "SETINDEX": { h -= 3; stmts.push(m.drop(m.call("__setindex", [get(scratch(h)), get(scratch(h + 1)), get(scratch(h + 2))], I32))); break; } // recv[key] = value
        case "NEWOBJ": stmts.push(m.local.set(scratch(h), m.call("__newobj", [], I32))); h++; break;
        case "CTORG": {                        // new Map(...) / new Set(...) / new RegExp(src, flags)
          const cn = ins[1], n = ins[2] || 0; h -= n;
          if (cn === "RegExp") {               // build [REGEXTAG, sourceStr, flagsStr] from runtime string args (host matches it)
            if (n < 2) stmts.push(...buildStrInto(scratch(h + 1), "")); // no flags -> ""
            const B = () => m.i32.load(0, 4, m.i32.const(BUMP_ADDR));
            stmts.push(m.i32.store(0, 4, B(), m.i32.const(REGEXTAG)), m.i32.store(4, 4, B(), get(scratch(h))), m.i32.store(8, 4, B(), get(scratch(h + 1))));
            stmts.push(m.i32.store(0, 4, m.i32.const(BUMP_ADDR), m.i32.add(B(), m.i32.const(12))));
            stmts.push(m.local.set(scratch(h), m.i32.or(m.i32.sub(B(), m.i32.const(12)), m.i32.const(1)))); h++; break;
          }
          const ctor = cn === "Map" ? "__newmap" : cn === "Set" ? "__newset" : null;
          if (!ctor) throw new Error("aot: unsupported constructor " + cn);
          stmts.push(m.local.set(scratch(h + n), m.call(ctor, [], I32)));                                  // build above the args
          if (n >= 1) stmts.push(m.local.set(scratch(h + n), m.call(cn === "Map" ? "__mapinit" : "__setinit", [get(scratch(h + n)), get(scratch(h))], I32)));
          stmts.push(m.local.set(scratch(h), get(scratch(h + n)))); h++; break;
        }
        case "GETPROP": {                      // [obj] -> [obj.key]; key interned to an id
          const v = m.call("__getprop", [get(scratch(h - 1)), m.i32.const(keyIds.get(ins[1]))], I32);
          stmts.push(m.local.set(scratch(h - 1), v)); break;
        }
        case "SETPROP": case "SETHIDDEN": {    // [obj, val] -> [obj]; obj.key = val. SETHIDDEN marks the pair non-enumerable (HIDDEN_FLAG) — per object, not per key id.
          h -= 2; const kid = ins[0] === "SETHIDDEN" ? keyIds.get(ins[1]) | HIDDEN_FLAG : keyIds.get(ins[1]);
          const r = m.call("__setprop", [get(scratch(h)), m.i32.const(kid), get(scratch(h + 1))], I32);
          stmts.push(m.local.set(scratch(h), r)); h++; break;
        }
        case "GETPROPA": {                     // accessor-aware read: fire a getter if obj.__accessors__[key].get exists
          const v = m.call("__getpropa", [get(scratch(h - 1)), m.i32.const(keyIds.get(ins[1])), m.i32.const(keyIds.get("__accessors__")), m.i32.const(keyIds.get("get"))], I32);
          stmts.push(m.local.set(scratch(h - 1), v)); break;
        }
        case "SETPROPA": {                     // accessor-aware write: fire a setter if obj.__accessors__[key].set exists
          h -= 2; const r = m.call("__setpropa", [get(scratch(h)), m.i32.const(keyIds.get(ins[1])), get(scratch(h + 1)), m.i32.const(keyIds.get("__accessors__")), m.i32.const(keyIds.get("set"))], I32);
          stmts.push(m.local.set(scratch(h), r)); h++; break;
        }
        case "CALLMETHOD": {                   // recv.name(args): the method closure captured `this`, so call it with env = the method
          const mname = ins[1], argc = ins[2]; h -= argc + 1;  // stack: [recv, arg0..arg_{argc-1}]
          const a = (k) => get(scratch(h + 1 + k));
          // Closure dispatch (the general path): recv[name] is a method closure.
          const closureCall = () => {
            const args = [get(scratch(h))]; for (let k = 0; k < argc; k++) args.push(a(k));
            return m.block(null, [
              m.local.set(scratch(h), m.call("__getprop", [get(scratch(h)), m.i32.const(keyIds.get(mname))], I32)),   // recv -> method closure (recv read first)
              ...setArgc(m.i32.const(argc)),
              m.local.set(scratch(h), m.call_indirect("0", m.i32.load(4, 4, m.i32.and(get(scratch(h)), m.i32.const(~3))), padTo(args), callType(), I32)),
            ], binaryen.none);
          };
          // Map/Set native methods are tag-dispatched at runtime (a regular object can
          // share a method name, so the general path stays the fallback).
          const MAPSET = { set: 1, get: 1, has: 1, add: 1, keys: 1, values: 1, entries: 1 };
          if (mapSet && MAPSET[mname]) {
            const tag = () => m.i32.load(0, 4, m.i32.and(get(scratch(h)), m.i32.const(0xfffc)));
            const isMap = () => m.i32.eq(tag(), m.i32.const(MAPTAG));
            const r = get(scratch(h));
            const native = mname === "set" ? m.call("__mapset", [r, a(0), a(1)], I32)
              : mname === "get" ? m.call("__mapget", [r, a(0)], I32)
              : mname === "add" ? m.call("__setadd", [r, a(0)], I32)
              : mname === "entries" ? m.call("__mapiter", [r, m.i32.const(1)], I32)
              : mname === "has" ? m.call("__collhas", [r, a(0)], I32)
              : mname === "keys" ? m.select(isMap(), m.call("__mapiter", [get(scratch(h)), m.i32.const(2)], I32), m.call("__iter", [get(scratch(h))], I32))   // Set.keys() = a values iterator
              : m.select(isMap(), m.call("__mapiter", [get(scratch(h)), m.i32.const(3)], I32), m.call("__iter", [get(scratch(h))], I32)); // values
            const isColl = m.i32.and(m.i32.eq(m.i32.and(get(scratch(h)), m.i32.const(3)), m.i32.const(1)), m.i32.or(isMap(), m.i32.eq(tag(), m.i32.const(SETTAG))));
            stmts.push(m.if(isColl, m.local.set(scratch(h), native), closureCall()));
          } else {
            stmts.push(closureCall());
          }
          h++; break;
        }
        case "ISARRAY": stmts.push(m.local.set(scratch(h - 1), bool(isArr(scratch(h - 1))))); break; // Array.isArray, lowered by the HOF inliner
        case "TOBIG": stmts.push(m.local.set(scratch(h - 1), m.call("__big_from", [get(scratch(h - 1))], I32))); break; // BigInt(intValue) -> host BigInt
        case "GLOBAL": stmts.push(m.local.set(scratch(h), m.i32.const(UNDEF))); h++; break;          // stdlib namespace (Math/Number/Array): a placeholder receiver — CALLM/CALLMS dispatch on the static method name
        case "CALLM": {                        // host method on a stdlib namespace: dispatch at compile time on the method name (the receiver is the GLOBAL placeholder)
          const mname = ins[1], n = ins[2]; h -= n + 1;       // stack: [recv, arg0..arg_{n-1}]
          const a = (k) => get(scratch(h + 1 + k));           // k-th argument (a fresh node each call)
          if (mname === "max" || mname === "min") {           // variadic fold; accumulate in the now-free receiver slot
            const cmp = mname === "max" ? (x, y) => m.i32.gt_s(x, y) : (x, y) => m.i32.lt_s(x, y);
            stmts.push(m.local.set(scratch(h), a(0)));
            for (let k = 1; k < n; k++) stmts.push(m.local.set(scratch(h), m.select(cmp(a(k), get(scratch(h))), a(k), get(scratch(h)))));
            h++; break;
          }
          const F64 = binaryen.f64, numf = (e) => m.call("__numf", [e], F64), boxf = (e) => m.call("__boxf", [e], I32);
          let res;
          if (floats && (mname === "abs" || mname === "floor" || mname === "ceil" || mname === "round" || mname === "trunc")) { // float-aware Math (a fixnum round-trips to itself)
            const f = mname === "abs" ? m.f64.abs(numf(a(0))) : mname === "floor" ? m.f64.floor(numf(a(0))) : mname === "ceil" ? m.f64.ceil(numf(a(0)))
              : mname === "round" ? m.f64.floor(m.f64.add(numf(a(0)), m.f64.const(0.5))) : m.f64.trunc(numf(a(0))); // round = floor(x + 0.5) (JS, not banker's)
            stmts.push(m.local.set(scratch(h), boxf(f))); h++; break;
          }
          switch (mname) {
            case "abs": res = m.select(m.i32.lt_s(a(0), m.i32.const(0)), m.i32.sub(m.i32.const(0), a(0)), a(0)); break; // |n<<1| = (|n|)<<1
            case "floor": case "ceil": case "round": case "trunc": res = a(0); break;                  // integer-valued model: identity
            case "sign": res = m.select(m.i32.lt_s(a(0), m.i32.const(0)), m.i32.const(immediate(-1)), m.select(m.i32.eqz(a(0)), m.i32.const(immediate(0)), m.i32.const(immediate(1)))); break;
            case "isInteger": res = floats ? m.call("__isintf", [a(0)], I32) : bool(m.i32.eqz(m.i32.and(a(0), m.i32.const(1)))); break; // a fixnum is integer; a boxed float iff whole
            case "isFinite": res = bool(m.i32.eqz(m.i32.and(a(0), m.i32.const(1)))); break; // a tagged int has low bit 0
            case "isNaN": res = m.i32.const(FALSE); break;                                              // no NaN in this model
            case "isArray": res = bool(isArr(scratch(h + 1))); break;
            // ---- string / array instance methods (receiver = scratch(h)) ----
            case "toUpperCase": res = m.call("__strupper", [get(scratch(h))], I32); break;
            case "toLowerCase": res = m.call("__strlower", [get(scratch(h))], I32); break;
            case "trim": res = m.call("__strtrim", [get(scratch(h))], I32); break;
            case "split": res = m.call("__strsplit", [get(scratch(h)), a(0)], I32); break;
            case "charCodeAt": res = m.call("__strcharcodeat", [get(scratch(h)), n >= 1 ? a(0) : m.i32.const(0)], I32); break;
            case "charAt": res = m.call("__strcharat", [get(scratch(h)), n >= 1 ? a(0) : m.i32.const(0)], I32); break;
            case "slice": res = m.call("__slice", [get(scratch(h)), a(0), n >= 2 ? a(1) : m.i32.shl(m.i32.load(4, 4, m.i32.and(get(scratch(h)), m.i32.const(~3))), m.i32.const(1))], I32); break; // default end = length
            case "from": res = m.call("__arrayfrom", [a(0)], I32); break;                               // Array.from(arg0)
            case "flat": res = m.call("__arrflat", [get(scratch(h))], I32); break;                      // one-level flatten
            case "toString": res = bigs ? m.if(isBigE(() => get(scratch(h))), m.call("__big_str", [get(scratch(h))], I32), m.call("__tostr", [get(scratch(h))], I32)) : m.call("__tostr", [get(scratch(h))], I32); break; // bigint -> host base-10, else number -> string
            case "test": res = m.call("__re_test", [get(scratch(h)), a(0)], I32); break;                 // /re/.test(s): receiver is the regex, arg the string — delegated to the host RegExp
            case "match": res = m.call("__re_match", [a(0), get(scratch(h))], I32); break;              // s.match(/re/): receiver the string, arg the regex
            case "replace": res = m.call("__re_replace", [a(0), get(scratch(h)), a(1), m.i32.and(m.i32.eq(m.i32.and(a(1), m.i32.const(3)), m.i32.const(1)), m.i32.eq(m.i32.load(0, 4, m.i32.and(a(1), m.i32.const(0xfffc))), m.i32.const(CLOSTAG)))], I32); break; // s.replace(/re/, str|fn); the host calls back through the table for a fn
            case "join": {
              let sep; if (n >= 1) sep = a(0); else { stmts.push(...buildStrInto(scratch(h + 1), ",")); sep = get(scratch(h + 1)); } // default separator ","
              res = m.call("__arrjoin", [get(scratch(h)), sep], I32); break;
            }
            case "parse": { if (n !== 1) throw new Error("aot: JSON.parse with a reviver not supported"); res = m.call("__json_parse", [a(0)], I32); break; } // JSON.parse(str): the host parses and rebuilds the value tree via the runtime's own constructors (interpreter handles a reviver)
            case "values": res = m.call("__values", [a(0)], I32); break;                       // Object.values(obj) -> array of own enumerable values
            case "assign": { for (let k = 1; k < n; k++) stmts.push(m.drop(m.call("__assignall", [a(0), a(k)], I32))); res = a(0); break; } // Object.assign(target, ...sources) -> target
            default: throw new Error("aot: unsupported host method " + mname);
          }
          stmts.push(m.local.set(scratch(h), res)); h++; break;
        }
        case "CALLMS": {                       // host method with spread args: [recv, argsArray] -> result (Math.max(...a) / Math.min(...a))
          h -= 2; const fn = ins[1] === "max" ? "__maxarr" : ins[1] === "min" ? "__minarr" : null;
          if (!fn) throw new Error("aot: unsupported spread host method " + ins[1]);
          stmts.push(m.local.set(scratch(h), m.call(fn, [get(scratch(h + 1))], I32))); h++; break;
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
        case "ARGUMENTS": {                    // `arguments`: an array of the actually-passed args (params 1..argc-1), count from ARGC_ADDR
          stmts.push(m.local.set(scratch(h), m.call("__newarr", [], I32)));
          for (let k = 0; k < maxargs; k++) stmts.push(m.if(m.i32.gt_s(m.i32.load(0, 4, m.i32.const(ARGC_ADDR)), m.i32.const(k)), m.drop(m.call("__arrpush", [get(scratch(h)), get(1 + k)], I32))));
          h++; break;
        }
        case "GATHERREST": {                   // rest param at arg index r: locals[r] = [arg_r, arg_{r+1}, ...] (the actual extra args)
          const r = ins[1];
          stmts.push(m.local.set(scratch(h), m.call("__newarr", [], I32)));
          for (let k = r; k < maxargs; k++) stmts.push(m.if(m.i32.gt_s(m.i32.load(0, 4, m.i32.const(ARGC_ADDR)), m.i32.const(k)), m.drop(m.call("__arrpush", [get(scratch(h)), get(1 + k)], I32))));
          stmts.push(m.local.set(loc(r), get(scratch(h)))); break; // install the rest array as the rest local
        }
        case "NEWARR": stmts.push(m.local.set(scratch(h), m.call("__newarr", [], I32))); h++; break;
        case "ARRPUSH": { h -= 2; stmts.push(m.drop(m.call("__arrpush", [get(scratch(h)), get(scratch(h + 1))], I32))); break; } // arr.push(v)
        case "APPENDALL": { h -= 1; stmts.push(m.drop(m.call("__appendall", [get(scratch(h - 1)), get(scratch(h))], I32))); break; } // [...src]: spread src into the array below it
        case "DELPROP": stmts.push(m.local.set(scratch(h - 1), m.call("__delprop", [get(scratch(h - 1)), m.i32.const(keyIds.get(ins[1]))], I32))); break; // delete obj.key -> true
        case "KEYS": stmts.push(m.local.set(scratch(h - 1), m.call("__keys", [get(scratch(h - 1))], I32))); break; // Object.keys / for-in: array of own enumerable string keys
        case "JSONSTR": { h -= 3; stmts.push(m.local.set(scratch(h), m.call("__jsonstr", [get(scratch(h))], I32))); h++; break; } // [val, replacer, space] -> JSON string (replacer/space ignored)
        case "TOARRAY": stmts.push(m.local.set(scratch(h - 1), m.call("__toarray", [get(scratch(h - 1))], I32))); break; // array destructuring: materialize the iterable (identity for arrays)
        case "ASSIGNALL": { stmts.push(m.drop(m.call("__assignall", [get(scratch(h - 2)), get(scratch(h - 1))], I32))); h -= 1; break; } // {...src}: copy src's pairs into the target below it
        case "ARRGET": { h -= 2; const backing = m.i32.load(8, 4, m.i32.and(get(scratch(h)), m.i32.const(~3))); const idx = m.i32.shr_s(get(scratch(h + 1)), m.i32.const(1));
          stmts.push(m.local.set(scratch(h), m.i32.load(4, 4, m.i32.add(backing, m.i32.mul(idx, m.i32.const(4)))))); h++; break; } // arr[idx] = backing[idx]
        case "ARRLEN": stmts.push(m.local.set(scratch(h - 1), m.i32.shl(m.i32.load(4, 4, m.i32.and(get(scratch(h - 1)), m.i32.const(~3))), m.i32.const(1)))); break; // tagInt(length)
        case "NEG": {                          // -(n<<1) = (-n)<<1; a float/string coerces; a bigint negates on the host
          const v = () => get(scratch(h - 1));
          const nonBig = floats ? m.if(m.i32.eqz(m.i32.and(v(), m.i32.const(1))), m.i32.sub(m.i32.const(0), v()), m.call("__negf", [v()], I32)) : m.i32.sub(m.i32.const(0), v());
          stmts.push(m.local.set(scratch(h - 1), bigs ? m.if(isBigE(v), m.call("__big_bin", [m.i32.const(BIGOPS.neg), v(), v()], I32), nonBig) : nonBig)); break;
        }
        case "INC": stmts.push(m.local.set(scratch(h - 1), bigs ? m.if(isBigE(() => get(scratch(h - 1))), m.call("__big_bin", [m.i32.const(BIGOPS.inc), get(scratch(h - 1)), get(scratch(h - 1))], I32), m.i32.add(get(scratch(h - 1)), m.i32.const(2))) : m.i32.add(get(scratch(h - 1)), m.i32.const(2)))); break; // ++ : tagged +1 (or +1n on the host)
        case "DEC": stmts.push(m.local.set(scratch(h - 1), m.i32.sub(get(scratch(h - 1)), m.i32.const(2)))); break; // -- : tagged -1
        case "NOT": stmts.push(m.local.set(scratch(h - 1), bool(falsy(scratch(h - 1))))); break; // !x : true iff x is falsy
        case "BITNOT": stmts.push(m.local.set(scratch(h - 1), m.i32.sub(m.i32.const(-2), get(scratch(h - 1))))); break; // ~(2n) = 2(~n) = -2 - 2n
        case "CALLG": {                        // a bare callable global: Number/String/Boolean coercion (in-module), parseInt/parseFloat (host parsing), isNaN/isFinite
          const gname = ins[1], gc = ins[2] || 0; h -= gc;
          const ga = (k) => get(scratch(h + k));
          const F64 = binaryen.f64, numf = (e) => m.call("__numf", [e], F64), Inf = m.f64.const(Infinity);
          let res;
          if (gname === "Number") res = m.call("__boxf", [numf(ga(0))], I32);
          else if (gname === "String") res = m.call("__tostr", [ga(0)], I32);
          else if (gname === "Boolean") { const tg = (off) => m.i32.load(off, 4, m.i32.and(ga(0), m.i32.const(0xfffc))); const emptyStr = m.i32.and(m.i32.eq(m.i32.and(ga(0), m.i32.const(3)), m.i32.const(1)), m.i32.and(m.i32.eq(tg(0), m.i32.const(STRTAG)), m.i32.eqz(tg(4)))); res = m.select(m.i32.or(falsy(scratch(h)), emptyStr), m.i32.const(FALSE), m.i32.const(TRUE)); } // false iff falsy or an empty string
          else if (gname === "parseInt") res = m.call("__parse_int", [ga(0), gc >= 2 ? ga(1) : m.i32.const(0)], I32);
          else if (gname === "parseFloat") res = m.call("__parse_float", [ga(0)], I32);
          else if (gname === "isNaN") res = m.select(m.f64.ne(numf(ga(0)), numf(ga(0))), m.i32.const(TRUE), m.i32.const(FALSE)); // NaN !== NaN
          else if (gname === "isFinite") res = m.select(m.i32.and(m.f64.eq(numf(ga(0)), numf(ga(0))), m.f64.lt(m.f64.abs(numf(ga(0))), Inf)), m.i32.const(TRUE), m.i32.const(FALSE));
          else throw new Error("aot: unsupported global call " + gname);
          stmts.push(m.local.set(scratch(h), res)); h++; break;
        }
        case "PUSHTRY": case "POPTRY": break;  // handler scope is resolved at compile time (blockHeights); no runtime code
        case "THROW": h--; term = { kind: "throw", handler: blockHandler[bi], value: scratch(h) }; break;
        case "JMP": term = { kind: "jmp", target: ins[1] }; break;
        case "JMPF": h--; term = { kind: "jmpf", target: ins[1], cond: scratch(h), next: end }; break;
        case "RET": h--; result = get(scratch(h)); term = { kind: "ret" }; break;
        default: throw new Error("aot: unsupported opcode " + ins[0]);
      }
    }
    // A call ends a block (under exceptions): the next block checks the flag.
    if (exceptions && CALL_OPS.has(code[end - 1][0])) term = { kind: "callcheck", handler: blockHandler[bi], next: end };
    // Body: a RET returns its value; a no-handler THROW/exception unwinds (set the
    // flag / return); everything else falls through to its branches.
    let tail = [];
    if (term.kind === "ret") tail = [m.return(result)];
    else if (term.kind === "throw" && !term.handler) tail = [...raise(term.value), propagate()];
    else if (term.kind === "callcheck" && !term.handler) tail = [m.if(excFlag(), propagate())];
    const ref = r.addBlock(m.block(null, [...stmts, ...tail], binaryen.none));
    refOf.set(start, ref);
    blocks.push({ ref, term });
  }

  for (const { ref, term } of blocks) {
    if (term.kind === "ret") continue;
    if (term.kind === "throw") {                                                  // a local handler: the value is already at scratch(sp); just branch to the catch
      if (term.handler) r.addBranch(ref, refOf.get(term.handler.catch), 0, 0);    // no handler: the body already raised + returned
      continue;
    }
    if (term.kind === "callcheck") {
      if (term.handler) r.addBranch(ref, refOf.get(term.handler.catch), excFlag(), catchInto(term.handler.sp)); // exception -> catch (value onto the stack, clear flag)
      r.addBranch(ref, refOf.get(term.next), 0, 0);                               // else (or no handler: body returned on exception) fall through
      continue;
    }
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
  const varTypes = new Array((nl - argc) + maxH + 1).fill(I32);               // non-arg IR locals + scratch + label helper (the args live in the P param slots)
  m.addFunction(name, callType(), I32, varTypes, body);                      // uniform signature: env + maxargs
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
function addObjectRuntime(m, lenId, sizeId) {
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
    m.local.set(2, m.i32.and(g(0), c(~3))),
    // Arrays and strings expose .length, Maps and Sets expose .size — all the count
    // word at offset 4. Any other key on them reads undefined. Objects fall through.
    m.if(m.i32.or(m.i32.eq(ld(0, g(2)), c(ARRTAG)), m.i32.eq(ld(0, g(2)), c(STRTAG))),
      m.return(m.select(m.i32.eq(g(1), c(lenId)), m.i32.shl(ld(4, g(2)), c(1)), c(UNDEF)))),
    m.if(m.i32.or(m.i32.eq(ld(0, g(2)), c(MAPTAG)), m.i32.eq(ld(0, g(2)), c(SETTAG))),
      m.return(m.select(m.i32.eq(g(1), c(sizeId)), m.i32.shl(ld(4, g(2)), c(1)), c(UNDEF)))),
    m.local.set(3, ld(8, g(2))), m.local.set(4, ld(4, g(2))), m.local.set(5, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_u(g(5), g(4)), m.return(c(UNDEF))),            // i >= count -> undefined (missing key)
      m.if(m.i32.eq(m.i32.and(ld(4, pair(3, 5)), c(~HIDDEN_FLAG)), m.i32.and(g(1), c(~HIDDEN_FLAG))), m.return(ld(8, pair(3, 5)))), // key match (ignoring the hidden flag) -> value
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
        m.if(m.i32.eq(m.i32.and(ld(4, pair(4, 6)), c(~HIDDEN_FLAG)), m.i32.and(g(1), c(~HIDDEN_FLAG))), m.block(null, [st(8, pair(4, 6), g(2)), m.return(g(0))])), // overwrite in place (key match ignores the hidden flag; the stored flag is kept)
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

  // __delprop(obj, key) -> TRUE.  delete obj.key: find the pair, shift the rest
  // down (pairs are contiguous from backing+4), decrement count. params 0=obj,
  // 1=key; locals 2=addr,3=backing,4=count,5=i
  m.addFunction("__delprop", binaryen.createType([I32, I32]), I32, [I32, I32, I32, I32], m.block(null, [
    m.local.set(2, m.i32.and(g(0), c(~3))), m.local.set(3, ld(8, g(2))), m.local.set(4, ld(4, g(2))), m.local.set(5, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_u(g(5), g(4)), m.return(c(TRUE))),             // not found -> delete of a missing key is still true
      m.if(m.i32.eq(m.i32.and(ld(4, pair(3, 5)), c(~HIDDEN_FLAG)), m.i32.and(g(1), c(~HIDDEN_FLAG))), m.block(null, [
        m.memory.copy(m.i32.add(pair(3, 5), c(4)), m.i32.add(pair(3, 5), c(12)), m.i32.mul(m.i32.sub(m.i32.sub(g(4), g(5)), c(1)), c(8))), // shift pairs i+1.. (8 bytes earlier) onto i
        st(4, g(2), m.i32.sub(g(4), c(1))),                        // count--
        m.return(c(TRUE)),
      ])),
      m.local.set(5, m.i32.add(g(5), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ], binaryen.none));
}

// Runtime for Object.keys / for-in (added when a program uses KEYS). Object keys
// are interned ids, so __keystr maps an id back to its string; the static map covers
// enumerable keys (those never set via SETHIDDEN — __class__, instance methods,
// __accessors__ are non-enumerable), so a hidden key resolves to 0 and is skipped.
// `enumerable` is [[string, id], ...]. A dynamically-interned key (a computed
// obj[k]=v, or a JSON.parse key) gets an id above the static range and is always an
// enumerable data key; when the interner's pool exists (hasPool), recover its string
// directly from the pool slot (id-1), so for-in / Object.keys / re-stringify see it.
// __keystr(id) -> the key's interned string, or 0 for a non-enumerable/unknown id.
// Shared by KEYS and JSON.stringify (both enumerate only the same data keys).
function addKeyStr(m, enumerable, staticMax, hasPool) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const st = (off, p, v) => m.i32.store(off, 4, p, v);
  const bump = () => m.i32.load(0, 4, c(BUMP_ADDR));
  const retStr = (s) => {                                                  // build [STRTAG, len, ...bytes], return it tagged
    const out = [m.local.set(1, bump()), st(0, g(1), c(STRTAG)), st(4, g(1), c(s.length))];
    for (let k = 0; k < s.length; k++) out.push(m.i32.store8(8 + k, 1, g(1), c(s.charCodeAt(k))));
    out.push(m.i32.store(0, 4, c(BUMP_ADDR), m.i32.add(g(1), c(8 + ((s.length + 3) & ~3)))), m.return(m.i32.or(g(1), c(1))));
    return m.block(null, out, binaryen.none);
  };
  m.addFunction("__keystr", binaryen.createType([I32]), I32, [I32], m.block(null, [
    ...enumerable.map(([s, id]) => m.if(m.i32.eq(g(0), c(id)), retStr(s))),
    ...(hasPool ? [m.if(m.i32.gt_s(g(0), c(staticMax)),                    // a dynamic key: pool slot (id-1) holds [stringPtr, id]
      m.return(m.i32.load(0, 4, m.i32.add(m.global.get("__keypool", I32), m.i32.mul(m.i32.sub(g(0), c(1)), c(8))))))] : []),
    m.return(c(0)),
  ], binaryen.none));
}

function addKeysRuntime(m) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  // __keys(o) -> array of o's own enumerable string keys, in insertion order.
  // params 0=o; locals 1=out,2=backing,3=count,4=i,5=s
  m.addFunction("__keys", binaryen.createType([I32]), I32, [I32, I32, I32, I32, I32], m.block(null, [
    m.local.set(1, m.call("__newarr", [], I32)), m.local.set(2, ld(8, m.i32.and(g(0), c(~3)))), m.local.set(3, ld(4, m.i32.and(g(0), c(~3)))), m.local.set(4, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_u(g(4), g(3)), m.return(g(1))),
      m.if(m.i32.eqz(m.i32.and(ld(4, m.i32.add(g(2), m.i32.mul(g(4), c(8)))), c(HIDDEN_FLAG))), m.block(null, [ // enumerable pair (HIDDEN_FLAG clear)?
        m.local.set(5, m.call("__keystr", [m.i32.and(ld(4, m.i32.add(g(2), m.i32.mul(g(4), c(8)))), c(~HIDDEN_FLAG))], I32)), // key id -> string
        m.if(m.i32.ne(g(5), c(0)), m.drop(m.call("__arrpush", [g(1), g(5)], I32))),
      ], binaryen.none)),
      m.local.set(4, m.i32.add(g(4), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ], binaryen.none));
}

// __values(o) -> array of o's own enumerable values (Object.values), in insertion order.
// Like __keys but pushes the value (pair i value at backing + 8i + 8) for each key the
// enumerable table accepts. params 0=o; locals 1=out,2=backing,3=count,4=i.
function addValuesRuntime(m) {
  const I32 = binaryen.i32, g = (i) => m.local.get(i, I32), c = (n) => m.i32.const(n), ld = (off, p) => m.i32.load(off, 4, p);
  m.addFunction("__values", binaryen.createType([I32]), I32, [I32, I32, I32, I32], m.block(null, [
    m.local.set(1, m.call("__newarr", [], I32)), m.local.set(2, ld(8, m.i32.and(g(0), c(~3)))), m.local.set(3, ld(4, m.i32.and(g(0), c(~3)))), m.local.set(4, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_u(g(4), g(3)), m.return(g(1))),
      m.if(m.i32.eqz(m.i32.and(ld(4, m.i32.add(g(2), m.i32.mul(g(4), c(8)))), c(HIDDEN_FLAG))),       // enumerable pair?
        m.drop(m.call("__arrpush", [g(1), ld(8, m.i32.add(g(2), m.i32.mul(g(4), c(8))))], I32))),    // push the value
      m.local.set(4, m.i32.add(g(4), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ], binaryen.none));
}

// Runtime for JSON.stringify (added when a program uses JSONSTR). Recursively
// serializes the tagged value model: numbers, quoted/escaped strings, booleans,
// null, arrays, and objects (enumerable keys only, via __keystr — functions and
// hidden keys are dropped, matching JS). Replacer/space are ignored.
function addJsonRuntime(m) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const ld8 = (off, p) => m.i32.load8_u(off, 1, p);
  const addr = (i) => m.i32.and(g(i), c(~3));
  const bump = () => m.i32.load(0, 4, c(BUMP_ADDR));
  const setBump = (v) => m.i32.store(0, 4, c(BUMP_ADDR), v);
  const cc = (a, b) => m.call("__concat", [a, b], I32);
  // Build a fixed string literal inline (bump-only, no locals): store [STRTAG, len,
  // ...bytes], advance bump, return the old pointer tagged.
  const lit = (s) => {
    const size = 8 + ((s.length + 3) & ~3);
    const out = [m.i32.store(0, 4, bump(), c(STRTAG)), m.i32.store(4, 4, bump(), c(s.length))];
    for (let k = 0; k < s.length; k++) out.push(m.i32.store8(8 + k, 1, bump(), c(s.charCodeAt(k))));
    out.push(setBump(m.i32.add(bump(), c(size))), m.i32.or(m.i32.sub(bump(), c(size)), c(1)));
    return m.block(null, out, I32);
  };
  // __jsonquote(s) -> '"' + s with " and \ backslash-escaped + '"'. params 0=s;
  // locals 1=in,2=len,3=extra,4=i,5=b,6=out,7=j
  m.addFunction("__jsonquote", binaryen.createType([I32]), I32, [I32, I32, I32, I32, I32, I32, I32], m.block(null, [
    m.local.set(1, addr(0)), m.local.set(2, ld(4, g(1))), m.local.set(3, c(0)), m.local.set(4, c(0)),
    m.loop("C", m.block(null, [m.if(m.i32.lt_u(g(4), g(2)), m.block(null, [   // count chars needing an escape
      m.local.set(5, ld8(8, m.i32.add(g(1), g(4)))),
      m.if(m.i32.or(m.i32.eq(g(5), c(34)), m.i32.eq(g(5), c(92))), m.local.set(3, m.i32.add(g(3), c(1)))),
      m.local.set(4, m.i32.add(g(4), c(1))), m.br("C"),
    ]))])),
    m.local.set(6, bump()), m.i32.store(0, 4, g(6), c(STRTAG)), m.i32.store(4, 4, g(6), m.i32.add(m.i32.add(g(2), g(3)), c(2))),
    setBump(m.i32.add(g(6), m.i32.add(c(8), m.i32.and(m.i32.add(m.i32.add(m.i32.add(g(2), g(3)), c(2)), c(3)), c(~3))))),
    m.i32.store8(8, 1, g(6), c(34)), m.local.set(7, c(1)), m.local.set(4, c(0)),  // opening quote, j=1
    m.loop("F", m.block(null, [m.if(m.i32.lt_u(g(4), g(2)), m.block(null, [
      m.local.set(5, ld8(8, m.i32.add(g(1), g(4)))),
      m.if(m.i32.or(m.i32.eq(g(5), c(34)), m.i32.eq(g(5), c(92))), m.block(null, [m.i32.store8(8, 1, m.i32.add(g(6), g(7)), c(92)), m.local.set(7, m.i32.add(g(7), c(1)))])), // escaping backslash
      m.i32.store8(8, 1, m.i32.add(g(6), g(7)), g(5)), m.local.set(7, m.i32.add(g(7), c(1))),
      m.local.set(4, m.i32.add(g(4), c(1))), m.br("F"),
    ]))])),
    m.i32.store8(8, 1, m.i32.add(g(6), g(7)), c(34)),                          // closing quote
    m.return(m.i32.or(g(6), c(1))),
  ], binaryen.none));
  // __jsonstr(v) -> JSON string. params 0=v; locals 1=addr,2=out,3=backing,4=count,5=i,6=ks,7=wrote
  m.addFunction("__jsonstr", binaryen.createType([I32]), I32, [I32, I32, I32, I32, I32, I32, I32], m.block(null, [
    m.if(m.i32.eq(g(0), c(UNDEF)), m.return(c(UNDEF))),                        // JSON.stringify(undefined) === undefined
    m.if(m.i32.eq(g(0), c(NULL)), m.return(lit("null"))),
    m.if(m.i32.eq(g(0), c(TRUE)), m.return(lit("true"))),
    m.if(m.i32.eq(g(0), c(FALSE)), m.return(lit("false"))),
    m.if(m.i32.eqz(m.i32.and(g(0), c(1))), m.return(m.call("__numstr", [g(0)], I32))), // fixnum
    m.local.set(1, addr(0)),
    m.if(m.i32.eq(ld(0, g(1)), c(STRTAG)), m.return(m.call("__jsonquote", [g(0)], I32))),
    m.if(m.i32.eq(ld(0, g(1)), c(ARRTAG)), m.block(null, [                     // [e0,e1,...]
      m.local.set(2, lit("[")), m.local.set(3, ld(8, g(1))), m.local.set(4, ld(4, g(1))), m.local.set(5, c(0)),
      m.loop("A", m.block(null, [
        m.if(m.i32.ge_s(g(5), g(4)), m.return(cc(g(2), lit("]")))),
        m.if(m.i32.gt_s(g(5), c(0)), m.local.set(2, cc(g(2), lit(",")))),
        m.local.set(2, cc(g(2), m.call("__jsonstr", [ld(4, m.i32.add(g(3), m.i32.mul(g(5), c(4))))], I32))),
        m.local.set(5, m.i32.add(g(5), c(1))), m.br("A"),
      ])),
    ], binaryen.none)),
    m.if(m.i32.eq(ld(0, g(1)), c(OBJTAG)), m.block(null, [                     // {"k":v,...}, enumerable keys only
      m.local.set(2, lit("{")), m.local.set(3, ld(8, g(1))), m.local.set(4, ld(4, g(1))), m.local.set(5, c(0)), m.local.set(7, c(0)),
      m.loop("O", m.block(null, [
        m.if(m.i32.ge_s(g(5), g(4)), m.return(cc(g(2), lit("}")))),
        m.local.set(6, ld(4, m.i32.add(g(3), m.i32.mul(g(5), c(8))))),         // raw stored key
        m.if(m.i32.eqz(m.i32.and(g(6), c(HIDDEN_FLAG))), m.block(null, [        // enumerable pair (HIDDEN_FLAG clear)?
          m.local.set(6, m.call("__keystr", [m.i32.and(g(6), c(~HIDDEN_FLAG))], I32)), // key id -> string or 0
          m.if(m.i32.ne(g(6), c(0)), m.block(null, [
            m.if(g(7), m.local.set(2, cc(g(2), lit(",")))),
            m.local.set(2, cc(cc(cc(g(2), m.call("__jsonquote", [g(6)], I32)), lit(":")), m.call("__jsonstr", [ld(8, m.i32.add(g(3), m.i32.mul(g(5), c(8))))], I32))),
            m.local.set(7, c(1)),
          ])),
        ], binaryen.none)),
        m.local.set(5, m.i32.add(g(5), c(1))), m.br("O"),
      ])),
    ], binaryen.none)),
    m.return(lit("null")),                                                    // closures / class objects -> null (JS drops functions)
  ], binaryen.none));
}

// Runtime for Promise.reject and awaiting a rejection (added when a program uses
// MKREJECT). In this synchronous model a resolved promise is just its value, so
// only a rejection is reified — a [REJTAG, value] cell — and awaiting it raises
// the value through the exception protocol (EXC_FLAG/EXC_VALUE at ctrl 0/4).
function addPromiseRuntime(m) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const st = (off, p, v) => m.i32.store(off, 4, p, v);
  const bump = () => m.i32.load(0, 4, c(BUMP_ADDR));
  const isRej = (i) => m.i32.and(m.i32.eq(m.i32.and(g(i), c(3)), c(1)), m.i32.eq(ld(0, m.i32.and(g(i), c(0xfffc))), c(REJTAG))); // a pointer to [REJTAG, ...]?
  const raise = (valExpr) => [st(EXC_VALUE, c(0), valExpr), st(EXC_FLAG, c(0), c(1)), m.return(c(0))]; // set the pending exception, return a dummy

  // __mkreject(v) -> [REJTAG, v] tagged.  local 1 = cell
  m.addFunction("__mkreject", binaryen.createType([I32]), I32, [I32], m.block(null, [
    m.local.set(1, bump()), st(0, g(1), c(REJTAG)), st(4, g(1), g(0)), m.i32.store(0, 4, c(BUMP_ADDR), m.i32.add(g(1), c(8))),
    m.return(m.i32.or(g(1), c(1))),
  ], binaryen.none));

  // __awaitchk(v) -> v, or raise its value if v is a rejection.
  m.addFunction("__awaitchk", binaryen.createType([I32]), I32, [I32], m.block(null, [
    m.if(isRej(0), m.block(null, raise(ld(4, m.i32.and(g(0), c(~3)))), binaryen.none)),
    m.return(g(0)),
  ], binaryen.none));

  // __awaitall(arr) -> arr, or raise the first element that is a rejection.
  // params 0=arr; locals 1=backing,2=count,3=i,4=e
  m.addFunction("__awaitall", binaryen.createType([I32]), I32, [I32, I32, I32, I32], m.block(null, [
    m.local.set(1, ld(8, m.i32.and(g(0), c(~3)))), m.local.set(2, ld(4, m.i32.and(g(0), c(~3)))), m.local.set(3, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_s(g(3), g(2)), m.return(g(0))),
      m.local.set(4, ld(4, m.i32.add(g(1), m.i32.mul(g(3), c(4))))),
      m.if(isRej(4), m.block(null, raise(ld(4, m.i32.and(g(4), c(~3)))), binaryen.none)),
      m.local.set(3, m.i32.add(g(3), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ], binaryen.none));
}

// Host-builtin runtime: the Math.max(...a)/min spread folds and the spread
// primitive APPENDALL. Each is emitted only when the program needs it.
function addBuiltinRuntime(m, { spread, append, toarray, assignall, valueId, doneId }) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const ld8 = (off, p) => m.i32.load8_u(off, 1, p);
  // Build a one-char string [STRTAG, 1, byte] from byte `i` of string `s` (avoids a
  // dependency on the string-method runtime, which may not be present).
  const charStr = (s, i) => m.block(null, [
    m.i32.store(0, 4, m.i32.load(0, 4, c(BUMP_ADDR)), c(STRTAG)),
    m.i32.store(4, 4, m.i32.load(0, 4, c(BUMP_ADDR)), c(1)),
    m.i32.store8(8, 1, m.i32.load(0, 4, c(BUMP_ADDR)), ld8(8, m.i32.add(m.i32.and(s, c(~3)), i))),
    m.i32.store(0, 4, c(BUMP_ADDR), m.i32.add(m.i32.load(0, 4, c(BUMP_ADDR)), c(12))),
    m.i32.or(m.i32.sub(m.i32.load(0, 4, c(BUMP_ADDR)), c(12)), c(1)),
  ], I32);
  // Spread folds for Math.max(...a)/Math.min(...a): reduce a backing store to its
  // extreme. An empty spread has no representable result (no ±Infinity) -> undefined.
  if (spread) {
    const elem = (i) => ld(4, m.i32.add(g(1), m.i32.mul(g(i), c(4)))); // backing[i] = [cap, ...slots]
    const fold = (name, cmp) => m.addFunction(name, binaryen.createType([I32]), I32, [I32, I32, I32, I32], m.block(null, [
      m.local.set(1, ld(8, m.i32.and(g(0), c(~3)))),   // backing
      m.local.set(2, ld(4, m.i32.and(g(0), c(~3)))),   // length
      m.if(m.i32.eqz(g(2)), m.return(c(UNDEF))),
      m.local.set(4, elem(3)),                          // best = backing[0]  (i==local3, still 0)
      m.local.set(3, c(1)),
      m.loop("L", m.block(null, [
        m.if(m.i32.ge_s(g(3), g(2)), m.return(g(4))),
        m.local.set(4, m.select(cmp(elem(3), g(4)), elem(3), g(4))),
        m.local.set(3, m.i32.add(g(3), c(1))), m.br("L"),
      ])),
      m.unreachable(),
    ], binaryen.none));
    fold("__maxarr", (x, y) => m.i32.gt_s(x, y));
    fold("__minarr", (x, y) => m.i32.lt_s(x, y));
  }
  // __appendall(tgt, src) -> tgt: spread every element of src into the array tgt.
  // Source is an array (copy the backing) or, when generators are in use, a
  // generator (drive it to exhaustion). params 0=tgt,1=src; locals 2=addr,...
  if (append) {
    const body = [
      m.local.set(2, m.i32.and(g(1), c(~3))),
      m.if(m.i32.or(m.i32.eq(ld(0, g(2)), c(ARRTAG)), m.i32.eq(ld(0, g(2)), c(SETTAG))), m.block(null, [ // array or Set: copy the stride-1 backing
        m.local.set(3, ld(8, g(2))), m.local.set(4, ld(4, g(2))), m.local.set(5, c(0)),
        m.loop("L", m.block(null, [
          m.if(m.i32.ge_s(g(5), g(4)), m.return(g(0))),
          m.drop(m.call("__arrpush", [g(0), ld(4, m.i32.add(g(3), m.i32.mul(g(5), c(4))))], I32)),
          m.local.set(5, m.i32.add(g(5), c(1))), m.br("L"),
        ])),
      ], binaryen.none)),
    ];
    if (valueId != null) body.push(                    // a generator or any iterator: drive __gennext until done
      m.if(m.i32.or(m.i32.eq(ld(0, g(2)), c(GENTAG)), m.i32.eq(ld(0, g(2)), c(ITERTAG))), m.loop("G", m.block(null, [
        m.local.set(6, m.call("__gennext", [g(1), c(UNDEF)], I32)),
        m.if(m.i32.eq(m.call("__getprop", [g(6), c(doneId)], I32), c(TRUE)), m.return(g(0))),
        m.drop(m.call("__arrpush", [g(0), m.call("__getprop", [g(6), c(valueId)], I32)], I32)),
        m.br("G"),
      ]))));
    body.push(m.return(g(0)));
    m.addFunction("__appendall", binaryen.createType([I32, I32]), I32, [I32, I32, I32, I32, I32], m.block(null, body, binaryen.none));
  }
  // __toarray(x) -> array: identity for an array (destructuring reads by index),
  // else materialize a string's chars or a generator's values. params 0=x; locals
  // 1=out,2=addr,3=len,4=i,5=res
  if (toarray) {
    const tbody = [
      m.local.set(2, m.i32.and(g(0), c(~3))),
      m.if(m.i32.eq(ld(0, g(2)), c(ARRTAG)), m.return(g(0))),                 // already an array
      m.local.set(1, m.call("__newarr", [], I32)),
      m.if(m.i32.eq(ld(0, g(2)), c(STRTAG)), m.block(null, [                  // string: one char per element
        m.local.set(3, ld(4, g(2))), m.local.set(4, c(0)),
        m.loop("S", m.block(null, [
          m.if(m.i32.ge_s(g(4), g(3)), m.return(g(1))),
          m.drop(m.call("__arrpush", [g(1), charStr(g(0), g(4))], I32)),
          m.local.set(4, m.i32.add(g(4), c(1))), m.br("S"),
        ])),
      ], binaryen.none)),
    ];
    if (valueId != null) tbody.push(
      m.if(m.i32.eq(ld(0, g(2)), c(GENTAG)), m.loop("G", m.block(null, [
        m.local.set(5, m.call("__gennext", [g(0), c(UNDEF)], I32)),
        m.if(m.i32.eq(m.call("__getprop", [g(5), c(doneId)], I32), c(TRUE)), m.return(g(1))),
        m.drop(m.call("__arrpush", [g(1), m.call("__getprop", [g(5), c(valueId)], I32)], I32)),
        m.br("G"),
      ]))));
    tbody.push(m.return(g(1)));
    m.addFunction("__toarray", binaryen.createType([I32]), I32, [I32, I32, I32, I32, I32], m.block(null, tbody, binaryen.none));
  }
  // __assignall(tgt, src) -> tgt: copy src's own (key, val) pairs into tgt (object
  // spread / Object.assign). params 0=tgt,1=src; locals 2=backing,3=count,4=i
  if (assignall) m.addFunction("__assignall", binaryen.createType([I32, I32]), I32, [I32, I32, I32], m.block(null, [
    m.local.set(2, ld(8, m.i32.and(g(1), c(~3)))), m.local.set(3, ld(4, m.i32.and(g(1), c(~3)))), m.local.set(4, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_s(g(4), g(3)), m.return(g(0))),
      m.if(m.i32.eqz(m.i32.and(ld(4, m.i32.add(g(2), m.i32.mul(g(4), c(8)))), c(HIDDEN_FLAG))),       // copy only enumerable pairs (spread / assign)
        m.drop(m.call("__setprop", [g(0), ld(4, m.i32.add(g(2), m.i32.mul(g(4), c(8)))), ld(8, m.i32.add(g(2), m.i32.mul(g(4), c(8))))], I32))), // tgt[key_i] = val_i
      m.local.set(4, m.i32.add(g(4), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ], binaryen.none));
}

// Runtime for floating-point (added when a program has a non-integer number).
// Numbers are coerced to f64, computed, then normalized back: a whole result in
// tagged-int range becomes a fixnum, otherwise it is boxed [FLOATTAG, f64].
function addFloatRuntime(m) {
  const I32 = binaryen.i32, F64 = binaryen.f64;
  const g = (i) => m.local.get(i, I32);
  const gf = (i) => m.local.get(i, F64);
  const c = (n) => m.i32.const(n);
  const cf = (x) => m.f64.const(x);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const ld8 = (off, p) => m.i32.load8_u(off, 1, p);
  const addr = (i) => m.i32.and(g(i), c(~3));
  const numf = (e) => m.call("__numf", [e], F64);
  const boxf = (e) => m.call("__boxf", [e], I32);

  // __strtof64(s) -> f64: parse [+/-]digits[.digits]. params 0=s; i32 locals
  // 1=i,2=len,3=neg,4=byte; f64 locals 5=int,6=frac,7=scale
  m.addFunction("__strtof64", binaryen.createType([I32]), F64, [I32, I32, I32, I32, F64, F64, F64], m.block(null, [
    m.local.set(2, ld(4, addr(0))), m.local.set(1, c(0)), m.local.set(3, c(0)),
    m.if(m.i32.lt_s(g(1), g(2)), m.block(null, [
      m.local.set(4, ld8(8, m.i32.add(addr(0), g(1)))),
      m.if(m.i32.eq(g(4), c(45)), m.block(null, [m.local.set(3, c(1)), m.local.set(1, c(1))])),  // '-'
      m.if(m.i32.eq(g(4), c(43)), m.local.set(1, c(1))),                                          // '+'
    ], binaryen.none)),
    m.local.set(5, cf(0)),
    m.loop("I", m.block(null, [                                                                   // integer part
      m.if(m.i32.lt_s(g(1), g(2)), m.block(null, [
        m.local.set(4, ld8(8, m.i32.add(addr(0), g(1)))),
        m.if(m.i32.and(m.i32.ge_s(g(4), c(48)), m.i32.le_s(g(4), c(57))), m.block(null, [
          m.local.set(5, m.f64.add(m.f64.mul(gf(5), cf(10)), m.f64.convert_s.i32(m.i32.sub(g(4), c(48))))),
          m.local.set(1, m.i32.add(g(1), c(1))), m.br("I"),
        ])),
      ])),
    ])),
    m.local.set(6, cf(0)), m.local.set(7, cf(1)),
    m.if(m.i32.and(m.i32.lt_s(g(1), g(2)), m.i32.eq(ld8(8, m.i32.add(addr(0), g(1))), c(46))), m.block(null, [ // '.'
      m.local.set(1, m.i32.add(g(1), c(1))),
      m.loop("F", m.block(null, [
        m.if(m.i32.lt_s(g(1), g(2)), m.block(null, [
          m.local.set(4, ld8(8, m.i32.add(addr(0), g(1)))),
          m.if(m.i32.and(m.i32.ge_s(g(4), c(48)), m.i32.le_s(g(4), c(57))), m.block(null, [
            m.local.set(6, m.f64.add(m.f64.mul(gf(6), cf(10)), m.f64.convert_s.i32(m.i32.sub(g(4), c(48))))),
            m.local.set(7, m.f64.mul(gf(7), cf(10))),
            m.local.set(1, m.i32.add(g(1), c(1))), m.br("F"),
          ])),
        ])),
      ])),
    ], binaryen.none)),
    m.local.set(5, m.f64.add(gf(5), m.f64.div(gf(6), gf(7)))),
    m.return(m.select(m.f64.eq(m.f64.convert_s.i32(g(3)), cf(1)), m.f64.neg(gf(5)), gf(5), F64)),
  ], binaryen.none));

  // __numf(v) -> f64: coerce a value to a double (fixnum / boxed float / string /
  // bool / null; undefined and objects -> NaN). param 0=v.
  m.addFunction("__numf", binaryen.createType([I32]), F64, [], m.block(null, [
    m.if(m.i32.eqz(m.i32.and(g(0), c(1))), m.return(m.f64.convert_s.i32(m.i32.shr_s(g(0), c(1))))), // fixnum
    m.if(m.i32.eq(g(0), c(UNDEF)), m.return(cf(NaN))),
    m.if(m.i32.eq(g(0), c(NULL)), m.return(cf(0))),
    m.if(m.i32.eq(g(0), c(TRUE)), m.return(cf(1))),
    m.if(m.i32.eq(g(0), c(FALSE)), m.return(cf(0))),
    m.if(m.i32.eq(ld(0, addr(0)), c(FLOATTAG)), m.return(m.f64.load(4, 4, addr(0)))),
    m.if(m.i32.eq(ld(0, addr(0)), c(STRTAG)), m.return(m.call("__strtof64", [g(0)], F64))),
    m.return(cf(NaN)),
  ], binaryen.none));

  // __boxf(f) -> tagged: a whole value in tagged-int range becomes a fixnum, else
  // a boxed [FLOATTAG, f64]. param 0=f (f64); local 1=p.
  m.addFunction("__boxf", binaryen.createType([F64]), I32, [I32], m.block(null, [
    m.if(m.i32.and(m.f64.eq(gf(0), m.f64.trunc(gf(0))), m.f64.lt(m.f64.abs(gf(0)), cf(1073741824))),
      m.return(m.i32.shl(m.i32.trunc_s.f64(gf(0)), c(1)))),                                        // whole & |f| < 2^30 -> fixnum
    m.local.set(1, m.i32.load(0, 4, c(BUMP_ADDR))),
    m.i32.store(0, 4, g(1), c(FLOATTAG)), m.f64.store(4, 8, g(1), gf(0)),
    m.i32.store(0, 4, c(BUMP_ADDR), m.i32.add(g(1), c(12))),
    m.return(m.i32.or(g(1), c(1))),
  ], binaryen.none));

  // Arithmetic / comparison slow paths (one operand isn't a fixnum). + concatenates
  // when a string is involved, so with strings it routes to __add (string runtime);
  // __addf is the pure-numeric + for a program that coerces (boolean/null/undefined ->
  // number) but has no strings — so the coercion path needs no string runtime / host
  // import. The rest are numeric here.
  const bin = (name, f) => m.addFunction(name, binaryen.createType([I32, I32]), I32, [], m.block(null, [m.return(f())], binaryen.none));
  bin("__addf", () => boxf(m.f64.add(numf(g(0)), numf(g(1)))));
  bin("__subf", () => boxf(m.f64.sub(numf(g(0)), numf(g(1)))));
  bin("__mulf", () => boxf(m.f64.mul(numf(g(0)), numf(g(1)))));
  bin("__divf", () => boxf(m.f64.div(numf(g(0)), numf(g(1)))));
  const cmp = (name, f) => m.addFunction(name, binaryen.createType([I32, I32]), I32, [], m.block(null, [m.return(m.select(f(numf(g(0)), numf(g(1))), c(TRUE), c(FALSE)))], binaryen.none));
  cmp("__ltf", (x, y) => m.f64.lt(x, y));
  cmp("__lef", (x, y) => m.f64.le(x, y));
  cmp("__gtf", (x, y) => m.f64.gt(x, y));
  cmp("__gef", (x, y) => m.f64.ge(x, y));
  m.addFunction("__negf", binaryen.createType([I32]), I32, [], m.block(null, [m.return(boxf(m.f64.neg(numf(g(0)))))], binaryen.none));
  // Number.isInteger: a fixnum is always an integer; a boxed float is iff whole.
  m.addFunction("__isintf", binaryen.createType([I32]), I32, [], m.block(null, [
    m.if(m.i32.eqz(m.i32.and(g(0), c(1))), m.return(c(TRUE))),
    m.if(m.i32.and(m.i32.eq(m.i32.and(g(0), c(3)), c(1)), m.i32.eq(ld(0, addr(0)), c(FLOATTAG))),
      m.return(m.select(m.f64.eq(m.f64.load(4, 4, addr(0)), m.f64.trunc(m.f64.load(4, 4, addr(0)))), c(TRUE), c(FALSE)))),
    m.return(c(FALSE)),
  ], binaryen.none));
}

// Runtime helpers for strings (added only when a program has a string literal).
// A string is [STRTAG, byteLength, ...bytes]; "+" and "===" dispatch here.
function addStringRuntime(m, floats, bigs) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const st = (off, p, v) => m.i32.store(off, 4, p, v);
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

  // litStr(s) -> statements that build the constant string s into local 1 and return it tagged.
  const litStr = (s) => {
    const out = [m.local.set(1, bump()), st(0, g(1), c(STRTAG)), st(4, g(1), c(s.length))];
    for (let k = 0; k < s.length; k++) out.push(st8(8 + k, g(1), c(s.charCodeAt(k))));
    out.push(setBump(m.i32.add(g(1), c(8 + ((s.length + 3) & ~3)))), m.return(m.i32.or(g(1), c(1))));
    return m.block(null, out, binaryen.none);
  };
  // __tostr(v) -> string.  string: itself; fixnum: __numstr; boxed double: host __num_str;
  // boolean/null/undefined: their JS text; objects/arrays: "" (a later slice).
  m.addFunction("__tostr", binaryen.createType([I32]), I32, [I32], m.block(null, [
    m.if(isStr(0), m.return(g(0))),
    m.if(m.i32.eqz(m.i32.and(g(0), c(1))), m.return(m.call("__numstr", [g(0)], I32))),
    m.if(m.i32.eq(g(0), c(TRUE)), litStr("true")), m.if(m.i32.eq(g(0), c(FALSE)), litStr("false")),
    m.if(m.i32.eq(g(0), c(NULL)), litStr("null")), m.if(m.i32.eq(g(0), c(UNDEF)), litStr("undefined")),
    ...(floats ? [m.if(m.i32.and(m.i32.eq(m.i32.and(g(0), c(3)), c(1)), m.i32.eq(ld(0, addr(0)), c(FLOATTAG))), m.return(m.call("__num_str", [g(0)], I32)))] : []), // boxed double -> the host's Number->string
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
    m.return(floats ? m.call("__boxf", [m.f64.add(m.call("__numf", [g(0)], binaryen.f64), m.call("__numf", [g(1)], binaryen.f64))], I32) : m.i32.add(g(0), g(1))),
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
    m.if(m.i32.eq(ld(0, addr(0)), c(FLOATTAG)), retStr("number")),    // boxed double
    m.if(m.i32.eq(ld(0, addr(0)), c(BIGTAG)), retStr("bigint")),      // bigint
    m.if(m.i32.eq(ld(0, addr(0)), c(STRTAG)), retStr("string")),      // a pointer: dispatch on the heap tag
    m.if(m.i32.eq(ld(0, addr(0)), c(CLOSTAG)), retStr("function")),
    retStr("object"),                                                 // arrays / objects
  ], binaryen.none));
}

// __eq(a, b) -> 0/1: identical bits, equal floats by value, equal bigints, or equal
// strings by value. Lives apart from the string runtime because float and bigint
// equality need it WITHOUT strings (a program that coerces booleans/null into
// arithmetic pulls in the float runtime but no strings — see arithCoerce). Added
// whenever floats, bigints, or strings are present. locals: 2=la, 3=i.
function addEqRuntime(m, floats, bigs) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const ld8 = (off, p) => m.i32.load8_u(off, 1, p);
  const addr = (i) => m.i32.and(g(i), c(~3));
  const isStr = (i) => m.if(m.i32.and(g(i), c(1)), m.i32.eq(ld(0, addr(i)), c(STRTAG)), c(0));
  m.addFunction("__eq", binaryen.createType([I32, I32]), I32, [I32, I32], m.block(null, [
    // Boxed floats compare BY VALUE first — before the identical-bits fast path —
    // because NaN must never equal itself, even when both operands are the SAME
    // pointer (`a === a` for a boxed NaN). f64.eq gives that for free (NaN != NaN),
    // and a FLOATTAG box is always non-integer (whole values canonicalize to fixnums).
    ...(floats ? [m.if(m.i32.and(m.i32.and(m.i32.eq(m.i32.and(g(0), c(3)), c(1)), m.i32.eq(ld(0, addr(0)), c(FLOATTAG))), m.i32.and(m.i32.eq(m.i32.and(g(1), c(3)), c(1)), m.i32.eq(ld(0, addr(1)), c(FLOATTAG)))), // both boxed floats -> compare by value
      m.return(m.select(m.f64.eq(m.f64.load(4, 4, addr(0)), m.f64.load(4, 4, addr(1))), c(1), c(0))))] : []),
    m.if(m.i32.eq(g(0), g(1)), m.return(c(1))),                       // identical bits: fixnums, same pointer, same singleton
    ...(bigs ? [m.if(m.i32.and(m.i32.and(m.i32.eq(m.i32.and(g(0), c(3)), c(1)), m.i32.eq(ld(0, addr(0)), c(BIGTAG))), m.i32.and(m.i32.eq(m.i32.and(g(1), c(3)), c(1)), m.i32.eq(ld(0, addr(1)), c(BIGTAG)))), // both bigints -> host value compare
      m.return(m.select(m.i32.eqz(m.call("__big_cmp", [g(0), g(1)], I32)), c(1), c(0))))] : []),
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

// Runtime for string and array instance methods (added when a program calls one
// via CALLM). Strings are [STRTAG, byteLen, ...bytes] (ASCII); the helpers slice,
// case-fold, split, search, and join over that byte layout. Array helpers reuse
// __newarr / __arrpush. `genIds` carries {value, done} so Array.from can drain a
// generator (null when generators aren't in use).
function addStrMethRuntime(m, genIds) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const st = (off, p, v) => m.i32.store(off, 4, p, v);
  const ld8 = (off, p) => m.i32.load8_u(off, 1, p);
  const st8 = (off, p, v) => m.i32.store8(off, 1, p, v);
  const bump = () => m.i32.load(0, 4, c(BUMP_ADDR));
  const setBump = (v) => m.i32.store(0, 4, c(BUMP_ADDR), v);
  const addr = (i) => m.i32.and(g(i), c(~3));
  const pad = (e) => m.i32.and(m.i32.add(e, c(3)), c(~3));
  const tag = (e) => m.i32.or(e, c(1));
  const fn = (name, np, nl, body) => m.addFunction(name, binaryen.createType(new Array(np).fill(I32)), I32, new Array(nl).fill(I32), m.block(null, body, binaryen.none));

  // __substr(s, start, len) -> a fresh string of `len` bytes from byte `start`.
  fn("__substr", 3, 1, [
    m.local.set(3, bump()), st(0, g(3), c(STRTAG)), st(4, g(3), g(2)), setBump(m.i32.add(g(3), m.i32.add(c(8), pad(g(2))))),
    m.memory.copy(m.i32.add(g(3), c(8)), m.i32.add(m.i32.add(addr(0), c(8)), g(1)), g(2)),
    m.return(tag(g(3))),
  ]);

  // Case fold: copy s, mapping ASCII a-z<->A-Z. params 0=s; locals 1=len,2=str,3=i,4=b
  const fold = (name, lo, hi, delta) => fn(name, 1, 4, [
    m.local.set(1, ld(4, addr(0))), m.local.set(2, bump()), st(0, g(2), c(STRTAG)), st(4, g(2), g(1)), setBump(m.i32.add(g(2), m.i32.add(c(8), pad(g(1))))),
    m.local.set(3, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_u(g(3), g(1)), m.return(tag(g(2)))),
      m.local.set(4, ld8(8, m.i32.add(addr(0), g(3)))),
      m.if(m.i32.and(m.i32.ge_u(g(4), c(lo)), m.i32.le_u(g(4), c(hi))), m.local.set(4, m.i32.add(g(4), c(delta)))),
      st8(8, m.i32.add(g(2), g(3)), g(4)),
      m.local.set(3, m.i32.add(g(3), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ]);
  fold("__strupper", 97, 122, -32);
  fold("__strlower", 65, 90, 32);

  // is byte b ASCII whitespace?
  const isWs = (b) => m.i32.or(m.i32.or(m.i32.eq(b, c(32)), m.i32.eq(b, c(9))), m.i32.or(m.i32.eq(b, c(10)), m.i32.eq(b, c(13))));
  // __strtrim(s): drop leading/trailing whitespace. params 0=s; locals 1=len,2=i,3=j
  fn("__strtrim", 1, 3, [
    m.local.set(1, ld(4, addr(0))), m.local.set(2, c(0)), m.local.set(3, g(1)),
    m.loop("A", m.block(null, [m.if(m.i32.and(m.i32.lt_u(g(2), g(3)), isWs(ld8(8, m.i32.add(addr(0), g(2))))), m.block(null, [m.local.set(2, m.i32.add(g(2), c(1))), m.br("A")]))])),
    m.loop("B", m.block(null, [m.if(m.i32.and(m.i32.gt_u(g(3), g(2)), isWs(ld8(8, m.i32.add(addr(0), m.i32.sub(g(3), c(1)))))), m.block(null, [m.local.set(3, m.i32.sub(g(3), c(1))), m.br("B")]))])),
    m.return(m.call("__substr", [g(0), g(2), m.i32.sub(g(3), g(2))], I32)),
  ]);

  // __strfind(s, sub, from) -> first byte index of sub in s at/after `from`, or -1.
  // params 0=s,1=sub,2=from; locals 3=sl,4=nl,5=i,6=j
  fn("__strfind", 3, 4, [
    m.local.set(3, ld(4, addr(0))), m.local.set(4, ld(4, addr(1))), m.local.set(5, g(2)),
    m.if(m.i32.eqz(g(4)), m.return(g(2))),                                  // empty needle matches at `from`
    m.loop("L", m.block(null, [
      m.if(m.i32.gt_s(m.i32.add(g(5), g(4)), g(3)), m.return(c(-1))),       // past the last possible start
      m.local.set(6, c(0)),
      m.block("ne", [m.loop("M", m.block(null, [
        m.br_if("ne", m.i32.ge_u(g(6), g(4))),                              // full needle matched
        m.if(m.i32.ne(ld8(8, m.i32.add(addr(0), m.i32.add(g(5), g(6)))), ld8(8, m.i32.add(addr(1), g(6)))), m.br("ne")),
        m.local.set(6, m.i32.add(g(6), c(1))), m.br("M"),
      ]))]),
      m.if(m.i32.ge_u(g(6), g(4)), m.return(g(5))),                         // matched
      m.local.set(5, m.i32.add(g(5), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ]);
  // __strindexof(s, sub) -> tagged index or -1
  fn("__strindexof", 2, 0, [m.return(m.i32.shl(m.call("__strfind", [g(0), g(1), c(0)], I32), c(1)))]);
  // __strincludes(s, sub) -> tagged boolean
  fn("__strincludes", 2, 0, [m.return(m.select(m.i32.ge_s(m.call("__strfind", [g(0), g(1), c(0)], I32), c(0)), c(TRUE), c(FALSE)))]);
  // __strcharcodeat(s, i) -> tagged code unit, or undefined out of range. i is tagged.
  fn("__strcharcodeat", 2, 1, [m.local.set(2, m.i32.shr_s(g(1), c(1))), m.if(m.i32.or(m.i32.lt_s(g(2), c(0)), m.i32.ge_s(g(2), ld(4, addr(0)))), m.return(c(UNDEF))), m.return(m.i32.shl(ld8(8, m.i32.add(addr(0), g(2))), c(1)))]);
  // __strcharat(s, i) -> a one-char string ("" out of range). i is tagged.
  fn("__strcharat", 2, 1, [m.local.set(2, m.i32.shr_s(g(1), c(1))), m.if(m.i32.or(m.i32.lt_s(g(2), c(0)), m.i32.ge_s(g(2), ld(4, addr(0)))), m.return(m.call("__substr", [g(0), c(0), c(0)], I32))), m.return(m.call("__substr", [g(0), g(2), c(1)], I32))]);

  // __strsplit(s, sep) -> array of substrings. Empty sep -> array of single chars.
  // params 0=s,1=sep; locals 2=arr,3=sl,4=nl,5=i,6=hit
  fn("__strsplit", 2, 5, [
    m.local.set(2, m.call("__newarr", [], I32)), m.local.set(3, ld(4, addr(0))), m.local.set(4, ld(4, addr(1))),
    m.if(m.i32.eqz(g(4)), m.block(null, [                                   // "" separator: one char per element
      m.local.set(5, c(0)),
      m.loop("C", m.block(null, [
        m.if(m.i32.ge_u(g(5), g(3)), m.return(g(2))),
        m.drop(m.call("__arrpush", [g(2), m.call("__substr", [g(0), g(5), c(1)], I32)], I32)),
        m.local.set(5, m.i32.add(g(5), c(1))), m.br("C"),
      ])),
    ], binaryen.none)),
    m.local.set(5, c(0)),                                                   // i = segment start
    m.loop("L", m.block(null, [
      m.local.set(6, m.call("__strfind", [g(0), g(1), g(5)], I32)),         // next separator at/after i
      m.if(m.i32.lt_s(g(6), c(0)), m.block(null, [                          // none: push the tail, done
        m.drop(m.call("__arrpush", [g(2), m.call("__substr", [g(0), g(5), m.i32.sub(g(3), g(5))], I32)], I32)),
        m.return(g(2)),
      ], binaryen.none)),
      m.drop(m.call("__arrpush", [g(2), m.call("__substr", [g(0), g(5), m.i32.sub(g(6), g(5))], I32)], I32)),
      m.local.set(5, m.i32.add(g(6), g(4))), m.br("L"),
    ])),
    m.unreachable(),
  ]);

  // __slice(recv, start, end) -> substring (string) or subarray (array). start/end
  // are tagged ints; negative counts from the end; clamped. params 0=recv,1=start,
  // 2=end; locals 3=len,4=s,5=e,6=out,7=i
  fn("__slice", 3, 5, [
    m.local.set(3, ld(4, addr(0))),                                        // length (header word, both string and array)
    m.local.set(4, m.i32.shr_s(g(1), c(1))), m.local.set(5, m.i32.shr_s(g(2), c(1))),
    m.if(m.i32.lt_s(g(4), c(0)), m.local.set(4, m.i32.add(g(4), g(3)))), m.if(m.i32.lt_s(g(4), c(0)), m.local.set(4, c(0))),
    m.if(m.i32.lt_s(g(5), c(0)), m.local.set(5, m.i32.add(g(5), g(3)))), m.if(m.i32.gt_s(g(5), g(3)), m.local.set(5, g(3))),
    m.if(m.i32.lt_s(g(5), g(4)), m.local.set(5, g(4))),                     // empty if end < start
    m.if(m.i32.eq(ld(0, addr(0)), c(STRTAG)), m.return(m.call("__substr", [g(0), g(4), m.i32.sub(g(5), g(4))], I32))),
    m.local.set(6, m.call("__newarr", [], I32)), m.local.set(7, g(4)),      // array: copy elements [s, e)
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_s(g(7), g(5)), m.return(g(6))),
      m.drop(m.call("__arrpush", [g(6), ld(4, m.i32.add(ld(8, addr(0)), m.i32.mul(g(7), c(4))))], I32)),
      m.local.set(7, m.i32.add(g(7), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ]);

  // __arrjoin(arr, sep) -> string of the elements (each stringified) joined by sep.
  // params 0=arr,1=sep; locals 2=backing,3=len,4=out,5=i
  fn("__arrjoin", 2, 4, [
    m.local.set(2, ld(8, addr(0))), m.local.set(3, ld(4, addr(0))),
    m.local.set(4, m.call("__substr", [g(1), c(0), c(0)], I32)),            // out = "" (empty slice of sep)
    m.local.set(5, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_s(g(5), g(3)), m.return(g(4))),
      m.if(m.i32.gt_s(g(5), c(0)), m.local.set(4, m.call("__concat", [g(4), g(1)], I32))), // separator before each but the first
      m.local.set(4, m.call("__concat", [g(4), m.call("__tostr", [ld(4, m.i32.add(g(2), m.i32.mul(g(5), c(4))))], I32)], I32)),
      m.local.set(5, m.i32.add(g(5), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ]);

  // __arrayfrom(x) -> a new array: copy an array, the chars of a string, or the
  // values of a generator. params 0=x; locals 1=out,2=addr,3=backing,4=len,5=i,6=res
  const body = [
    m.local.set(1, m.call("__newarr", [], I32)), m.local.set(2, addr(0)),
    m.if(m.i32.eq(ld(0, g(2)), c(ARRTAG)), m.block(null, [
      m.local.set(3, ld(8, g(2))), m.local.set(4, ld(4, g(2))), m.local.set(5, c(0)),
      m.loop("L", m.block(null, [
        m.if(m.i32.ge_s(g(5), g(4)), m.return(g(1))),
        m.drop(m.call("__arrpush", [g(1), ld(4, m.i32.add(g(3), m.i32.mul(g(5), c(4))))], I32)),
        m.local.set(5, m.i32.add(g(5), c(1))), m.br("L"),
      ])),
    ], binaryen.none)),
    m.if(m.i32.eq(ld(0, g(2)), c(STRTAG)), m.block(null, [                  // string: one char per element
      m.local.set(4, ld(4, g(2))), m.local.set(5, c(0)),
      m.loop("S", m.block(null, [
        m.if(m.i32.ge_s(g(5), g(4)), m.return(g(1))),
        m.drop(m.call("__arrpush", [g(1), m.call("__substr", [g(0), g(5), c(1)], I32)], I32)),
        m.local.set(5, m.i32.add(g(5), c(1))), m.br("S"),
      ])),
    ], binaryen.none)),
  ];
  if (genIds) body.push(
    m.if(m.i32.eq(ld(0, g(2)), c(GENTAG)), m.loop("G", m.block(null, [
      m.local.set(6, m.call("__gennext", [g(0), c(UNDEF)], I32)),
      m.if(m.i32.eq(m.call("__getprop", [g(6), c(genIds.done)], I32), c(TRUE)), m.return(g(1))),
      m.drop(m.call("__arrpush", [g(1), m.call("__getprop", [g(6), c(genIds.value)], I32)], I32)),
      m.br("G"),
    ]))));
  body.push(m.return(g(1)));
  fn("__arrayfrom", 1, 6, body);

  // __arrflat(a) -> a new array flattened one level: an array element is spliced
  // in, anything else is copied. params 0=a; locals 1=out,2=backing,3=len,4=i,
  // 5=e,6=ib,7=il,8=j
  fn("__arrflat", 1, 8, [
    m.local.set(1, m.call("__newarr", [], I32)), m.local.set(2, ld(8, addr(0))), m.local.set(3, ld(4, addr(0))), m.local.set(4, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_s(g(4), g(3)), m.return(g(1))),
      m.local.set(5, ld(4, m.i32.add(g(2), m.i32.mul(g(4), c(4))))),                    // e = a[i]
      m.if(m.i32.and(m.i32.eq(m.i32.and(g(5), c(3)), c(1)), m.i32.eq(ld(0, m.i32.and(g(5), c(0xfffc))), c(ARRTAG))), m.block(null, [ // e is an array -> splice
        m.local.set(6, ld(8, m.i32.and(g(5), c(~3)))), m.local.set(7, ld(4, m.i32.and(g(5), c(~3)))), m.local.set(8, c(0)),
        m.loop("I", m.block(null, [
          m.if(m.i32.lt_s(g(8), g(7)), m.block(null, [
            m.drop(m.call("__arrpush", [g(1), ld(4, m.i32.add(g(6), m.i32.mul(g(8), c(4))))], I32)),
            m.local.set(8, m.i32.add(g(8), c(1))), m.br("I"),
          ])),
        ])),
      ], binaryen.none), m.drop(m.call("__arrpush", [g(1), g(5)], I32))),                // else copy the element
      m.local.set(4, m.i32.add(g(4), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ]);
}

// Runtime for Map and Set (added when a program constructs one). Keys/values are
// compared by __eq (value equality, so two equal strings collide as one key).
// Growth doubles the backing and memory.copies it, like the object runtime.
function addMapSetRuntime(m) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const st = (off, p, v) => m.i32.store(off, 4, p, v);
  const bump = () => m.i32.load(0, 4, c(BUMP_ADDR));
  const setBump = (v) => m.i32.store(0, 4, c(BUMP_ADDR), v);
  const addr = (i) => m.i32.and(g(i), c(~3));
  const eq = (a, b) => m.call("__eq", [a, b], I32);
  const fn = (name, np, nl, body) => m.addFunction(name, binaryen.createType(new Array(np).fill(I32)), I32, new Array(nl).fill(I32), m.block(null, body, binaryen.none));
  const ICAP = 4;

  // __newmap()/__newset() -> tagged pointer. entryWords = 2 (map) or 1 (set).
  const ctor = (name, tag, entryWords) => fn(name, 0, 2, [
    m.local.set(0, bump()), st(0, g(0), c(ICAP)), setBump(m.i32.add(g(0), c((1 + ICAP * entryWords) * 4))), // backing = [cap, ...slots]
    m.local.set(1, bump()), st(0, g(1), c(tag)), st(4, g(1), c(0)), st(8, g(1), g(0)), setBump(m.i32.add(g(1), c(12))),
    m.return(m.i32.or(g(1), c(1))),
  ]);
  ctor("__newmap", MAPTAG, 2);
  ctor("__newset", SETTAG, 1);

  // grow(addrLocal, backingLocal, countLocal, entryWords): double the backing if full.
  const grow = (entryWords) => m.block(null, [   // uses locals 4=addr,5=backing,6=count; 7=cap,8=newBacking
    m.local.set(7, ld(0, g(5))),
    m.if(m.i32.ge_s(g(6), g(7)), m.block(null, [
      m.local.set(8, bump()), st(0, g(8), m.i32.mul(g(7), c(2))), setBump(m.i32.add(g(8), m.i32.add(m.i32.mul(m.i32.mul(g(7), c(2)), c(entryWords * 4)), c(4)))),
      m.memory.copy(m.i32.add(g(8), c(4)), m.i32.add(g(5), c(4)), m.i32.mul(g(6), c(entryWords * 4))),
      st(8, g(4), g(8)), m.local.set(5, g(8)),
    ], binaryen.none)),
  ], binaryen.none);

  // Map: entry i key at backing+4+i*8, val at backing+8+i*8.
  const mkey = (b, i) => ld(4, m.i32.add(g(b), m.i32.mul(g(i), c(8))));
  const mval = (b, i) => ld(8, m.i32.add(g(b), m.i32.mul(g(i), c(8))));
  // __mapset(m,k,v) -> m. locals 3=i,4=addr,5=backing,6=count,7=cap,8=newBacking
  fn("__mapset", 3, 6, [
    m.local.set(4, addr(0)), m.local.set(5, ld(8, g(4))), m.local.set(6, ld(4, g(4))), m.local.set(3, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.lt_s(g(3), g(6)), m.block(null, [
        m.if(eq(mkey(5, 3), g(1)), m.block(null, [st(8, m.i32.add(g(5), m.i32.mul(g(3), c(8))), g(2)), m.return(g(0))])), // overwrite
        m.local.set(3, m.i32.add(g(3), c(1))), m.br("L"),
      ])),
    ])),
    grow(2),
    st(4, m.i32.add(g(5), m.i32.mul(g(6), c(8))), g(1)), st(8, m.i32.add(g(5), m.i32.mul(g(6), c(8))), g(2)), // append
    st(4, g(4), m.i32.add(g(6), c(1))), m.return(g(0)),
  ]);
  // __mapget(m,k)/__maphas(m,k)/__mapdel(m,k). locals 2=i,3=addr,4=backing,5=count
  const mscan = (name, hit, miss) => fn(name, 2, 4, [
    m.local.set(3, addr(0)), m.local.set(4, ld(8, g(3))), m.local.set(5, ld(4, g(3))), m.local.set(2, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_s(g(2), g(5)), m.return(miss)),
      m.if(eq(mkey(4, 2), g(1)), hit),
      m.local.set(2, m.i32.add(g(2), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ]);
  mscan("__mapget", m.return(mval(4, 2)), c(UNDEF));
  // __mapdel(m,k) -> bool: shift entries down. locals 2=i,3=addr,4=backing,5=count
  fn("__mapdel", 2, 4, [
    m.local.set(3, addr(0)), m.local.set(4, ld(8, g(3))), m.local.set(5, ld(4, g(3))), m.local.set(2, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_s(g(2), g(5)), m.return(c(FALSE))),
      m.if(eq(mkey(4, 2), g(1)), m.block(null, [
        m.memory.copy(m.i32.add(m.i32.add(g(4), c(4)), m.i32.mul(g(2), c(8))), m.i32.add(m.i32.add(g(4), c(12)), m.i32.mul(g(2), c(8))), m.i32.mul(m.i32.sub(m.i32.sub(g(5), g(2)), c(1)), c(8))),
        st(4, g(3), m.i32.sub(g(5), c(1))), m.return(c(TRUE)),
      ])),
      m.local.set(2, m.i32.add(g(2), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ]);

  // Set: value i at backing+4+i*4 (stride 1, like an array).
  const sval = (b, i) => ld(4, m.i32.add(g(b), m.i32.mul(g(i), c(4))));
  // __setadd(s,v) -> s. locals 3=i,4=addr,5=backing,6=count,7=cap,8=newBacking
  fn("__setadd", 2, 7, [
    m.local.set(4, addr(0)), m.local.set(5, ld(8, g(4))), m.local.set(6, ld(4, g(4))), m.local.set(3, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.lt_s(g(3), g(6)), m.block(null, [
        m.if(eq(sval(5, 3), g(1)), m.return(g(0))),            // already present
        m.local.set(3, m.i32.add(g(3), c(1))), m.br("L"),
      ])),
    ])),
    grow(1),
    st(4, m.i32.add(g(5), m.i32.mul(g(6), c(4))), g(1)),       // append
    st(4, g(4), m.i32.add(g(6), c(1))), m.return(g(0)),
  ]);
  // __collhas(coll, key) -> bool, for a Map or a Set. Tag-aware (entry stride is 8
  // bytes for a Map, 4 for a Set), so it is safe to call on either — unlike a
  // select over __maphas/__sethas, which would also run the wrong scan and could
  // deref garbage past the backing. params 0=coll,1=key; locals 2=addr,3=backing,
  // 4=count,5=i,6=stride
  fn("__collhas", 2, 5, [
    m.local.set(2, addr(0)), m.local.set(6, m.select(m.i32.eq(ld(0, g(2)), c(MAPTAG)), c(8), c(4))),
    m.local.set(3, ld(8, g(2))), m.local.set(4, ld(4, g(2))), m.local.set(5, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_s(g(5), g(4)), m.return(c(FALSE))),
      m.if(eq(ld(4, m.i32.add(g(3), m.i32.mul(g(5), g(6)))), g(1)), m.return(c(TRUE))),
      m.local.set(5, m.i32.add(g(5), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ]);
  // __mapinit(m, arr) -> m: arr of [k,v] pair arrays. locals 2=backing,3=len,4=i,5=pair
  fn("__mapinit", 2, 4, [
    m.local.set(2, ld(8, addr(1))), m.local.set(3, ld(4, addr(1))), m.local.set(4, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_s(g(4), g(3)), m.return(g(0))),
      m.local.set(5, m.i32.and(ld(4, m.i32.add(g(2), m.i32.mul(g(4), c(4)))), c(~3))),   // pair = arr[i] (an array [k,v])
      m.drop(m.call("__mapset", [g(0), ld(4, ld(8, g(5))), ld(8, ld(8, g(5)))], I32)),   // pair backing: [cap,k,v] -> k=ld(4,backing), v=ld(8,backing)
      m.local.set(4, m.i32.add(g(4), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ]);
  // __setinit(s, arr) -> s. locals 2=backing,3=len,4=i
  fn("__setinit", 2, 3, [
    m.local.set(2, ld(8, addr(1))), m.local.set(3, ld(4, addr(1))), m.local.set(4, c(0)),
    m.loop("L", m.block(null, [
      m.if(m.i32.ge_s(g(4), g(3)), m.return(g(0))),
      m.drop(m.call("__setadd", [g(0), ld(4, m.i32.add(g(2), m.i32.mul(g(4), c(4))))], I32)),
      m.local.set(4, m.i32.add(g(4), c(1))), m.br("L"),
    ])),
    m.unreachable(),
  ]);
  // __mapiter(map, kind) -> [ITERTAG, map, 0, kind]: kind 1=entries, 2=keys, 3=values.
  fn("__mapiter", 2, 1, [
    m.local.set(2, bump()), st(0, g(2), c(ITERTAG)), st(4, g(2), g(0)), st(8, g(2), c(0)), st(12, g(2), g(1)),
    setBump(m.i32.add(g(2), c(16))), m.return(m.i32.or(g(2), c(1))),
  ]);
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

// Runtime for getters/setters (added when a program uses GETPROPA/SETPROPA). A
// class with accessors tags each instance with a hidden __accessors__ object,
// mapping a property name to a { get, set } pair of closures (each captures the
// instance). A read/write checks that map and fires the accessor, else falls
// back to a plain field access.
function addAccessorRuntime(m, accKey, getKey, setKey, maxargs) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p);
  const addr = (i) => m.i32.and(g(i), c(~3));
  const isTag = (i, tag) => m.i32.and(m.i32.and(g(i), c(1)), m.i32.eq(ld(0, addr(i)), c(tag))); // a pointer to [tag, ...]?
  const P = 1 + maxargs;                                                                // the uniform table signature
  const accType = binaryen.createType(new Array(P).fill(I32));
  const pad = (args) => { while (args.length < P) args.push(c(UNDEF)); return args; };   // accessors are table-reachable user fns

  // __getpropa(obj, propKey, accKey, getKey) -> value.  locals: 4=accMap,5=entry,6=getter
  m.addFunction("__getpropa", binaryen.createType([I32, I32, I32, I32]), I32, [I32, I32, I32], m.block(null, [
    m.local.set(4, m.call("__getprop", [g(0), g(2)], I32)),                             // obj.__accessors__
    m.if(m.i32.eqz(isTag(4, OBJTAG)), m.return(m.call("__getprop", [g(0), g(1)], I32))),
    m.local.set(5, m.call("__getprop", [g(4), g(1)], I32)),                             // __accessors__[prop] = {get, set}
    m.if(m.i32.eqz(isTag(5, OBJTAG)), m.return(m.call("__getprop", [g(0), g(1)], I32))),
    m.local.set(6, m.call("__getprop", [g(5), g(3)], I32)),                             // .get
    m.if(m.i32.eqz(isTag(6, CLOSTAG)), m.return(m.call("__getprop", [g(0), g(1)], I32))),
    m.return(m.call_indirect("0", ld(4, addr(6)), pad([g(6)]), accType, I32)), // getter(env = the getter closure)
  ], binaryen.none));

  // __setpropa(obj, propKey, v, accKey, setKey) -> obj.  locals: 5=accMap,6=entry,7=setter
  const plain = () => m.block(null, [m.drop(m.call("__setprop", [g(0), g(1), g(2)], I32)), m.return(g(0))], binaryen.none);
  m.addFunction("__setpropa", binaryen.createType([I32, I32, I32, I32, I32]), I32, [I32, I32, I32], m.block(null, [
    m.local.set(5, m.call("__getprop", [g(0), g(3)], I32)),
    m.if(m.i32.eqz(isTag(5, OBJTAG)), plain()),
    m.local.set(6, m.call("__getprop", [g(5), g(1)], I32)),
    m.if(m.i32.eqz(isTag(6, OBJTAG)), plain()),
    m.local.set(7, m.call("__getprop", [g(6), g(4)], I32)),                             // .set
    m.if(m.i32.eqz(isTag(7, CLOSTAG)), plain()),
    m.drop(m.call_indirect("0", ld(4, addr(7)), pad([g(7), g(2)]), accType, I32)), // setter(env, v)
    m.return(g(0)),
  ], binaryen.none));
}

// Runtime for computed member access (obj[expr] / arr[i]). A receiver is an array
// (numeric index) or an object (string key). Object keys are interned ints, so a
// string key is mapped to its id by __keyid, which lazily seeds a table with the
// program's static keys and then interns any new key by value — so a key never
// seen statically still gets a unique id (no collisions), and a key shared with
// static access (GETPROP "x") resolves to the same id.
function addIndexRuntime(m, keyIds, acc) {
  const I32 = binaryen.i32, MAXKEYS = 64;
  const g = (i) => m.local.get(i, I32), c = (n) => m.i32.const(n);
  const ld = (off, p) => m.i32.load(off, 4, p), st = (off, p, v) => m.i32.store(off, 4, p, v);
  const addr = (i) => m.i32.and(g(i), c(~3));
  const pool = () => m.global.get("__keypool", I32), count = () => m.global.get("__keycount", I32);
  m.addGlobal("__keypool", I32, true, c(0));
  m.addGlobal("__keycount", I32, true, c(0));

  const seed = [m.local.set(2, m.i32.load(0, 4, c(BUMP_ADDR))), m.i32.store(0, 4, c(BUMP_ADDR), m.i32.add(g(2), c(MAXKEYS * 8)))]; // base + reserve
  for (const [name, id] of keyIds.entries()) {                                          // build each static key string into the table
    seed.push(m.local.set(1, m.i32.load(0, 4, c(BUMP_ADDR))), st(0, g(1), c(STRTAG)), st(4, g(1), c(name.length)));
    for (let k = 0; k < name.length; k++) seed.push(m.i32.store8(8 + k, 1, g(1), c(name.charCodeAt(k))));
    seed.push(m.i32.store(0, 4, c(BUMP_ADDR), m.i32.add(g(1), c(8 + ((name.length + 3) & ~3)))));
    seed.push(st((id - 1) * 8, g(2), m.i32.or(g(1), c(1))), st((id - 1) * 8 + 4, g(2), c(id)));
  }
  seed.push(m.global.set("__keypool", g(2)), m.global.set("__keycount", c(keyIds.size)));

  // __keyid(str) -> interned id.  locals: 1=tmp, 2=base, 3=i/newid
  m.addFunction("__keyid", binaryen.createType([I32]), I32, [I32, I32, I32], m.block(null, [
    m.if(m.i32.eqz(pool()), m.block(null, seed, binaryen.none)),                         // lazy seed
    m.local.set(3, c(0)),
    m.block("found", [m.loop("K", m.block(null, [
      m.br_if("found", m.i32.ge_u(g(3), count())),                                       // exhausted -> append
      m.if(m.call("__eq", [g(0), ld(0, m.i32.add(pool(), m.i32.mul(g(3), c(8))))], I32), m.return(ld(4, m.i32.add(pool(), m.i32.mul(g(3), c(8)))))),
      m.local.set(3, m.i32.add(g(3), c(1))), m.br("K"),
    ]))]),
    m.local.set(3, m.i32.add(count(), c(1))),                                            // new key: id = count + 1
    st(0, m.i32.add(pool(), m.i32.mul(count(), c(8))), g(0)), st(4, m.i32.add(pool(), m.i32.mul(count(), c(8))), g(3)),
    m.global.set("__keycount", g(3)), m.return(g(3)),
  ], binaryen.none));

  // __index(recv, key) -> value.  array: backing[untag(key)]; object: by string key.  locals: 2=addr
  m.addFunction("__index", binaryen.createType([I32, I32]), I32, [I32], m.block(null, [
    m.local.set(2, addr(0)),
    m.if(m.i32.eq(ld(0, g(2)), c(ARRTAG)), m.return(ld(4, m.i32.add(ld(8, g(2)), m.i32.mul(m.i32.shr_s(g(1), c(1)), c(4)))))),
    // object: computed read fires a getter if one exists (accessor-aware), else a plain field read
    m.return(acc ? m.call("__getpropa", [g(0), m.call("__keyid", [g(1)], I32), c(acc.accKey), c(acc.getKey)], I32) : m.call("__getprop", [g(0), m.call("__keyid", [g(1)], I32)], I32)),
  ], binaryen.none));

  // __setindex(recv, key, value).  array: backing[idx] = value (extend length); object: a setter
  // fires if one exists (accessor-aware), else a plain store.  locals: 3=addr, 4=idx
  m.addFunction("__setindex", binaryen.createType([I32, I32, I32]), I32, [I32, I32], m.block(null, [
    m.local.set(3, addr(0)),
    m.if(m.i32.eq(ld(0, g(3)), c(ARRTAG)), m.block(null, [
      m.local.set(4, m.i32.shr_s(g(1), c(1))),
      m.i32.store(4, 4, m.i32.add(ld(8, g(3)), m.i32.mul(g(4), c(4))), g(2)),            // backing[idx] = value
      m.if(m.i32.ge_s(g(4), ld(4, g(3))), st(4, g(3), m.i32.add(g(4), c(1)))),           // grow length if idx >= length
      m.return(c(0)),
    ], binaryen.none)),
    acc ? m.drop(m.call("__setpropa", [g(0), m.call("__keyid", [g(1)], I32), g(2), c(acc.accKey), c(acc.setKey)], I32))
      : m.drop(m.call("__setprop", [g(0), m.call("__keyid", [g(1)], I32), g(2)], I32)),
    m.return(c(0)),
  ], binaryen.none));
}

// A generator function compiles to two wasm functions. The TRAMPOLINE keeps the
// original name and is what CALLV calls: it allocates a generator object holding
// the body's table index and the initial args, and returns it (so no CALLV
// change is needed — a generator call just returns an object). locals: tmp.
function emitGenTrampoline(m, name, fn, bodyIdx, maxargs) {
  const I32 = binaryen.i32;
  const g = (i) => m.local.get(i, I32);
  const c = (n) => m.i32.const(n);
  const argc = fn.argc || 0, nl = fn.nlocals, P = 1 + maxargs, tmp = P; // params 0..P-1 (env + maxargs); tmp local after them
  const out = [
    m.local.set(tmp, m.i32.load(0, 4, c(BUMP_ADDR))),                                  // tmp = bump
    m.i32.store(0, 4, g(tmp), c(GENTAG)), m.i32.store(4, 4, g(tmp), c(bodyIdx)),
    m.i32.store(8, 4, g(tmp), c(0)), m.i32.store(12, 4, g(tmp), c(0)),                 // ip = 0, done = 0
  ];
  // object: [GENTAG, bodyIdx, ip, done, sent@16, mode@20, ...slots@24, env@(24+nl*4)]  (mode 1 = resume via .throw())
  for (let k = 0; k < argc; k++) out.push(m.i32.store(24 + k * 4, 4, g(tmp), g(k + 1))); // slots[k] = arg_k (param k+1)
  out.push(m.i32.store(24 + nl * 4, 4, g(tmp), g(0)));                                  // env (param 0): a generator method reads `this`/captures through it
  out.push(m.i32.store(0, 4, c(BUMP_ADDR), m.i32.add(g(tmp), c(28 + nl * 4))));         // bump past the object (extra slots are fresh 0)
  out.push(m.return(m.i32.or(g(tmp), c(1))));
  m.addFunction(name, binaryen.createType(new Array(P).fill(I32)), I32, [I32], m.block(null, out, binaryen.none)); // uniform signature: env + maxargs
}

// The dispatch BODY (`name$gen`), called by GENNEXT through the generator object.
// It restores its locals from the object, br_tables on the saved ip to the right
// basic block, runs to the next YIELD (save locals + ip, return the yielded
// value, done=0) or RET (done=1, return the value). A second, self-contained
// codegen path: a generator is inherently resumable, so it can't use the
// straight-line Relooper body. Numeric bodies for now (the common generator).
function compileGenBody(m, bodyName, fn, keyIds, fnIndex, maxargs, strings, floats, bigs) {
  const I32 = binaryen.i32;
  const nl = fn.nlocals, code = resolveLabels(fn.code);
  const loc = (i) => i + 1;
  const get = (i) => m.local.get(i, I32);
  const genAddr = () => m.i32.and(get(0), m.i32.const(~3));                            // param 0 = the generator object

  const genHasExc = code.some((ins) => ins[0] === "PUSHTRY" || ins[0] === "THROW"); // a try/catch inside the generator body
  const Lset = new Set([0]);             // basic-block leaders (YIELD's successor is a resume point)
  code.forEach((ins, i) => {
    if (ins[0] === "JMP" || ins[0] === "JMPF") { Lset.add(ins[1]); if (i + 1 < code.length) Lset.add(i + 1); }
    else if ((ins[0] === "RET" || ins[0] === "YIELD") && i + 1 < code.length) Lset.add(i + 1);
    else if (genHasExc && ins[0] === "PUSHTRY") Lset.add(ins[1]);
    else if (genHasExc && (ins[0] === "THROW" || CALL_OPS.has(ins[0])) && i + 1 < code.length) Lset.add(i + 1);
  });
  const leaders = [...Lset].filter((x) => x >= 0 && x < code.length).sort((a, b) => a - b);
  const blockOf = (ip) => leaders.indexOf(ip);
  const { entryH, maxAbs, blockHandler, entryHandler } = blockHeights(code, leaders); // YIELD is delta 0, so a resume block enters with the sent value on top
  const maxH = maxAbs + 1, scratch = (k) => 1 + nl + k, ipLocal = 1 + nl + maxH, envLocal = ipLocal + 1; // envLocal holds the closure env (restored each call from env@(24+nl*4))
  const bool = (cond) => m.select(cond, m.i32.const(TRUE), m.i32.const(FALSE));
  const falsy = (i) => m.i32.or(m.i32.or(m.i32.eqz(get(i)), m.i32.eq(get(i), m.i32.const(UNDEF))), m.i32.or(m.i32.eq(get(i), m.i32.const(NULL)), m.i32.eq(get(i), m.i32.const(FALSE))));
  const goto = (b) => [m.local.set(ipLocal, m.i32.const(b)), m.br("L")]; // intra-call jump: update the dispatch local, re-dispatch
  const saveIp = (b) => m.i32.store(8, 4, genAddr(), m.i32.const(b));     // persist the resume point into the object (across calls)
  const setDone = (d) => m.i32.store(12, 4, genAddr(), m.i32.const(d));
  // Exception transfer inside the dispatch: a caught throw is just a goto to the
  // catch block (value preserved in scratch(sp)); an uncaught one raises + ends.
  const excFlag = () => m.i32.load(0, 4, m.i32.const(EXC_FLAG));
  const raise = (valExpr) => [m.i32.store(0, 4, m.i32.const(EXC_VALUE), valExpr), m.i32.store(0, 4, m.i32.const(EXC_FLAG), m.i32.const(1))];
  const propagate = () => [setDone(1), m.return(m.i32.const(0))];        // uncaught: done + return; the EXC flag stays set for the driver
  const toCatch = (hand) => [m.local.set(scratch(hand.sp), m.i32.load(0, 4, m.i32.const(EXC_VALUE))), m.i32.store(0, 4, m.i32.const(EXC_FLAG), m.i32.const(0)), ...goto(blockOf(hand.catch))]; // value onto stack, clear flag, jump to the catch
  const saveLocals = () => { const out = []; for (let i = 0; i < nl; i++) out.push(m.i32.store(24 + i * 4, 4, genAddr(), get(loc(i)))); return out; };

  const rendered = [];                   // per block: [...stmts, ...terminator]
  for (let bi = 0; bi < leaders.length; bi++) {
    const start = leaders[bi], end = bi + 1 < leaders.length ? leaders[bi + 1] : code.length;
    const resume = start > 0 && code[start - 1][0] === "YIELD"; // entered on resume: the sent value sits on top of the operand stack
    const stmts = []; let h = entryH[bi], term = [];
    if (resume) {                          // resumed via next(v) [mode 0], .throw(e) [mode 1], or .return(v) [mode 2]
      const hand = entryHandler[bi];       // the yield's enclosing try, if any
      const throwArm = hand
        ? m.block(null, [...raise(m.i32.load(16, 4, genAddr())), ...toCatch(hand)], binaryen.none) // caught: route into the gen-body catch
        : m.block(null, [...raise(m.i32.load(16, 4, genAddr())), ...propagate()], binaryen.none);  // uncaught: propagate out of the generator
      // .return(v): raise RETSIG so any enclosing finally runs (and re-raises it); __genret turns it into {value:v, done:true}.
      const returnArm = hand
        ? m.block(null, [...raise(m.i32.const(RETSIG)), ...toCatch(hand)], binaryen.none)          // run the finally, then re-raise -> propagates RETSIG
        : m.block(null, [...raise(m.i32.const(RETSIG)), ...propagate()], binaryen.none);           // no finally -> just propagate RETSIG out
      stmts.push(m.if(m.i32.eq(m.i32.load(20, 4, genAddr()), m.i32.const(2)), returnArm));
      stmts.push(m.if(m.i32.eq(m.i32.load(20, 4, genAddr()), m.i32.const(1)), throwArm));
      stmts.push(m.local.set(scratch(h - 1), m.i32.load(16, 4, genAddr()))); // mode 0: v becomes the yield expression's value
    }
    for (const ins of code.slice(start, end)) {
      switch (ins[0]) {
        case "PUSH": stmts.push(...pushLit(m, scratch(h), ins[1])); h++; break;
        case "LOAD": stmts.push(m.local.set(scratch(h), get(loc(ins[1])))); h++; break;
        case "LOADENV": stmts.push(m.local.set(scratch(h), m.i32.load(8 + ins[1] * 4, 4, m.i32.and(get(envLocal), m.i32.const(~3))))); h++; break; // env[idx] — a captured outer var
        case "LOADTHIS": stmts.push(m.local.set(scratch(h), m.i32.load(8 + ins[1] * 4, 4, m.i32.and(get(envLocal), m.i32.const(~3))))); h++; break; // `this`: a generator method captures the instance into env
        case "STORE": h--; stmts.push(m.local.set(loc(ins[1]), get(scratch(h)))); break;
        // Array data ops (no control flow / no suspension) — identical to compileFn.
        case "NEWARR": stmts.push(m.local.set(scratch(h), m.call("__newarr", [], I32))); h++; break;
        case "ARRPUSH": { h -= 2; stmts.push(m.drop(m.call("__arrpush", [get(scratch(h)), get(scratch(h + 1))], I32))); break; }
        case "APPENDALL": { h -= 1; stmts.push(m.drop(m.call("__appendall", [get(scratch(h - 1)), get(scratch(h))], I32))); break; } // [...src]
        case "TOARRAY": stmts.push(m.local.set(scratch(h - 1), m.call("__toarray", [get(scratch(h - 1))], I32))); break;
        case "ARRGET": { h -= 2; const backing = m.i32.load(8, 4, m.i32.and(get(scratch(h)), m.i32.const(~3))), idx = m.i32.shr_s(get(scratch(h + 1)), m.i32.const(1));
          stmts.push(m.local.set(scratch(h), m.i32.load(4, 4, m.i32.add(backing, m.i32.mul(idx, m.i32.const(4)))))); h++; break; }
        case "ARRLEN": stmts.push(m.local.set(scratch(h - 1), m.i32.shl(m.i32.load(4, 4, m.i32.and(get(scratch(h - 1)), m.i32.const(~3))), m.i32.const(1)))); break;
        case "POP": h--; break;
        case "DUP": stmts.push(m.local.set(scratch(h), get(scratch(h - 1)))); h++; break;
        case "NEG": stmts.push(m.local.set(scratch(h - 1), m.i32.sub(m.i32.const(0), get(scratch(h - 1))))); break;
        case "INC": stmts.push(m.local.set(scratch(h - 1), m.i32.add(get(scratch(h - 1)), m.i32.const(2)))); break;
        case "DEC": stmts.push(m.local.set(scratch(h - 1), m.i32.sub(get(scratch(h - 1)), m.i32.const(2)))); break;
        case "NOT": stmts.push(m.local.set(scratch(h - 1), bool(falsy(scratch(h - 1))))); break;
        case "BITNOT": stmts.push(m.local.set(scratch(h - 1), m.i32.sub(m.i32.const(-2), get(scratch(h - 1))))); break;
        case "ITER": stmts.push(m.local.set(scratch(h - 1), m.call("__iter", [get(scratch(h - 1))], I32))); break; // an array iterable gets wrapped; a generator passes through
        case "AWAIT": break;                   // await of a plain value is identity
        case "BIN": {                          // polymorphic int/float/string/bigint — shared with compileFn via binExpr
          h -= 2; const sa = scratch(h), sb = scratch(h + 1);
          stmts.push(m.local.set(scratch(h), binExpr(m, ins[1], () => get(sa), () => get(sb), strings, floats, bigs))); h++; break;
        }
        case "GETPROP": stmts.push(m.local.set(scratch(h - 1), m.call("__getprop", [get(scratch(h - 1)), m.i32.const(keyIds.get(ins[1]))], I32))); break;
        case "MAKECLOSURE": {                  // no-capture only (yield* targets a top-level generator)
          if ((ins[2] || []).length) throw new Error("aot: capturing closures in a generator body not yet supported");
          const idx = fnIndex[ins[1]]; if (idx === undefined) throw new Error("aot: MAKECLOSURE of unknown fn " + ins[1]);
          stmts.push(m.local.set(scratch(h + 1), m.i32.load(0, 4, m.i32.const(BUMP_ADDR))));
          stmts.push(m.i32.store(0, 4, get(scratch(h + 1)), m.i32.const(CLOSTAG)));
          stmts.push(m.i32.store(4, 4, get(scratch(h + 1)), m.i32.const(idx)));
          stmts.push(m.i32.store(0, 4, m.i32.const(BUMP_ADDR), m.i32.add(get(scratch(h + 1)), m.i32.const(8))));
          stmts.push(m.local.set(scratch(h), m.i32.or(get(scratch(h + 1)), m.i32.const(1)))); h++; break;
        }
        case "CALLV": {                        // call a closure (e.g. the inner generator's trampoline)
          const argc = ins[1]; h -= argc + 1;
          const fnv = m.i32.load(4, 4, m.i32.and(get(scratch(h)), m.i32.const(~3)));
          const args = [get(scratch(h))]; for (let k = 0; k < argc; k++) args.push(get(scratch(h + 1 + k)));
          while (args.length < 1 + maxargs) args.push(m.i32.const(UNDEF));              // pad to the uniform table signature
          stmts.push(m.local.set(scratch(h), m.call_indirect("0", fnv, args, binaryen.createType(new Array(1 + maxargs).fill(I32)), I32))); h++; break;
        }
        case "GENNEXT": { h -= 2; stmts.push(m.local.set(scratch(h), m.call("__gennext", [get(scratch(h)), get(scratch(h + 1))], I32))); h++; break; }
        case "PUSHTRY": case "POPTRY": break;  // handler scope resolved at compile time (blockHeights)
        case "THROW": { h--; const hand = blockHandler[bi]; term = hand ? goto(blockOf(hand.catch)) : [...raise(get(scratch(h))), ...propagate()]; break; } // local catch -> jump there (value preserved); else propagate
        case "JMP": term = goto(blockOf(ins[1])); break;
        case "JMPF": h--; term = [m.if(falsy(scratch(h)), m.block(null, goto(blockOf(ins[1])), binaryen.none))]; break;
        case "YIELD": h--; term = [...saveLocals(), saveIp(blockOf(end)), setDone(0), m.return(get(scratch(h)))]; break; // suspend: resume at the next block
        case "RET": h--; term = [setDone(1), m.return(get(scratch(h)))]; break;
        default: throw new Error("aot: opcode " + ins[0] + " not supported in a generator body yet");
      }
    }
    // A call ends a block (with gen-body exceptions): check the pending-exception flag.
    if (genHasExc && !term.length && CALL_OPS.has(code[end - 1][0])) {
      const hand = blockHandler[bi];
      term = [m.if(excFlag(), m.block(null, hand ? toCatch(hand) : propagate(), binaryen.none))];
    }
    rendered.push([...stmts, ...term]); // a "fall" terminator is empty — control flows naturally to the next block's code
  }

  const N = leaders.length;
  const labels = leaders.map((_, i) => "b" + i);
  let node = m.block("b0", [m.switch(labels, "D", get(ipLocal))], binaryen.none); // br_table on ip, then b0 code follows
  for (let bi = 0; bi < N - 1; bi++) node = m.block("b" + (bi + 1), [node, ...rendered[bi]], binaryen.none);
  const dispatch = m.block("D", [node, ...rendered[N - 1]], binaryen.none);
  const prologue = [];
  for (let i = 0; i < nl; i++) prologue.push(m.local.set(loc(i), m.i32.load(24 + i * 4, 4, genAddr())));
  prologue.push(m.local.set(ipLocal, m.i32.load(8, 4, genAddr())));
  prologue.push(m.local.set(envLocal, m.i32.load(24 + nl * 4, 4, genAddr()))); // restore the closure env (constant across yields)
  const body = m.block(null, [...prologue, m.loop("L", m.block(null, [dispatch, m.unreachable()], binaryen.none))], binaryen.none);
  m.addFunction(bodyName, binaryen.createType([I32]), I32, new Array(nl + maxH + 2).fill(I32), body);
}

// Runtime: drive a generator one step (added when a program uses generators).
function addGenRuntime(m, valueKey, doneKey, mapSet) {
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
  // __char1(s, i) -> a one-char string of byte i of string s (for-of over a string).
  m.addFunction("__char1", binaryen.createType([I32, I32]), I32, [I32], m.block(null, [
    m.local.set(2, m.i32.load(0, 4, c(BUMP_ADDR))),
    m.i32.store(0, 4, g(2), c(STRTAG)), m.i32.store(4, 4, g(2), c(1)),
    m.i32.store8(8, 1, g(2), m.i32.load8_u(8, 1, m.i32.add(m.i32.and(g(0), c(~3)), g(1)))),
    m.i32.store(0, 4, c(BUMP_ADDR), m.i32.add(g(2), c(12))),
    m.return(m.i32.or(g(2), c(1))),
  ], binaryen.none));
  // Resume the body once (mode 0 = next, 1 = throw); if it raised an uncaught
  // exception, propagate (the EXC flag is left set for the caller's check).
  const drive = (mode) => m.block(null, [
    m.if(m.i32.load(12, 4, genAddr()), mkResult(c(UNDEF), c(TRUE))),                    // already finished
    m.i32.store(16, 4, genAddr(), g(1)), m.i32.store(20, 4, genAddr(), c(mode)),       // the value passed to next()/throw(), and the resume mode
    m.local.set(2, m.call_indirect("0", m.i32.load(4, 4, genAddr()), [g(0)], binaryen.createType([I32]), I32)), // run to the next yield/return
    m.if(m.i32.load(0, 4, c(EXC_FLAG)), m.return(c(0))),                               // body threw uncaught -> propagate
    mkResult(g(2), m.select(m.i32.load(12, 4, genAddr()), c(TRUE), c(FALSE))),          // value + done (the body set done)
  ], binaryen.none);
  // __iter(v) -> an iterator [ITERTAG, coll, idx=0, kind]: an array or Set is
  // kind 0 (stride-1 values), a Map is kind 1 (entries); a generator (or anything
  // already an iterator) is returned as-is. locals: 1=p,2=tag,3=kind
  const mkIter = (kind) => m.block(null, [
    m.local.set(1, m.i32.load(0, 4, c(BUMP_ADDR))),
    m.i32.store(0, 4, g(1), c(ITERTAG)), m.i32.store(4, 4, g(1), g(0)), m.i32.store(8, 4, g(1), c(0)), m.i32.store(12, 4, g(1), kind),
    m.i32.store(0, 4, c(BUMP_ADDR), m.i32.add(g(1), c(16))),
    m.return(m.i32.or(g(1), c(1))),
  ], binaryen.none);
  m.addFunction("__iter", binaryen.createType([I32]), I32, [I32, I32, I32], m.block(null, [
    m.if(m.i32.ne(m.i32.and(g(0), c(3)), c(1)), m.return(g(0))),                              // not a pointer -> as-is
    m.local.set(2, m.i32.load(0, 4, m.i32.and(g(0), c(0xfffc)))),
    m.if(m.i32.eq(g(2), c(ARRTAG)), mkIter(c(0))),
    m.if(m.i32.eq(g(2), c(STRTAG)), mkIter(c(4))),                                            // for-of over a string -> per-char iterator
    ...(mapSet ? [m.if(m.i32.eq(g(2), c(SETTAG)), mkIter(c(0))), m.if(m.i32.eq(g(2), c(MAPTAG)), mkIter(c(1)))] : []),
    m.return(g(0)),                                                                           // generator / existing iterator
  ], binaryen.none));
  // __gennext(gen, sent) -> {value, done}.  An ITERTAG iterator advances over its
  // collection's backing (kind 0 = stride-1 values, 1 = map [k,v] entries, 2 = map
  // keys, 3 = map values); otherwise drive the generator body. locals: 2=ret,3=obj,
  // 4=iterAddr,5=collBacking,6=idx,7=kind/pairArr
  const elem1 = () => m.i32.load(4, 4, m.i32.add(g(5), m.i32.mul(g(6), c(4))));               // stride-1 value
  const mapK = () => m.i32.load(4, 4, m.i32.add(g(5), m.i32.mul(g(6), c(8))));                // map entry key
  const mapV = () => m.i32.load(8, 4, m.i32.add(g(5), m.i32.mul(g(6), c(8))));                // map entry value
  m.addFunction("__gennext", binaryen.createType([I32, I32]), I32, [I32, I32, I32, I32, I32, I32], m.block(null, [
    m.if(m.i32.and(m.i32.eq(m.i32.and(g(0), c(3)), c(1)), m.i32.eq(m.i32.load(0, 4, m.i32.and(g(0), c(0xfffc))), c(ITERTAG))), m.block(null, [
      m.local.set(4, m.i32.and(g(0), c(~3))), m.local.set(7, m.i32.load(12, 4, g(4))), m.local.set(6, m.i32.load(8, 4, g(4))),
      m.if(m.i32.ge_s(g(6), m.i32.load(4, 4, m.i32.and(m.i32.load(4, 4, g(4)), c(~3)))), mkResult(c(UNDEF), c(TRUE))), // idx >= count -> done
      m.local.set(5, m.i32.load(8, 4, m.i32.and(m.i32.load(4, 4, g(4)), c(~3)))),             // backing
      m.i32.store(8, 4, g(4), m.i32.add(g(6), c(1))),                                          // advance idx
      ...(mapSet ? [
        m.if(m.i32.eq(g(7), c(2)), mkResult(mapK(), c(FALSE))),                                // map keys
        m.if(m.i32.eq(g(7), c(3)), mkResult(mapV(), c(FALSE))),                                // map values
        m.if(m.i32.eq(g(7), c(1)), m.block(null, [                                             // map entries -> [k, v]
          m.local.set(7, m.call("__newarr", [], I32)),
          m.drop(m.call("__arrpush", [g(7), mapK()], I32)), m.drop(m.call("__arrpush", [g(7), mapV()], I32)),
          mkResult(g(7), c(FALSE)),
        ], binaryen.none)),
      ] : []),
      m.if(m.i32.eq(g(7), c(4)), mkResult(m.call("__char1", [m.i32.load(4, 4, g(4)), g(6)], I32), c(FALSE))), // string chars
      mkResult(elem1(), c(FALSE)),                                                             // kind 0: stride-1 value
    ], binaryen.none)),
    drive(0),
  ], binaryen.none));
  // __genthrow(gen, value) -> {value, done}.  it.throw(e): resume the body in throw mode.
  m.addFunction("__genthrow", binaryen.createType([I32, I32]), I32, [I32, I32], drive(1));
  // __genret(gen, value) -> {value, done:true}.  it.return(v): resume the body in mode 2,
  // which raises RETSIG at the suspended yield so any enclosing finally runs; the body
  // re-raises RETSIG and propagates. We consume it and complete with v. A real throw that
  // escapes a finally has a different EXC value, so it propagates instead.
  m.addFunction("__genret", binaryen.createType([I32, I32]), I32, [I32, I32], m.block(null, [
    m.if(m.i32.load(12, 4, genAddr()), mkResult(g(1), c(TRUE))),                       // already done -> {value:v, done:true}
    m.i32.store(16, 4, genAddr(), g(1)), m.i32.store(20, 4, genAddr(), c(2)),          // sent = v, mode = 2 (return)
    m.local.set(2, m.call_indirect("0", m.i32.load(4, 4, genAddr()), [g(0)], binaryen.createType([I32]), I32)), // run finally(s)
    m.i32.store(12, 4, genAddr(), c(1)),                                               // the generator is now finished
    m.if(m.i32.load(0, 4, c(EXC_FLAG)), m.block(null, [
      m.if(m.i32.eq(m.i32.load(0, 4, c(EXC_VALUE)), c(RETSIG)),                         // the return sentinel -> consume it, complete with v
        m.block(null, [m.i32.store(0, 4, c(EXC_FLAG), c(0)), mkResult(g(1), c(TRUE))], binaryen.none)),
      m.return(c(0)),                                                                  // a real throw escaped a finally -> propagate (EXC flag stays set)
    ], binaryen.none)),
    mkResult(g(1), c(TRUE)),                                                           // no try around the yield -> just {value:v, done:true}
  ], binaryen.none));
}

// program: { name: { argc?, nlocals, code } }. resources: import names a RES may
// call. Returns wasm bytes, Asyncify-instrumented unless asyncify:false.
//
// Calling convention: every user function takes the closure environment as a
// leading param, so the exported entry's signature is (env, ...args). A host
// invoking it passes a dummy env (0) first — e.g. render(0, threshold). An
// entry with no args needs nothing extra (the missing env coerces to 0).
export function compileToWasm(program, { entry = "main", resources = [], asyncify = true, handles = false, decode = false } = {}) {
  const m = new binaryen.Module();
  m.setMemory(1, 1, "memory");
  const uses = (...ops) => Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && ops.includes(i[0])));
  const usesClasses = uses("ISA");                          // instanceof needs the class runtime
  // A generator function is one a generator MAKECLOSURE (ins[3]) targets — not
  // just one that yields, so `function*(){}` with no yield still counts. Each is
  // compiled as a trampoline + dispatch body.
  const gens = [...new Set(Object.values(program).flatMap((fn) => fn.code.filter((i) => Array.isArray(i) && i[0] === "MAKECLOSURE" && i[3]).map((i) => i[1])))];
  const usesMapSet = Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && i[0] === "CTORG" && (i[1] === "Map" || i[1] === "Set"))); // Map/Set construction
  const usesGenerators = gens.length > 0 || uses("GENNEXT", "YIELD") || usesMapSet; // gen runtime + {value, done} objects; Map/Set reuse the iterator path
  const usesAccessors = uses("GETPROPA", "SETPROPA") || Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && i[0] === "SETHIDDEN" && i[1] === "__accessors__")); // static get/set access OR an accessor *definition* (computed access a[k] still fires it via __index)
  const usesJsonParse = Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && i[0] === "CALLM" && i[1] === "parse")); // JSON.parse(str): the host rebuilds the value tree via the runtime's own exported constructors
  const usesValues = Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && i[0] === "CALLM" && i[1] === "values" && i[2] >= 1)); // Object.values(obj) -> __values (needs __keystr + arrays)
  const usesObjAssign = Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && i[0] === "CALLM" && i[1] === "assign")); // Object.assign(target, ...sources) -> reuse __assignall
  const usesIndex = uses("INDEX", "SETINDEX") || usesJsonParse;             // computed member access -> the index runtime (+ key interning, which JSON.parse reuses to intern object keys)
  const usesReject = uses("MKREJECT");                      // Promise.reject -> a rejection cell; awaiting it throws
  const usesExceptions = uses("THROW", "PUSHTRY") || usesReject; // try/catch/throw: sentinel-return unwinding (a rejected await needs it too)
  const usesConstArray = Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && i[0] === "PUSH" && Array.isArray(i[1])));
  const usesRegex = Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && ((i[0] === "PUSH" && i[1] instanceof RegExp) || (i[0] === "CTORG" && i[1] === "RegExp")))); // a regex literal or new RegExp(s) -> host-delegated test/match/replace
  const STRMETHS = new Set(["toUpperCase", "toLowerCase", "trim", "split", "slice", "join", "from", "charCodeAt", "charAt", "flat"]); // CALLM names handled by the string/array-method runtime
  const usesStrMeth = Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && i[0] === "CALLM" && STRMETHS.has(i[1])));
  const usesKeys = uses("KEYS");                            // Object.keys / for-in -> the keys runtime (reverse id->string + an array)
  const usesJson = uses("JSONSTR");                         // JSON.stringify -> the json runtime (shares __keystr)
  // Floating point: a non-integer literal, a division (always float-shaped), or a
  // string that could coerce to a number through arithmetic (unary +/- compile to
  // *1 / NEG). Over-approximating is safe — the integer fast path is unchanged and
  // the float runtime is dead unless a real double appears.
  const hasNum = (pred) => Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && pred(i)));
  const usesBig = uses("TOBIG") || hasNum((i) => i[0] === "PUSH" && typeof i[1] === "bigint"); // a bigint literal or BigInt() -> the bignum runtime
  const numOp = new Set(["MUL", "SUB", "NEG", "LT", "LE", "GT", "GE"]);
  const usesNumPow = hasNum((i) => i[0] === "BIN" && i[1] === "**"); // number ** number -> host Math.pow (result may be fractional/out-of-range -> the float runtime boxes it)
  const callg = new Set(Object.values(program).flatMap((fn) => fn.code.filter((i) => Array.isArray(i) && i[0] === "CALLG").map((i) => i[1]))); // bare global calls present (Number/String/Boolean/parseInt/parseFloat/isNaN/isFinite)
  const usesParseInt = callg.has("parseInt"), usesParseFloat = callg.has("parseFloat");
  // Arithmetic and relational operators COERCE non-fixnum operands exactly like the
  // interpreter (true->1, false/null->0, undefined->NaN, string->parse, object->NaN).
  // That coercion lives on the float runtime's slow path, reached when the bothInt
  // fast path fails. So any program where an arithmetic/relational op could see a
  // non-fixnum operand needs that runtime — otherwise the raw integer op runs on an
  // odd-tagged singleton and yields garbage (a boolean reinterpreted as a pointer).
  // The only safe exception is a program whose every instruction is provably
  // fixnum-only: integer literals, integer arithmetic/bitwise, and control flow —
  // no variable/property/call reads, comparisons (booleans), or other literals that
  // could introduce a boolean/null/undefined/string/float.
  const ARITHOP = (i) => ["ADD", "SUB", "MUL", "LT", "LE", "GT", "GE"].includes(i[0]) || (i[0] === "BIN" && ["+", "-", "*", "<", "<=", ">", ">="].includes(i[1]));
  const FIXNUMONLY = (i) => (i[0] === "PUSH" && typeof i[1] === "number" && Number.isInteger(i[1])) || ["ADD", "SUB", "MUL", "INC", "DEC", "NEG", "BITNOT", "JMP", "JMPF", "RET", "POP", "DUP", "STORE"].includes(i[0]) || (i[0] === "BIN" && ["+", "-", "*", "%", "&", "|", "^", "<<", ">>", ">>>"].includes(i[1]));
  const arithCoerce = hasNum(ARITHOP) && !Object.values(program).every((fn) => fn.code.every((i) => !Array.isArray(i) || FIXNUMONLY(i)));
  // realFloat = an actual double is in play (literal, division, float->string coercion,
  // JSON number, **, Number()/isNaN/isFinite). It forces the STRING runtime too, since a
  // real float can be concatenated / stringified. arithCoerce is weaker: it only needs the
  // pure-numeric coercion path (__numf/__boxf/__addf, all host-free) so a boolean/null/
  // undefined operand becomes a number — no strings, no host import. usesFloat = either.
  const realFloat = hasNum((i) => i[0] === "PUSH" && typeof i[1] === "number" && !Number.isInteger(i[1]))
    || hasNum((i) => i[0] === "BIN" && i[1] === "/")
    || (hasNum((i) => i[0] === "PUSH" && typeof i[1] === "string") && hasNum((i) => numOp.has(i[0]) || (i[0] === "BIN" && ["*", "-", "<", "<=", ">", ">="].includes(i[1]))))
    || usesJsonParse // a parsed JSON number can be a non-integer / out-of-fixnum-range double, so the float runtime (and float->string) must be present (also pulls in usesStrings below)
    || usesNumPow
    || callg.has("Number") || callg.has("isNaN") || callg.has("isFinite"); // these coerce through __numf/__boxf / f64 compares
  const usesFloat = realFloat || arithCoerce;
  const usesArrays = uses("NEWARR", "ARRPUSH", "ARRGET", "ARRLEN", "APPENDALL", "ARGUMENTS", "GATHERREST", "TOARRAY", "KEYS") || usesConstArray || usesStrMeth || usesMapSet || usesJsonParse || usesValues; // __class__ name lists build arrays; APPENDALL/ARGUMENTS/GATHERREST/split/from/TOARRAY/KEYS push; Map entries + init use arrays; JSON.parse + Object.values build arrays
  const usesObjects = uses("NEWOBJ", "GETPROP", "SETPROP", "SETHIDDEN", "CALLMETHOD", "GETPROPA", "SETPROPA", "ASSIGNALL", "KEYS") || usesClasses || usesGenerators || usesIndex || usesValues; // instances, method dispatch, {value,done}, computed access, object spread, Object.values
  const usesStrings = usesClasses || usesIndex || usesStrMeth || usesKeys || usesJson || usesMapSet || realFloat || usesBig || callg.has("String") || Object.values(program).some((fn) => fn.code.some((i) => Array.isArray(i) && ((i[0] === "PUSH" && typeof i[1] === "string") || i[0] === "TYPEOF"))); // ISA / __keyid compare strings (__eq); string methods + keys + json build strings; Map/Set compare keys via __eq; a REAL float can concat/stringify (__add/__num_str); bigint toString/typeof; String() -> __tostr. (arithCoerce-only floats stay string-free — __addf is pure-numeric.)
  if (usesArrays || usesObjects || usesStrings) m.setFeatures(binaryen.Features.All); // enable memory.copy (bulk memory) for the grow/concat paths
  // Property and method keys are interned to small ints at compile time, so
  // GETPROP/SETPROP/SETHIDDEN/CALLMETHOD are id matches in the object runtime.
  const keyIds = new Map();
  for (const fn of Object.values(program)) for (const i of fn.code) if (Array.isArray(i) && (i[0] === "GETPROP" || i[0] === "SETPROP" || i[0] === "SETHIDDEN" || i[0] === "CALLMETHOD" || i[0] === "GETPROPA" || i[0] === "SETPROPA" || i[0] === "DELPROP") && !keyIds.has(i[1])) keyIds.set(i[1], keyIds.size + 1);
  if (usesGenerators) for (const k of ["value", "done"]) if (!keyIds.has(k)) keyIds.set(k, keyIds.size + 1); // GENNEXT builds {value, done}
  if (usesAccessors) for (const k of ["__accessors__", "get", "set"]) if (!keyIds.has(k)) keyIds.set(k, keyIds.size + 1); // accessor lookups
  if (usesObjects && !keyIds.has("length")) keyIds.set("length", keyIds.size + 1);                          // __getprop dispatches array/string .length on this id
  if (usesMapSet && !keyIds.has("size")) keyIds.set("size", keyIds.size + 1);                               // ...and Map/Set .size
  // Class names get a registry slot each (for the memoized class object used by statics).
  const clsIds = new Map();
  for (const fn of Object.values(program)) for (const i of fn.code) if (Array.isArray(i) && (i[0] === "CLSGET" || i[0] === "CLSPUT") && !clsIds.has(i[1])) clsIds.set(i[1], clsIds.size);
  if (clsIds.size > (HEAP_BASE - CLSREG_BASE) / 4) throw new Error("aot: too many classes for the class-object registry");
  const arity = {}; // each resource is imported with the arity it is called with
  for (const fn of Object.values(program)) for (const i of fn.code) if (Array.isArray(i) && i[0] === "RES") arity[i[1]] = i[2] || 0;
  for (const res of resources) m.addFunctionImport(res, "env", res, binaryen.createType(new Array(arity[res] || 0).fill(binaryen.i32)), binaryen.i32);
  if (handles) m.addFunctionImport("__fetch", "env", "__fetch", binaryen.createType([binaryen.i32]), binaryen.i32); // §5 deref-miss suspends here
  if (usesRegex) { // regex is delegated to the host's RegExp (stdlibHost provides these)
    const i2 = binaryen.createType([binaryen.i32, binaryen.i32]);
    m.addFunctionImport("__re_test", "env", "__re_test", i2, binaryen.i32);
    m.addFunctionImport("__re_match", "env", "__re_match", i2, binaryen.i32);
    m.addFunctionImport("__re_replace", "env", "__re_replace", binaryen.createType([binaryen.i32, binaryen.i32, binaryen.i32, binaryen.i32]), binaryen.i32);
  }
  if (usesBig) { // BigInt is delegated to the host's native BigInt (stdlibHost provides these)
    const i1 = binaryen.createType([binaryen.i32]), i2 = binaryen.createType([binaryen.i32, binaryen.i32]), i3 = binaryen.createType([binaryen.i32, binaryen.i32, binaryen.i32]);
    m.addFunctionImport("__big_bin", "env", "__big_bin", i3, binaryen.i32);   // (op, a, b) -> bigint
    m.addFunctionImport("__big_cmp", "env", "__big_cmp", i2, binaryen.i32);   // (a, b) -> -1/0/1
    m.addFunctionImport("__big_eq", "env", "__big_eq", i2, binaryen.i32);     // loose == -> 0/1
    m.addFunctionImport("__big_str", "env", "__big_str", i1, binaryen.i32);   // -> base-10 string
    m.addFunctionImport("__big_from", "env", "__big_from", i1, binaryen.i32); // BigInt(fixnum) -> bigint
  }
  if (usesFloat && usesStrings) m.addFunctionImport("__num_str", "env", "__num_str", binaryen.createType([binaryen.i32]), binaryen.i32); // boxed double -> string (the host's Number->string); referenced only by __tostr, which exists only with strings
  if (usesNumPow) m.addFunctionImport("__num_pow", "env", "__num_pow", binaryen.createType([binaryen.i32, binaryen.i32]), binaryen.i32); // number ** number -> Math.pow (host), boxed back into the value model
  if (usesJsonParse) m.addFunctionImport("__json_parse", "env", "__json_parse", binaryen.createType([binaryen.i32]), binaryen.i32); // JSON.parse(str) -> value tree (the host's own JSON.parse, rebuilt through the exported constructors below)
  if (usesParseInt) m.addFunctionImport("__parse_int", "env", "__parse_int", binaryen.createType([binaryen.i32, binaryen.i32]), binaryen.i32);   // parseInt(str, radix) — the host's own parser
  if (usesParseFloat) m.addFunctionImport("__parse_float", "env", "__parse_float", binaryen.createType([binaryen.i32]), binaryen.i32);            // parseFloat(str)
  // Closures call through a function table: every user function sits at its
  // program-order index, and a closure carries that index (MAKECLOSURE / CALLV).
  // A generator function adds a second entry — its dispatch body `name$gen`.
  const fnNames = [...Object.keys(program), ...gens.map((g) => g + "$gen")];
  const fnIndex = Object.fromEntries(fnNames.map((n, i) => [n, i]));
  const usesClosures = fnNames.length > 0 && uses("MAKECLOSURE", "CALLV", "CALLVS", "CALLDYN", "CALLMETHOD", "GETPROPA", "SETPROPA"); // all call through the function table
  // Every table-reachable function shares one signature (env + maxargs) so an
  // indirect call never mismatches the callee's declared arity — a HOF callback
  // declared `x => ...` can be called with (value, index), extra args ignored.
  let maxargs = 0;
  for (const fn of Object.values(program)) {
    maxargs = Math.max(maxargs, fn.argc || 0);
    for (const i of fn.code) if (Array.isArray(i)) {
      if (i[0] === "CALLV" || i[0] === "CALLDYN") maxargs = Math.max(maxargs, i[1]);
      else if (i[0] === "CALLMETHOD" || i[0] === "CALL") maxargs = Math.max(maxargs, i[0] === "CALL" ? (i[2] || 0) : i[2]);
    }
  }
  if (usesAccessors) maxargs = Math.max(maxargs, 1); // a setter call passes (env, value): the uniform signature must hold both even if no setter exists (SETPROPA falls back to a plain store)
  // A spread call f(...xs) can pass more args than any static arity, and a rest
  // param must collect them all from the fixed param slots — so reserve headroom.
  // Spreads beyond this bound (rare) would truncate into a rest param.
  if (uses("CALLVS")) maxargs = Math.max(maxargs, 8);
  const needsArgc = uses("ARGUMENTS", "GATHERREST"); // `arguments` / rest params recover the real arg count from ARGC_ADDR
  for (const [name, fn] of Object.entries(program)) {
    if (gens.includes(name)) { emitGenTrampoline(m, name, fn, fnIndex[name + "$gen"], maxargs); compileGenBody(m, name + "$gen", fn, keyIds, fnIndex, maxargs, usesStrings, usesFloat, usesBig); } // generator: trampoline + dispatch body
    else compileFn(m, name, fn, handles, fnIndex, keyIds, usesStrings, clsIds, usesExceptions, maxargs, needsArgc, usesReject, usesMapSet, usesFloat, usesBig);
  }
  if (usesArrays) addArrayRuntime(m);
  if (usesObjects) addObjectRuntime(m, keyIds.get("length"), keyIds.get("size"));
  if (usesMapSet) addMapSetRuntime(m);
  if (uses("CALLMS", "APPENDALL", "TOARRAY", "ASSIGNALL") || usesObjAssign) addBuiltinRuntime(m, { spread: uses("CALLMS"), append: uses("APPENDALL"), toarray: uses("TOARRAY"), assignall: uses("ASSIGNALL") || usesObjAssign, valueId: usesGenerators ? keyIds.get("value") : null, doneId: usesGenerators ? keyIds.get("done") : null });
  if (usesFloat) addFloatRuntime(m);
  if (usesFloat || usesBig || usesStrings) addEqRuntime(m, usesFloat, usesBig); // __eq: float/bigint value equality needs it even without the string runtime
  if (usesStrings) addStringRuntime(m, usesFloat, usesBig);
  if (usesReject) addPromiseRuntime(m);
  if (usesStrMeth) addStrMethRuntime(m, usesGenerators ? { value: keyIds.get("value"), done: keyIds.get("done") } : null);
  const buildKeystr = usesKeys || usesJson || usesValues || (decode && usesObjects); // `decode` forces the id->string table so readDeep can name object keys; Object.values needs it to pick enumerable pairs
  if (buildKeystr) { // __keystr maps EVERY key id -> its string; enumeration skips non-enumerable pairs by the per-pair HIDDEN_FLAG, so the same name can be a hidden method on one object and a data key on another
    addKeyStr(m, [...keyIds], keyIds.size, usesIndex); // usesIndex => the __keyid pool exists, so dynamic keys can be recovered
    if (usesKeys) addKeysRuntime(m);
    if (usesValues) addValuesRuntime(m);
    if (usesJson) addJsonRuntime(m);
  }
  if (usesClasses) addClassRuntime(m);
  if (usesIndex) addIndexRuntime(m, keyIds, usesAccessors ? { accKey: keyIds.get("__accessors__"), getKey: keyIds.get("get"), setKey: keyIds.get("set") } : null); // computed access fires accessors when the program has any
  if (usesAccessors) addAccessorRuntime(m, keyIds.get("__accessors__"), keyIds.get("get"), keyIds.get("set"), maxargs);
  if (usesGenerators) addGenRuntime(m, keyIds.get("value"), keyIds.get("done"), usesMapSet);
  if (usesClosures || usesGenerators) { // the table holds every function (closures call through it; the gen runtime's call_indirect needs it to exist even with no closures)
    m.addTable("0", fnNames.length, fnNames.length, binaryen.funcref);
    m.addActiveElementSegment("0", "fns", fnNames, m.i32.const(0));
    m.addTableExport("0", "__table"); // the regex host calls back into a replace-function through this
  }
  m.addFunctionExport(entry, entry);
  // JSON.parse is built on the host, which constructs the value tree by calling the
  // runtime's OWN constructors back through these exports — so the host needs no
  // knowledge of the heap layout (unlike a stringify-on-host, which would have to
  // decode every tag). Forced on above: usesArrays + usesObjects + usesIndex.
  if (usesJsonParse) for (const f of ["__newobj", "__setprop", "__keyid", "__newarr", "__arrpush"]) m.addFunctionExport(f, f);
  if (decode && buildKeystr) m.addFunctionExport("__keystr", "__keystr"); // readDeep resolves object key ids -> strings through this
  if (!m.validate()) { const txt = m.emitText(); throw new Error("aot: module did not validate\n" + txt); }
  if (asyncify) m.runPasses(["asyncify"]); // unwind/rewind frames to/from linear memory
  return m.emitBinary().slice();
}

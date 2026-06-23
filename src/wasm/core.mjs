// Stackmix — shared wasm runtime core. Used by the single-process demo
// (examples/wasm/index.mjs) and the two-process demo (examples/wasm-two-process) so the
// mechanism can't drift. See interpreter.wat for the memory map and the design-doc
// mapping; see compile.mjs for the TypeScript -> bytecode frontend.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- memory map (must match interpreter.wat) --------------------------------------
export const IP = 0, SP = 4, SMALL_BUMP = 8, RESULT = 12, FP = 16;
export const OPSTACK_BASE = 512;
export const BYTECODE_BASE = 4096;
export const CALL_STACK_BASE = 16384, FRAME_SIZE = 72; // 8B header + 16 i32 locals
export const HEAP_SMALL_BASE = 65536;
export const HEAP_BIG_BASE = 1048576;

// --- opcodes / resource ids -------------------------------------------------
export const OPS = { PUSH:1, LOAD:2, STORE:3, LT:4, GE:5, ADD:6, JMP:7, JMPF:8,
  NEWARR:9, ARRPUSH:10, ARRLEN:11, ARRGET:12, RES:13, RET:14, POP:15, CALL:16 };
export const RESOURCES = { "db.query": 0, "DOM.renderList": 1 };

// --- demo dataset parameters (live only on the server) ----------------------
export const N = 2_000_000;
export const MOD = 1000;
export const THRESHOLD = 999;            // keeps ~1/1000 of the rows
export const DATASET_BYTES = 4 + N * 4;  // [len][elems...] as it sits in HEAP_BIG

export const fmt = (b) => b >= 1e6 ? (b/1e6).toFixed(2)+" MB" : b >= 1e3 ? (b/1e3).toFixed(1)+" KB" : b+" B";

// Thrown by a resource a tier doesn't have -> unwinds wasm to the host (§8.3.3).
export class Suspend { constructor(resid) { this.resid = resid; } }

// --- assembler: labeled asm (mixed ["OP",a,b] and "label" strings) -> bytes -
export function assemble(asm) {
  const items = [];
  const labels = {};
  for (const line of asm) {
    if (typeof line === "string") { labels[line] = items.length * 12; continue; }
    items.push(line);
  }
  const buf = Buffer.alloc(items.length * 12);
  items.forEach((ins, n) => {
    const [op, a = 0, b = 0] = ins;
    if (!(op in OPS)) throw new Error("unknown op " + op);
    buf.writeInt32LE(OPS[op], n * 12);
    buf.writeInt32LE(typeof a === "string" ? labels[a] : a, n * 12 + 4);
    buf.writeInt32LE(b, n * 12 + 8);
  });
  return buf;
}

// --- wasm module (auto-build from interpreter.wat if needed) -----------------------
const WASM_PATH = fileURLToPath(new URL("./interpreter.wasm", import.meta.url));
let MODULE = null;
async function getModule() {
  if (!existsSync(WASM_PATH)) await import("./build.mjs");
  if (!MODULE) MODULE = new WebAssembly.Module(readFileSync(WASM_PATH));
  return MODULE;
}
export function wasmByteLength() { return readFileSync(WASM_PATH).length; }

// Create one tier = one wasm instance. `resourceTable` maps resid -> handler;
// the tier "has" exactly those resources. A call to any other resource throws
// Suspend (the import table is the capability boundary, §4.2.1/§7).
//   handler(ctx) where ctx = { i32, sp, peek(k) } -> result i32
export async function makeInstance(name, bytecode, resourceTable) {
  const holder = { memory: null };
  function resource(resid, _argc) {
    if (!(resid in resourceTable)) throw new Suspend(resid);
    const i32 = new Int32Array(holder.memory.buffer);
    const sp = i32[SP / 4];
    const peek = (k) => i32[OPSTACK_BASE / 4 + (sp - 1 - k)];
    return resourceTable[resid]({ i32, sp, peek });
  }
  const instance = new WebAssembly.Instance(await getModule(), { env: { resource } });
  holder.memory = instance.exports.memory;
  Buffer.from(holder.memory.buffer, BYTECODE_BASE, bytecode.length).set(bytecode); // shared code, both tiers
  return { name, exports: instance.exports, memory: holder.memory };
}

export function setEntryState(memory, locals0) {
  const dv = new DataView(memory.buffer);
  dv.setInt32(IP, 0, true);
  dv.setInt32(SP, 0, true);
  dv.setInt32(SMALL_BUMP, HEAP_SMALL_BASE, true);
  dv.setInt32(RESULT, 0, true);
  dv.setInt32(FP, CALL_STACK_BASE, true);            // one frame: the entry call
  dv.setInt32(CALL_STACK_BASE + 0, -1, true);        // retIP sentinel
  dv.setInt32(CALL_STACK_BASE + 4, -1, true);        // prevFP = -1 -> no caller
  dv.setInt32(CALL_STACK_BASE + 8 + 0 * 4, locals0, true); // entry param in local 0
}

// --- the continuation: a slice of linear memory ----------------------------
// ctrl(24) + used operand stack + used call stack (all live frames + their
// locals) + used small heap. NOT bytecode (shared), NOT HEAP_BIG (the dataset).
// Self-describing: sp, fp and small_bump live inside ctrl, so restore knows the
// section lengths. The call-stack section is what makes the continuation
// multi-frame (§4.4).
export function capture(memory) {
  const dv = new DataView(memory.buffer);
  const sp = dv.getInt32(SP, true);
  const fp = dv.getInt32(FP, true);
  const smallBump = dv.getInt32(SMALL_BUMP, true);
  return Buffer.concat([
    Buffer.from(memory.buffer.slice(0, 24)),                                  // control
    Buffer.from(memory.buffer.slice(OPSTACK_BASE, OPSTACK_BASE + sp * 4)),    // operand stack
    Buffer.from(memory.buffer.slice(CALL_STACK_BASE, fp + FRAME_SIZE)),       // all live frames
    Buffer.from(memory.buffer.slice(HEAP_SMALL_BASE, smallBump)),             // small heap
  ]);
}

// Number of call frames in a captured continuation (evidence of multi-frame
// capture): the frame pointer in the control header indexes the top frame.
export function frameCount(wire) {
  const fp = new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getInt32(FP, true);
  return (fp - CALL_STACK_BASE) / FRAME_SIZE + 1;
}

export function restore(memory, wire) {
  const dv = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const sp = dv.getInt32(SP, true);
  const fp = dv.getInt32(FP, true);
  const mem = new Uint8Array(memory.buffer);
  const csLen = (fp + FRAME_SIZE) - CALL_STACK_BASE;
  let o = 0;
  mem.set(wire.subarray(o, o + 24), 0); o += 24;
  mem.set(wire.subarray(o, o + sp * 4), OPSTACK_BASE); o += sp * 4;
  mem.set(wire.subarray(o, o + csLen), CALL_STACK_BASE); o += csLen;
  mem.set(wire.subarray(o), HEAP_SMALL_BASE); // remaining bytes = small heap
}

// --- demo resource handlers (shared) ---------------------------------------
// db.query writes the dataset into this instance's HEAP_BIG and returns its
// pointer. The big array stays here; only its pointer is a local in the cont.
export function dbQueryHandler({ i32 }) {
  i32[HEAP_BIG_BASE / 4] = N;
  for (let k = 0; k < N; k++) i32[HEAP_BIG_BASE / 4 + 1 + k] = k % MOD;
  return HEAP_BIG_BASE;
}

// DOM.renderList reads the (small) matched array out of memory into `sink`.
export function makeRenderHandler(sink) {
  return ({ i32, peek }) => {
    const ptr = peek(0);
    const len = i32[ptr / 4];
    for (let k = 0; k < len; k++) sink.push(i32[ptr / 4 + 1 + k]);
    return len;
  };
}

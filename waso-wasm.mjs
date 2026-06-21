// Waso — running on REAL WebAssembly (two instances of one module).
//
//   node build-wasm.mjs && node waso-wasm.mjs     (or: npm run wasm)
//
// Same idea as the JS spike, but the interpreter is the compiled waso.wasm and
// the continuation is an actual slice of wasm LINEAR MEMORY. The two tiers are
// two instances of the SAME module wired with DIFFERENT imports — the import
// table is the capability boundary (§4.2.1, §7). We migrate by copying the live
// memory region out of one instance and into the other, and we show the big
// dataset (in a separate memory region) never travels.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Auto-build the wasm from waso.wat if it hasn't been compiled yet, so a fresh
// clone runs with a plain `node waso-wasm.mjs`.
const WASM_PATH = fileURLToPath(new URL("./waso.wasm", import.meta.url));
if (!existsSync(WASM_PATH)) await import("./build-wasm.mjs");

// --- memory map (must match waso.wat) --------------------------------------
const IP = 0, SP = 4, SMALL_BUMP = 8, RESULT = 12;
const LOCALS_BASE = 64, LOCALS_BYTES = 64;        // 16 i32 locals
const OPSTACK_BASE = 512;
const BYTECODE_BASE = 4096;
const HEAP_SMALL_BASE = 65536;
const HEAP_BIG_BASE = 1048576;

// --- the IR program (hand-lowered; integer dataset to keep values flat) -----
//   function render(threshold) {
//     const rows = db.query();           // server resource -> big int array
//     const matched = [];
//     for (let i = 0; i < rows.length; i++)
//       if (rows[i] >= threshold) matched.push(rows[i]);
//     DOM.renderList(matched);           // client resource
//     return matched.length;
//   }
// locals: 0=threshold 1=rows 2=matched 3=i 4=v ; resources: 0=db.query 1=DOM.renderList
const OPS = { PUSH:1, LOAD:2, STORE:3, LT:4, GE:5, ADD:6, JMP:7, JMPF:8,
             NEWARR:9, ARRPUSH:10, ARRLEN:11, ARRGET:12, RES:13, RET:14, POP:15 };
const LC = { threshold:0, rows:1, matched:2, i:3, v:4 };

function assemble(asm) {
  // First pass: lay out instructions (each 12 bytes) and record label offsets.
  const items = [];
  const labels = {};
  for (const line of asm) {
    if (typeof line === "string") { labels[line] = items.length * 12; continue; }
    items.push(line);
  }
  const buf = Buffer.alloc(items.length * 12);
  items.forEach((ins, n) => {
    const [op, a = 0, b = 0] = ins;
    buf.writeInt32LE(OPS[op], n * 12);
    buf.writeInt32LE(typeof a === "string" ? labels[a] : a, n * 12 + 4);
    buf.writeInt32LE(b, n * 12 + 8);
  });
  return buf;
}

const BYTECODE = assemble([
  ["RES", 0, 0],            // rows = db.query()
  ["STORE", LC.rows],
  ["NEWARR"],               // matched = []
  ["STORE", LC.matched],
  ["PUSH", 0], ["STORE", LC.i],
  "loop",
  ["LOAD", LC.i], ["LOAD", LC.rows], ["ARRLEN"], ["LT"], ["JMPF", "end"],
  ["LOAD", LC.rows], ["LOAD", LC.i], ["ARRGET"], ["STORE", LC.v],
  ["LOAD", LC.v], ["LOAD", LC.threshold], ["GE"], ["JMPF", "cont"],
  ["LOAD", LC.matched], ["LOAD", LC.v], ["ARRPUSH"],
  "cont",
  ["LOAD", LC.i], ["PUSH", 1], ["ADD"], ["STORE", LC.i], ["JMP", "loop"],
  "end",
  ["LOAD", LC.matched], ["RES", 1, 1],   // DOM.renderList(matched)
  ["POP"],
  ["LOAD", LC.matched], ["ARRLEN"], ["RET"],
]);

// --- dataset (lives only in the server instance's HEAP_BIG) -----------------
const N = 2_000_000;
const MOD = 1000;
const THRESHOLD = 999;                 // keeps ~1/1000 of the rows
const DATASET_BYTES = 4 + N * 4;       // [len][elems...] as it sits in memory

// --- tiers: a tier is just a capability set over resource ids ---------------
class Suspend { constructor(resid) { this.resid = resid; } }
const rendered = [];

function makeInstance(name, resourceIds) {
  const holder = { memory: null };
  const has = (id) => resourceIds.has(id);

  function resource(resid, argc) {
    const mem = holder.memory;
    const i32 = new Int32Array(mem.buffer);
    if (!has(resid)) throw new Suspend(resid);     // <-- forces migration

    if (resid === 0) {                              // db.query()
      i32[HEAP_BIG_BASE / 4] = N;                   // write dataset into HEAP_BIG
      for (let k = 0; k < N; k++) i32[HEAP_BIG_BASE / 4 + 1 + k] = k % MOD;
      return HEAP_BIG_BASE;                         // return pointer to the array
    }
    if (resid === 1) {                              // DOM.renderList(matched)
      const sp = i32[SP / 4];
      const ptr = i32[OPSTACK_BASE / 4 + (sp - 1)]; // peek top arg
      const len = i32[ptr / 4];
      for (let k = 0; k < len; k++) rendered.push(i32[ptr / 4 + 1 + k]);
      return len;
    }
    throw new Error("unknown resource " + resid);
  }

  const wasmBytes = readFileSync(WASM_PATH);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), { env: { resource } });
  holder.memory = instance.exports.memory;
  // Load the (shared) bytecode into this instance — both tiers run the same module.
  Buffer.from(holder.memory.buffer, BYTECODE_BASE, BYTECODE.length).set(BYTECODE);
  return { name, exports: instance.exports, memory: holder.memory };
}

// --- continuation = a slice of linear memory (NOT bytecode, NOT HEAP_BIG) ---
function capture(memory) {
  const dv = new DataView(memory.buffer);
  const sp = dv.getInt32(SP, true);
  const smallBump = dv.getInt32(SMALL_BUMP, true);
  const ctrl    = Buffer.from(memory.buffer.slice(0, 16));                       // ip,sp,bump,result
  const locals  = Buffer.from(memory.buffer.slice(LOCALS_BASE, LOCALS_BASE + LOCALS_BYTES));
  const opstack = Buffer.from(memory.buffer.slice(OPSTACK_BASE, OPSTACK_BASE + sp * 4));
  const small   = Buffer.from(memory.buffer.slice(HEAP_SMALL_BASE, smallBump));  // e.g. `matched`
  // The wire image, in fixed order. sp and smallBump (inside ctrl) make it self-describing.
  return Buffer.concat([ctrl, locals, opstack, small]);
}

function restore(memory, wire) {
  const dv = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const sp = dv.getInt32(SP, true);
  const smallBump = dv.getInt32(SMALL_BUMP, true);
  const mem = new Uint8Array(memory.buffer);
  let o = 0;
  mem.set(wire.subarray(o, o + 16), 0); o += 16;
  mem.set(wire.subarray(o, o + LOCALS_BYTES), LOCALS_BASE); o += LOCALS_BYTES;
  mem.set(wire.subarray(o, o + sp * 4), OPSTACK_BASE); o += sp * 4;
  mem.set(wire.subarray(o), HEAP_SMALL_BASE);          // remaining bytes = small heap
  void smallBump;
}

// --- orchestrate: oscillate the program between the two instances -----------
const server = makeInstance("server", new Set([0])); // has db.query
const client = makeInstance("client", new Set([1])); // has DOM.renderList

// cold start on the client: ip=0, sp=0, small_bump=HEAP_SMALL_BASE, threshold local
(() => {
  const dv = new DataView(client.memory.buffer);
  dv.setInt32(IP, 0, true); dv.setInt32(SP, 0, true);
  dv.setInt32(SMALL_BUMP, HEAP_SMALL_BASE, true); dv.setInt32(RESULT, 0, true);
  dv.setInt32(LOCALS_BASE + LC.threshold * 4, THRESHOLD, true);
})();

const migrations = [];
let current = client;
let value = null;
while (true) {
  try {
    current.exports.run();                                   // 0 = done
    value = new DataView(current.memory.buffer).getInt32(RESULT, true);
    break;
  } catch (e) {
    if (!(e instanceof Suspend)) throw e;
    const target = current === client ? server : client;
    const wire = capture(current.memory);                    // slice live memory
    migrations.push({ from: current.name, to: target.name, resid: e.resid, bytes: wire.length });
    restore(target.memory, wire);                            // load into other instance
    current = target;
  }
}

// --- report ----------------------------------------------------------------
const fmt = (b) => b >= 1e6 ? (b/1e6).toFixed(2)+" MB" : b >= 1e3 ? (b/1e3).toFixed(1)+" KB" : b+" B";
const resName = (id) => (id === 0 ? "db.query" : "DOM.renderList");

console.log("Waso on real WebAssembly — continuation = a slice of linear memory\n");
console.log(`Module: waso.wasm (${readFileSync(WASM_PATH).length} bytes), one module, two instances`);
console.log(`Program: render(threshold=${THRESHOLD})  cold-started on the CLIENT instance`);
console.log(`Dataset: ${N.toLocaleString()} ints in the server's HEAP_BIG = ${fmt(DATASET_BYTES)}\n`);

console.log("Migrations (each continuation was copied out of one instance's memory into the other's):");
for (const m of migrations)
  console.log(`  ${m.from.padEnd(6)} -> ${m.to.padEnd(6)}  forced by ${resName(m.resid).padEnd(14)}  continuation = ${fmt(m.bytes)}`);
console.log("");

const s2c = migrations.find((m) => m.from === "server" && m.to === "client");
console.log(`Key claim (§11): the server->client continuation is the live wasm stack`);
console.log(`(ip + locals + operand stack + the small 'matched' heap), not the dataset.`);
console.log(`The ${N.toLocaleString()}-int array stayed in the server instance's HEAP_BIG.`);
console.log(`  continuation copied between instances : ${fmt(s2c.bytes)}`);
console.log(`  full dataset, had we shipped it       : ${fmt(DATASET_BYTES)}`);
console.log(`  ratio                                 : ${(DATASET_BYTES / s2c.bytes).toFixed(0)}x smaller\n`);

// --- correctness: did real wasm compute the same thing as plain JS? ---------
let expected = 0; for (let k = 0; k < N; k++) if (k % MOD >= THRESHOLD) expected++;
const ok = value === expected && rendered.length === expected &&
           rendered.every((x) => x >= THRESHOLD);
console.log(`Correctness: wasm returned ${value}; DOM received ${rendered.length} items; ` +
            `matches plain JS (${expected})? ${ok ? "YES" : "NO"}`);
console.log(`Sample rendered: [${rendered.slice(0, 5).join(", ")}${rendered.length > 5 ? ", ..." : ""}]`);
if (!ok) process.exitCode = 1;

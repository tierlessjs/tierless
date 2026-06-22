// Waso on real WebAssembly, single process (two instances of one module).
//
//   node waso-wasm.mjs       (auto-builds waso.wasm; compiles app.ts)
//
// The program is authored as ordinary TypeScript in app.ts, compiled to Waso
// bytecode by the reference frontend, and run on the compiled waso.wasm. The
// two tiers are two instances of the SAME module wired with DIFFERENT imports
// (the import table is the capability boundary). Migration copies the live
// region of one instance's linear memory into the other's — the continuation
// IS a slice of linear memory. For a real OS-process boundary, see
// waso-wasm-2p-client.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "./waso-compile.mjs";
import {
  assemble, makeInstance, setEntryState, capture, restore, Suspend,
  dbQueryHandler, makeRenderHandler, fmt, wasmByteLength,
  N, THRESHOLD, MOD, DATASET_BYTES, RESULT, RESOURCES,
} from "./waso-wasm-core.mjs";

const appSrc = readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8");
const { asm } = compile(appSrc);
const bytecode = assemble(asm);

const rendered = [];
const server = await makeInstance("server", bytecode, { [RESOURCES["db.query"]]: dbQueryHandler });
const client = await makeInstance("client", bytecode, { [RESOURCES["DOM.renderList"]]: makeRenderHandler(rendered) });

setEntryState(client.memory, THRESHOLD); // cold start on the client

const migrations = [];
let current = client;
let value = null;
while (true) {
  try {
    current.exports.run();
    value = new DataView(current.memory.buffer).getInt32(RESULT, true);
    break;
  } catch (e) {
    if (!(e instanceof Suspend)) throw e;
    const target = current === client ? server : client;
    const wire = capture(current.memory);          // slice live memory
    migrations.push({ from: current.name, to: target.name, resid: e.resid, bytes: wire.length });
    restore(target.memory, wire);                  // load into other instance
    current = target;
  }
}

// --- report ----------------------------------------------------------------
const resName = (id) => Object.keys(RESOURCES).find((k) => RESOURCES[k] === id);

console.log("Waso: TypeScript -> Waso IR -> wasm, continuation = a slice of linear memory\n");
console.log(`Authored: app.ts (compiled to ${asm.filter(Array.isArray).length} IR instrs)`);
console.log(`Module:   waso.wasm (${wasmByteLength()} bytes), one module, two instances`);
console.log(`Program:  render(threshold=${THRESHOLD})  cold-started on the CLIENT instance`);
console.log(`Dataset:  ${N.toLocaleString()} ints in the server's HEAP_BIG = ${fmt(DATASET_BYTES)}\n`);

console.log("Migrations (continuation copied out of one instance's memory into the other's):");
for (const m of migrations)
  console.log(`  ${m.from.padEnd(6)} -> ${m.to.padEnd(6)}  forced by ${resName(m.resid).padEnd(14)}  continuation = ${fmt(m.bytes)}`);
console.log("");

const s2c = migrations.find((m) => m.from === "server" && m.to === "client");
console.log(`Key claim (§11): the server->client continuation is the live wasm stack`);
console.log(`(ip + locals + operand stack + the small 'matched' heap), not the dataset.`);
console.log(`  continuation copied between instances : ${fmt(s2c.bytes)}`);
console.log(`  full dataset, had we shipped it       : ${fmt(DATASET_BYTES)}`);
console.log(`  ratio                                 : ${(DATASET_BYTES / s2c.bytes).toFixed(0)}x smaller\n`);

// --- correctness ------------------------------------------------------------
let expected = 0; for (let k = 0; k < N; k++) if (k % MOD >= THRESHOLD) expected++;
const ok = value === expected && rendered.length === expected && rendered.every((x) => x >= THRESHOLD);
console.log(`Correctness: wasm returned ${value}; DOM received ${rendered.length} items; ` +
            `matches plain JS (${expected})? ${ok ? "YES" : "NO"}`);
console.log(`Sample rendered: [${rendered.slice(0, 5).join(", ")}${rendered.length > 5 ? ", ..." : ""}]`);
if (!ok) process.exitCode = 1;

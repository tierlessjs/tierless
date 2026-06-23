// Waso wasm, two-process demo — CLIENT tier + orchestrator (parent process).
//
//   node waso-wasm-2p-client.mjs        (or: npm run wasm:2p)
//
// The full stack: app.ts -> Waso IR -> wasm, oscillating between two REAL OS
// processes, where the continuation crossing the pipe is an actual slice of
// wasm linear memory (a raw binary frame attachment). The two processes share
// no memory, so the dataset (8 MB in the server's HEAP_BIG) can only reach this
// process if it were put in a frame — which it must not be. We measure the
// bytes that actually cross each direction of the pipe to prove it doesn't.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "./waso-compile.mjs";
import {
  assemble, makeInstance, setEntryState, capture, restore, Suspend, frameCount,
  makeRenderHandler, fmt, RESULT, RESOURCES, THRESHOLD, N, MOD, wasmByteLength,
} from "./waso-wasm-core.mjs";
import { writeFrame, readFrames } from "./waso-frame.mjs";

const appSrc = readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8");
const { asm } = compile(appSrc);
const bytecode = assemble(asm);

const rendered = [];
const client = await makeInstance("client", bytecode, { [RESOURCES["DOM.renderList"]]: makeRenderHandler(rendered) });
setEntryState(client.memory, THRESHOLD); // cold start on the client

// Spawn the server process.
const serverPath = fileURLToPath(new URL("./waso-wasm-2p-server.mjs", import.meta.url));
const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });

let parentToChild = 0, childToParent = 0, biggestToClient = 0;
const send = (obj, bin) => { parentToChild += writeFrame(child.stdin, obj, bin); };

let resolveNext = null;
readFrames(child.stdout, (msg, bin, len) => {
  childToParent += len;
  biggestToClient = Math.max(biggestToClient, len);
  const r = resolveNext; resolveNext = null; r && r({ msg, bin });
});
const nextFromChild = () => new Promise((res) => { resolveNext = res; });

const migrations = [];
let meta = null;

async function main() {
  let current = "client";
  while (true) {
    if (current === "client") {
      try {
        client.exports.run();
        return finish(new DataView(client.memory.buffer).getInt32(RESULT, true));
      } catch (e) {
        if (!(e instanceof Suspend)) throw e;
        const slice = capture(client.memory);
        migrations.push({ from: "client", to: "server", resid: e.resid, bytes: slice.length, frames: frameCount(slice) });
        send({ type: "resume", resid: e.resid }, slice);
        current = "server";
      }
    } else {
      const { msg, bin } = await nextFromChild();
      if (msg.type === "error") throw new Error("server: " + msg.message);
      if (msg.type === "done") return finish(msg.value);
      if (msg.type !== "suspend") throw new Error("unexpected " + msg.type);
      meta = msg.meta;
      migrations.push({ from: "server", to: "client", resid: msg.resid, bytes: bin.length, frames: frameCount(bin) });
      restore(client.memory, bin); // load the memory slice into the client instance
      current = "client";
    }
  }
}

function finish(value) {
  send({ type: "shutdown" });
  child.stdin.end();
  report(value);
}

function report(value) {
  const datasetBytes = meta.datasetBytes;
  const resName = (id) => Object.keys(RESOURCES).find((k) => RESOURCES[k] === id);
  const s2c = migrations.find((m) => m.from === "server" && m.to === "client");

  console.log("\nWaso: app.ts -> wasm, continuation slice crossing a pipe between two OS processes\n");
  console.log(`Authored: app.ts (compiled to ${asm.filter(Array.isArray).length} IR instrs)`);
  console.log(`Module:   waso.wasm (${wasmByteLength()} bytes), one module, one instance per process`);
  console.log(`Program:  render(threshold=${THRESHOLD})  cold-started on the CLIENT process`);
  console.log(`Dataset:  ${meta.n.toLocaleString()} ints, living ONLY in the server process = ${fmt(datasetBytes)}\n`);

  console.log("Migrations (linear-memory slices crossing the pipe):");
  for (const m of migrations)
    console.log(`  ${m.from.padEnd(6)} -> ${m.to.padEnd(6)}  forced by ${resName(m.resid).padEnd(14)}  ${m.frames} frame(s), continuation = ${fmt(m.bytes)}`);
  console.log("");

  console.log(`Key claim (§11): the server->client continuation is the live wasm stack,`);
  console.log(`not the heap. The dataset stayed in the server process's HEAP_BIG.`);
  console.log(`  continuation crossing the pipe  : ${fmt(s2c.bytes)}`);
  console.log(`  full dataset, had we shipped it : ${fmt(datasetBytes)}`);
  console.log(`  ratio                           : ${(datasetBytes / s2c.bytes).toFixed(0)}x smaller\n`);

  console.log("Real bytes measured on the pipe:");
  console.log(`  parent -> child total : ${fmt(parentToChild)}`);
  console.log(`  child -> parent total : ${fmt(childToParent)}`);
  console.log(`  largest single frame to client : ${fmt(biggestToClient)}  (<< ${fmt(datasetBytes)} dataset)\n`);

  let expected = 0; for (let k = 0; k < N; k++) if (k % MOD >= THRESHOLD) expected++;
  const ok = value === expected && rendered.length === expected &&
             rendered.every((x) => x >= THRESHOLD) && childToParent < datasetBytes / 10;
  console.log(`Correctness: wasm returned ${value}; DOM received ${rendered.length} items; ` +
              `matches plain JS (${expected})? ${ok ? "YES" : "NO"}`);
  console.log(`Sample rendered: [${rendered.slice(0, 5).join(", ")}${rendered.length > 5 ? ", ..." : ""}]`);
  console.log(`Dataset never crossed the pipe? ${childToParent < datasetBytes / 10 ? "YES" : "NO"}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

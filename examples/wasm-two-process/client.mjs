// Stackmix wasm — CLIENT tier + orchestrator.
//
//   node examples/wasm-two-process/client.mjs        (or: npm run wasm:2p)
//
// app.ts -> Stackmix IR -> wasm, oscillating between a client and a server tier
// (two independent wasm instances, no shared memory) over a REAL WebSocket. The
// continuation crossing the socket is an actual slice of wasm linear memory (a
// binary message attachment). The dataset lives only in the server instance's
// HEAP_BIG and must never ride a continuation; we measure the bytes on the wire
// to prove it doesn't.
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wsPort, makePeer } from "#stackmix";
import { compile } from "#stackmix/wasm/compile.mjs";
import {
  assemble, makeInstance, setEntryState, capture, restore, Suspend, frameCount,
  makeRenderHandler, fmt, RESULT, RESOURCES, THRESHOLD, N, MOD, wasmByteLength,
} from "#stackmix/wasm/core.mjs";
import { startServer } from "./server.mjs";

const appSrc = readFileSync(fileURLToPath(new URL("../shared/app.ts", import.meta.url)), "utf8");
const { asm } = compile(appSrc);
const bytecode = assemble(asm);

const rendered = [];
const resName = (id) => Object.keys(RESOURCES).find((k) => RESOURCES[k] === id);
const migrations = [];

// Count the real bytes per direction on the wire.
const byteLen = (d) => (d == null ? 0 : d.byteLength != null ? d.byteLength : d.length != null ? d.length : 0);
let toServer = 0, toClient = 0, biggestToClient = 0;
class CountingWS extends WebSocket {
  constructor(...a) {
    super(...a);
    this.addEventListener("message", (ev) => { const n = byteLen(ev.data); toClient += n; biggestToClient = Math.max(biggestToClient, n); });
  }
  send(data) { toServer += byteLen(data); return super.send(data); }
}

function openPeer(url) {
  const ws = new CountingWS(url);
  const peer = makePeer(wsPort(ws));
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ peer, close: () => peer.close() }));
    ws.addEventListener("error", (e) => reject(new Error((e && e.message) || "ws error")));
  });
}

async function main() {
  const client = await makeInstance("client", bytecode, { [RESOURCES["DOM.renderList"]]: makeRenderHandler(rendered) });
  setEntryState(client.memory, THRESHOLD); // cold start on the client

  const { wss, port } = await startServer(0);
  const { peer, close } = await openPeer(`ws://127.0.0.1:${port}`);

  let meta = null, value;
  while (true) {
    try {
      client.exports.run();
      value = new DataView(client.memory.buffer).getInt32(RESULT, true);
      break;
    } catch (e) {
      if (!(e instanceof Suspend)) throw e;
      const slice = capture(client.memory);
      migrations.push({ from: "client", to: "server", resid: e.resid, bytes: slice.length, frames: frameCount(slice) });
      const { obj, bin } = await peer.request({ type: "resume", resid: e.resid }, slice);
      if (obj.type === "error") throw new Error("server: " + obj.message);
      if (obj.type === "done") { value = obj.value; break; }
      if (obj.type !== "suspend") throw new Error("unexpected " + obj.type);
      meta = obj.meta;
      migrations.push({ from: "server", to: "client", resid: obj.resid, bytes: bin.length, frames: frameCount(bin) });
      restore(client.memory, bin); // load the returned memory slice into the client instance
    }
  }

  close();
  wss.close();
  report(value, meta);
}

function report(value, meta) {
  const datasetBytes = meta.datasetBytes;
  const s2c = migrations.find((m) => m.from === "server" && m.to === "client");

  console.log("\nStackmix: app.ts -> wasm, continuation slice crossing a real WebSocket (two instances, no shared memory)\n");
  console.log(`Authored: app.ts (compiled to ${asm.filter(Array.isArray).length} IR instrs)`);
  console.log(`Module:   interpreter.wasm (${wasmByteLength()} bytes), one module, one instance per tier`);
  console.log(`Program:  render(threshold=${THRESHOLD})  cold-started on the CLIENT`);
  console.log(`Dataset:  ${meta.n.toLocaleString()} ints, living ONLY in the server instance = ${fmt(datasetBytes)}\n`);

  console.log("Migrations (linear-memory slices crossing the socket):");
  for (const m of migrations)
    console.log(`  ${m.from.padEnd(6)} -> ${m.to.padEnd(6)}  forced by ${resName(m.resid).padEnd(14)}  ${m.frames} frame(s), continuation = ${fmt(m.bytes)}`);
  console.log("");

  console.log(`Key claim (§11): the server->client continuation is the live wasm stack, not the heap.`);
  console.log(`  continuation crossing the socket : ${fmt(s2c.bytes)}`);
  console.log(`  full dataset, had we shipped it  : ${fmt(datasetBytes)}`);
  console.log(`  ratio                            : ${(datasetBytes / s2c.bytes).toFixed(0)}x smaller\n`);

  console.log("Real bytes measured on the wire:");
  console.log(`  client -> server total : ${fmt(toServer)}`);
  console.log(`  server -> client total : ${fmt(toClient)}`);
  console.log(`  largest single message to client : ${fmt(biggestToClient)}  (<< ${fmt(datasetBytes)} dataset)\n`);

  let expected = 0; for (let k = 0; k < N; k++) if (k % MOD >= THRESHOLD) expected++;
  const ok = value === expected && rendered.length === expected &&
             rendered.every((x) => x >= THRESHOLD) && toClient < datasetBytes / 10;
  console.log(`Correctness: wasm returned ${value}; DOM received ${rendered.length} items; matches plain JS (${expected})? ${ok ? "YES" : "NO"}`);
  console.log(`Sample rendered: [${rendered.slice(0, 5).join(", ")}${rendered.length > 5 ? ", ..." : ""}]`);
  console.log(`Dataset stayed server-side (never crossed the socket)? ${toClient < datasetBytes / 10 ? "YES" : "NO"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

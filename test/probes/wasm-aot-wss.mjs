// Probe: does a *compiled-AOT* continuation migrate over a REAL WebSocket?
// (ties the two halves of the wasm work together: the IR->WASM+Asyncify codegen
//  from probes/wasm-aot.mjs, shipped over the transport from src/runtime/wss.mjs)
//
// One AOT-compiled program (main -> inner -> RES "resource") cold-starts on a
// CLIENT wasm instance that lacks the resource. At the RES it Asyncify-unwinds;
// the continuation blob (a slice of linear memory) crosses a real ws connection
// as the binary attachment of a `resume` message; the SERVER restores it into a
// fresh instance of the same module, rewinds with the resource resolved, runs to
// completion, and ships the result back. Same wsPort/makePeer transport the JS
// path uses — only the payload is a compiled continuation instead of a JS graph.

import { WebSocketServer, WebSocket } from "ws";
import { wsPort, makePeer } from "#stackmix";
import { compileToWasm } from "#stackmix/wasm/aot.mjs";

const DATA_PTR = 16, STACK_BASE = 1024, STACK_END = 8192, RES_VALUE = 42;
const EXPECT = 100 + (10 + RES_VALUE); // main = y + (x + resource) = 152

const program = {
  inner: { argc: 0, nlocals: 2, code: [
    ["PUSH", 10], ["STORE", 0], ["RES", "resource", 0], ["STORE", 1], ["LOAD", 0], ["LOAD", 1], ["ADD"], ["RET"],
  ] },
  main: { argc: 0, nlocals: 2, code: [
    ["PUSH", 100], ["STORE", 0], ["CALL", "inner", 0], ["STORE", 1], ["LOAD", 0], ["LOAD", 1], ["ADD"], ["RET"],
  ] },
};
const bytes = compileToWasm(program, { entry: "main", resources: ["resource"] });

function aotInstance(onResource) {
  const holder = {};
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { resource: () => onResource(holder.ex) } });
  holder.ex = inst.exports;
  return inst.exports;
}
const seti32 = (mem, a, v) => new DataView(mem.buffer).setInt32(a, v, true);

async function main() {
  // SERVER: each `resume` restores the continuation into a fresh instance (it
  // HAS the resource), rewinds, runs to completion, and returns the result.
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (socket) => {
    const peer = makePeer(wsPort(socket));
    peer.on("resume", (_req, bin) => {
      const ex = aotInstance((e) => { if (e.asyncify_get_state() === 2) e.asyncify_stop_rewind(); return RES_VALUE; });
      new Uint8Array(ex.memory.buffer).set(bin);     // load the continuation slice
      ex.asyncify_start_rewind(DATA_PTR);
      return { obj: { value: ex.main() } };
    });
  });
  const port = await new Promise((res) => wss.on("listening", () => res(wss.address().port)));

  // CLIENT: cold-start; at the RES, Asyncify-unwind and capture the blob.
  const client = aotInstance((e) => { e.asyncify_start_unwind(DATA_PTR); return 0; });
  seti32(client.memory, DATA_PTR, STACK_BASE);
  seti32(client.memory, DATA_PTR + 4, STACK_END);
  client.main();
  client.asyncify_stop_unwind();
  const blob = new Uint8Array(client.memory.buffer, 0, STACK_END).slice();

  // Migrate the blob over a real WebSocket.
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const peer = makePeer(wsPort(ws));
  const { obj } = await peer.request({ type: "resume" }, blob);
  peer.close();
  wss.close();

  const ok = obj.value === EXPECT;
  console.log(`\nStackmix — a COMPILED (IR->WASM+Asyncify) continuation migrated over a real WebSocket\n`);
  console.log(`  client cold-started, suspended at the RES, shipped ${blob.length} B of linear memory`);
  console.log(`  server resumed it in a fresh instance and returned ${obj.value} (expected ${EXPECT})\n`);
  console.log(`Result: ${ok ? "ALL PASS" : "FAILURES"} — a compiled continuation migrated over a real WebSocket and resumed`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Stackmix wasm — SERVER tier. Owns db.query and the large dataset (in its wasm
// instance's HEAP_BIG). Receives a continuation as a raw linear-memory slice (a
// binary ws-message attachment), restores it into its instance, runs, and replies
// with either the next slice or the final result. Exposed as startServer() so the
// client can stand one up in-process; also runnable standalone.
import { WebSocketServer } from "ws";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wsPort, makePeer } from "#stackmix";
import { compile } from "#stackmix/wasm/compile.mjs";
import {
  assemble, makeInstance, capture, restore, Suspend, dbQueryHandler,
  RESULT, RESOURCES, DATASET_BYTES, N,
} from "#stackmix/wasm/core.mjs";

const appSrc = readFileSync(fileURLToPath(new URL("../shared/app.ts", import.meta.url)), "utf8");
const bytecode = assemble(compile(appSrc).asm);

export function startServer(port = 0) {
  const wss = new WebSocketServer({ port });
  wss.on("connection", (socket) => {
    const peer = makePeer(wsPort(socket));
    let instP = null;                                        // one wasm instance per connection (its own HEAP_BIG)
    const getServer = () => (instP ||= makeInstance("server", bytecode, { [RESOURCES["db.query"]]: dbQueryHandler }));
    peer.on("resume", async (_req, bin) => {
      const server = await getServer();
      restore(server.memory, bin);                           // load the continuation slice into linear memory
      try {
        server.exports.run();
        return { obj: { type: "done", value: new DataView(server.memory.buffer).getInt32(RESULT, true) } };
      } catch (e) {
        if (!(e instanceof Suspend)) return { obj: { type: "error", message: String((e && e.message) || e) } };
        return { obj: { type: "suspend", resid: e.resid, meta: { datasetBytes: DATASET_BYTES, n: N } }, bin: capture(server.memory) }; // dataset in HEAP_BIG is NOT in here
      }
    });
  });
  return new Promise((resolve) => wss.on("listening", () => resolve({ wss, port: wss.address().port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer(Number(process.env.PORT) || 0).then(({ port }) => console.log("PORT " + port));
}

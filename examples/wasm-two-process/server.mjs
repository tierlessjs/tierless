// Stackmix wasm, two-process demo — SERVER tier (child process).
//
// Owns db.query and the large dataset (in its own wasm instance's HEAP_BIG).
// Receives a continuation as a raw linear-memory slice (the binary attachment
// of a frame), restores it into its instance, runs, and sends back either the
// next continuation slice or the final result. All logging -> stderr so it can
// never corrupt the binary frame stream on stdout.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "#stackmix/wasm/compile.mjs";
import {
  assemble, makeInstance, capture, restore, Suspend, dbQueryHandler,
  fmt, RESULT, RESOURCES, DATASET_BYTES, N,
} from "#stackmix/wasm/core.mjs";
import { writeFrame, readFrames } from "#stackmix/runtime/frame.mjs";

const appSrc = readFileSync(fileURLToPath(new URL("../shared/app.ts", import.meta.url)), "utf8");
const bytecode = assemble(compile(appSrc).asm);

const server = await makeInstance("server", bytecode, { [RESOURCES["db.query"]]: dbQueryHandler });

readFrames(process.stdin, (msg, bin) => {
  if (msg.type === "shutdown") process.exit(0);
  if (msg.type !== "resume") { console.error("server: unexpected", msg.type); return; }

  restore(server.memory, bin); // load the continuation slice into linear memory
  try {
    server.exports.run();
    const value = new DataView(server.memory.buffer).getInt32(RESULT, true);
    writeFrame(process.stdout, { type: "done", value });
  } catch (e) {
    if (!(e instanceof Suspend)) {
      console.error("server: error", e);
      writeFrame(process.stdout, { type: "error", message: String(e && e.message || e) });
      return;
    }
    const slice = capture(server.memory); // the dataset in HEAP_BIG is NOT in here
    console.error(`server: suspending for ${Object.keys(RESOURCES).find(k => RESOURCES[k] === e.resid)}; ` +
      `shipping ${fmt(slice.length)} (dataset ${fmt(DATASET_BYTES)} stays here)`);
    writeFrame(process.stdout, { type: "suspend", resid: e.resid, meta: { datasetBytes: DATASET_BYTES, n: N } }, slice);
  }
});

process.stdin.resume();
console.error(`server: ready (${N.toLocaleString()} rows, dataset ${fmt(DATASET_BYTES)} in HEAP_BIG)`);

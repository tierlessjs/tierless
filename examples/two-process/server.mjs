// Stackmix — two-process demo, SERVER tier (child process).
//
// Spawned by stackmix-2p-client.mjs. Owns db.query and the large dataset. Reads
// continuation frames from stdin, resumes them on the server tier, and writes
// the result (or the next continuation) back on stdout. All logging goes to
// stderr so it can never corrupt the binary frame stream on stdout.

import {
  Tier, run, Suspend, serializeContinuation, deserializeContinuation,
  wireHandles, makeDataset, fmt,
} from "#stackmix/runtime/core.mjs";
import { writeFrame, readFrames } from "#stackmix/runtime/frame.mjs";

const N = 100_000;
const PEOPLE = makeDataset(N);
const fullResultBytes = Buffer.byteLength(JSON.stringify(PEOPLE)); // measurement only

const server = new Tier("server", {
  "db.query": ([table]) => { if (table !== "people") throw new Error("no table " + table); return PEOPLE; },
});

// This process can only resolve handles it owns. A handle owned by the client
// would require a fetch back across the pipe — not needed by this demo, so we
// fail loudly rather than silently returning wrong data.
const host = {
  deref(h) {
    if (h.owner !== server.id) throw new Error(`server cannot deref ${h.owner} handle ${h.id} (cross-process fetch not implemented)`);
    return server.heapGet(h.id);
  },
};

readFrames(process.stdin, (msg) => {
  if (msg.type === "shutdown") { process.exit(0); }
  if (msg.type !== "resume") { console.error("server: unexpected", msg.type); return; }

  const got = deserializeContinuation(msg.wire);
  let frames = got.frames;
  let pending = got.pending;

  try {
    if (pending) { // run the resource that forced the migration here (db.query)
      frames[frames.length - 1].stack.push(server.resources[pending.name](pending.args));
    }
    const result = run(server, frames, host);
    writeFrame(process.stdout, { type: "done", value: result.value });
  } catch (e) {
    if (!(e instanceof Suspend)) {
      console.error("server: error", e);
      writeFrame(process.stdout, { type: "error", message: String(e && e.message || e) });
      return;
    }
    // Forced back to the client. Serialize with the server as source tier, so
    // the big rows array becomes a §5 handle into THIS process's heap and never
    // crosses the pipe.
    const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, server);
    const handles = wireHandles(wire); // sanity: the big rows array must have stayed as a handle
    console.error(`server: suspending for ${e.pending.name}; ${handles.length} handle(s) stayed here ` +
      `(dataset ${fmt(fullResultBytes)} did not cross)`);
    writeFrame(process.stdout, { type: "suspend", wire, meta: { fullResultBytes, n: N } });
  }
});

process.stdin.resume();
console.error(`server: ready (${N.toLocaleString()} rows, full set ${fmt(fullResultBytes)})`);

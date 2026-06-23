// Capstone — SERVER tier (child process). Owns db.items / db.title. Runs the
// migrated continuation of a program compiled from real TypeScript.
import { Tier, run, Suspend, serializeContinuation, deserializeContinuation } from "./waso-core.mjs";
import { writeFrame, readFrames } from "./waso-frame.mjs";
import { N } from "./app-thread.mjs"; // also registers the compiled program into PROGRAM

const server = new Tier("server", {
  "db.items": () => Array.from({ length: N }, (_, i) => i),
  "db.title": ([id]) => "Title #" + id,
});
const host = { deref(h) { if (h.owner === "server") return server.heap.get(h.id); throw new Error("server can't deref " + h.owner); } };

readFrames(process.stdin, (msg) => {
  if (msg.type === "shutdown") process.exit(0);
  if (msg.type !== "resume") return;
  const got = deserializeContinuation(msg.wire);
  let frames = got.frames;
  try {
    if (got.pending) frames[frames.length - 1].stack.push(server.resources[got.pending.name](got.pending.args));
    const res = run(server, frames, host);
    writeFrame(process.stdout, { type: "done", value: res.value });
  } catch (e) {
    if (!(e instanceof Suspend)) { writeFrame(process.stdout, { type: "error", message: String(e && e.message || e) }); return; }
    const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, server); // ui.render -> back to client
    writeFrame(process.stdout, { type: "suspend", wire });
  }
});
process.stdin.resume();
console.error("server: ready (db.items/db.title)");

// Cross-process fetch demo — SERVER tier (child process).
//
// Owns db.profile (a big object). Runs migrated continuations; when forced back
// to the client it serializes with itself as source, so the big profile becomes
// a §5 handle into THIS process's heap and does NOT cross. Later, if the client
// dereferences that handle, it sends a {fetch} request and we ship the object
// then — on demand — encoded with the identity/cycle-safe graph codec.

import { Tier, run, Suspend, serializeContinuation, deserializeContinuation } from "./waso-core.mjs";
import { encodeGraph } from "./waso-heap.mjs";
import { writeFrame, readFrames } from "./waso-frame.mjs";
import "./app-profile.mjs";

const BIO = 120_000; // > HANDLE_THRESHOLD, so the profile becomes a handle on migrate
const server = new Tier("server", {
  "db.profile": ([id]) => ({ id, name: "Profile " + id, bio: "X".repeat(BIO) }),
});
const host = { deref(h) { if (h.owner === "server") return server.heap.get(h.id); throw new Error("server can't deref " + h.owner); } };

readFrames(process.stdin, (msg, bin) => {
  if (msg.type === "shutdown") process.exit(0);

  if (msg.type === "fetch") {                       // on-demand handle deref from the client
    const obj = server.heap.get(msg.id);
    const graph = Buffer.from(JSON.stringify(encodeGraph([obj])), "utf8");
    console.error(`server: fetch ${msg.id} -> shipping ${graph.length} B (the bio crosses only now)`);
    writeFrame(process.stdout, { type: "fetchResult" }, graph);
    return;
  }

  if (msg.type === "resume") {
    const got = deserializeContinuation(msg.wire);
    let frames = got.frames;
    try {
      if (got.pending) frames[frames.length - 1].stack.push(server.resources[got.pending.name](got.pending.args));
      const res = run(server, frames, host);
      writeFrame(process.stdout, { type: "done", value: res.value });
    } catch (e) {
      if (!(e instanceof Suspend)) { writeFrame(process.stdout, { type: "error", message: String(e && e.message || e) }); return; }
      // Forced to the client (render). Serialize here: the big profile becomes a
      // handle in this process's heap and stays put.
      const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, server);
      console.error(`server: migrating back for ${e.pending.name}; profile stayed as a handle (not shipped)`);
      writeFrame(process.stdout, { type: "suspend", wire });
    }
  }
});

process.stdin.resume();
console.error(`server: ready (profile bio = ${BIO} B)`);

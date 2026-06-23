// Runs app.ts across two in-process tiers, migrating the live continuation
// whenever it touches a resource the current tier doesn't have. Replace the two
// in-process tiers with two real processes (a socket carrying the serialized
// continuation between them) and the same program spans machines — see the
// Stackmix examples/ for the cross-process and benchmark versions.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createRuntime, Tier, Suspend,
  serializeContinuation, deserializeContinuation, initialFrames,
} from "stackmix";

const src = readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8");

const rt = createRuntime();
rt.load(src, { entry: "main", resources: ["db.products", "ui.show"] });

const shown = [];
const server = new Tier("server", {
  "db.products": () => [
    { name: "Pencil", price: 2 },
    { name: "Standing desk", price: 220 },
    { name: "Mug", price: 12 },
    { name: "Chair", price: 80 },
  ],
});
const client = new Tier("client", {
  "ui.show": ([lines]) => { for (const l of lines) shown.push(l); return lines.length; },
});
const tiers = [server, client];
const host = { deref: (x) => x };

// The oscillator: run on the current tier; when the program suspends at a resource
// this tier lacks, serialize the continuation, migrate it to the tier that has the
// resource, and resume. The big product list never leaves the server.
let current = client;
let frames = initialFrames("main", []);
let pending = null;
while (true) {
  try {
    if (pending) {
      frames[frames.length - 1].stack.push(current.resources[pending.name](pending.args));
      pending = null;
    }
    const { value } = rt.run(current, frames, host);
    console.log(`main() returned ${value}; the client rendered:`);
    for (const line of shown) console.log("  - " + line);
    break;
  } catch (e) {
    if (!(e instanceof Suspend)) throw e;
    const target = tiers.find((t) => t.id !== current.id && t.has(e.pending.name));
    const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, current);
    const got = deserializeContinuation(JSON.parse(JSON.stringify(wire))); // detach, as a socket would
    frames = got.frames;
    pending = got.pending;
    current = target;
    console.error(`(migrated to ${target.id} for ${e.pending.name})`);
  }
}

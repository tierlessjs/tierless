// Stackmix — minimal spike, single process (design doc §11)
//
// Proves the ONE core claim: a continuation captured at a resource boundary
// serializes *small*, while the data needed to reconstruct the computation
// stays tier-local. Here the two tiers are isolated runtime instances in one
// process (the doc explicitly allows "two WASM instances"); every migration
// still goes through the real wire format, so the measured bytes are genuine.
// For a true OS-process boundary, see stackmix-2p-client.mjs.
//
//   node stackmix-spike.mjs

import {
  Tier, run, Suspend, serializeContinuation, deserializeContinuation, contBytes,
  initialFrames, makeDataset, fmt,
} from "#stackmix/runtime/core.mjs";

const N = 100_000;
const PEOPLE = makeDataset(N);
const rendered = [];

const server = new Tier("server", {
  "db.query": ([table]) => { if (table !== "people") throw new Error("no table " + table); return PEOPLE; },
});
const client = new Tier("client", {
  "DOM.renderList": ([items]) => { for (const it of items) rendered.push(it); return items.length; },
});
const allTiers = { server, client };

// On-demand handle fetch (§5). In one process we can read the owning tier's
// heap directly; we still count the bytes a real fetch would have moved.
let FETCH_BYTES = 0;
const host = {
  deref(h) { FETCH_BYTES += h.bytes; return allTiers[h.owner].heapGet(h.id); },
};

// The oscillator: drive the program, migrating whenever it suspends.
function oscillate(entry, args, startTier) {
  const migrations = [];
  let current = startTier;
  let frames = initialFrames(entry, args);
  let pending = null;
  while (true) {
    try {
      if (pending) { // resuming from a migration: run the pending resource here
        frames[frames.length - 1].stack.push(current.resources[pending.name](pending.args));
        pending = null;
      }
      return { value: run(current, frames, host).value, migrations };
    } catch (e) {
      if (!(e instanceof Suspend)) throw e;
      const target = Object.values(allTiers).find((t) => t.id !== current.id && t.has(e.pending.name));
      if (!target) throw new Error("no tier provides resource " + e.pending.name);

      const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, current);
      const bytes = contBytes(wire);
      migrations.push({ from: current.id, to: target.id, resource: e.pending.name, bytes });

      // Round-trip through JSON to detach from the source heap, exactly as a
      // socket would. (The big array is already a handle inside `wire`.)
      const got = deserializeContinuation(JSON.parse(JSON.stringify(wire)));
      frames = got.frames;
      pending = got.pending;
      current = target;
    }
  }
}

const minAge = 99; // selective: keeps ~1% of rows
const { value, migrations } = oscillate("render", [minAge], client);

// --- measurements ---
const fullResultBytes = Buffer.byteLength(JSON.stringify(PEOPLE));
const totalCrossed = migrations.reduce((s, m) => s + m.bytes, 0);

console.log("Stackmix spike (single process) — continuation size vs. shipping the result set\n");
console.log(`Program: render(minAge=${minAge})  cold-started on the CLIENT tier`);
console.log(`Dataset: ${N.toLocaleString()} rows on the server`);
console.log(`Full result set (if shipped to the client): ${fmt(fullResultBytes)}\n`);

console.log("Migrations (each continuation went through JSON->bytes->JSON):");
for (const m of migrations)
  console.log(`  ${m.from.padEnd(6)} -> ${m.to.padEnd(6)}  forced by ${m.resource.padEnd(14)}  continuation = ${fmt(m.bytes)}`);
console.log("");

const s2c = migrations.find((m) => m.from === "server" && m.to === "client");
console.log(`Key claim (§11): the server->client continuation carries the live stack,`);
console.log(`not the heap. The ${N.toLocaleString()}-row array stays server-side as a §5 handle;`);
console.log(`only the ${value} matched strings travel.`);
console.log(`  continuation crossing the wire : ${fmt(s2c.bytes)}`);
console.log(`  full result set, had we shipped : ${fmt(fullResultBytes)}`);
console.log(`  ratio                          : ${(fullResultBytes / s2c.bytes).toFixed(0)}x smaller\n`);
console.log(`Total bytes that crossed the wire (both migrations): ${fmt(totalCrossed)}`);
console.log(`On-demand handle fetches (§5 chattiness):           ${fmt(FETCH_BYTES)}\n`);

// --- correctness check ---
const expected = PEOPLE.filter((p) => p.age >= minAge).map((p) => `${p.name} (${p.age})`);
const ok = value === expected.length && rendered.length === expected.length &&
           rendered[0] === expected[0] && rendered[rendered.length - 1] === expected[expected.length - 1];
console.log(`Correctness: render returned ${value}; DOM received ${rendered.length} items; ` +
            `matches plain JS result? ${ok ? "YES" : "NO"}`);
console.log(`Sample rendered: ${rendered.slice(0, 3).join(", ")} ...`);
if (!ok) process.exitCode = 1;

// Probe: async-as-suspension (#3) + the serializability payoff.
//
// Models `await` as a suspension point: a resource call returns an awaitable
// descriptor, the AWAIT op suspends, and the host resolves it (doing real async
// work) before resuming. Because we own the continuation, an await-suspended
// computation is SERIALIZABLE — we round-trip it through JSON at every await and
// it still completes correctly. Native async/await cannot do this: a paused
// async function's state is engine-internal. That gap is exactly why #4 must own
// the transform (NOTES-frontend.md), and the same mechanism is what lets a
// cross-process handle fetch resume a synchronous interpreter.

import { PROGRAM, run, Suspend, serializeContinuation, deserializeContinuation, contBytes, initialFrames, Tier, awaitable } from "./waso-core.mjs";

// async function loadUser(id) {
//   const u = await db.fetchUser(id);          // RES returns a descriptor; AWAIT suspends
//   const posts = await db.fetchPosts(u.id);
//   return { name: u.name, postCount: posts.length };
// }
// locals: 0 id, 1 u, 2 posts
PROGRAM.loadUser = {
  nlocals: 3,
  code: [
    ["LOAD", 0], ["RES", "db.fetchUser", 1], ["AWAIT"], ["STORE", 1],
    ["LOAD", 1], ["GETPROP", "id"], ["RES", "db.fetchPosts", 1], ["AWAIT"], ["STORE", 2],
    ["NEWOBJ"],
    ["LOAD", 1], ["GETPROP", "name"], ["SETPROP", "name"],
    ["LOAD", 2], ["GETPROP", "length"], ["SETPROP", "postCount"],
    ["RET"],
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The host's async resolver: real awaiting happens here, while the interpreter
// is suspended. A real frontend would resolve a Promise; we resolve a descriptor.
async function resolve(desc) {
  await sleep(3);
  if (desc.op === "fetchUser") return { id: desc.id, name: "User#" + desc.id };
  if (desc.op === "fetchPosts") return ["p1", "p2", "p3"];
  throw new Error("unknown op " + desc.op);
}

const tier = new Tier("server", {
  "db.fetchUser":  ([id]) => awaitable({ op: "fetchUser", id }),   // genuine async value -> AWAIT suspends
  "db.fetchPosts": ([id]) => awaitable({ op: "fetchPosts", id }),
});

// Async orchestrator. `roundtrip` serializes the continuation at EVERY await and
// resumes from the bytes — i.e. runs the whole async program through the wire.
async function runAsync(entry, args, { roundtrip = false } = {}) {
  const host = { deref() { throw new Error("no handles here"); } };
  let frames = initialFrames(entry, args);
  let awaits = 0, maxWire = 0;
  while (true) {
    let res;
    try { res = run(tier, frames, host); }
    catch (e) {
      if (!(e instanceof Suspend)) throw e;
      awaits++;
      let f = e.frames, pend = e.pending;
      if (roundtrip) {                                   // <-- cross a serialization boundary at the await
        const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, tier);
        maxWire = Math.max(maxWire, contBytes(wire));
        const got = deserializeContinuation(JSON.parse(JSON.stringify(wire)));
        f = got.frames; pend = got.pending;
      }
      if (pend && "awaitAll" in pend) {                  // Promise.all: resolve every pending element CONCURRENTLY
        const resolved = await Promise.all(pend.awaitAll.map(resolve));
        const result = pend.result.slice(); pend.pendingIdx.forEach((idx, k) => { result[idx] = resolved[k]; });
        f[f.length - 1].stack.push(result);
      } else if (pend && "await" in pend) {
        f[f.length - 1].stack.push(await resolve(pend.await)); // real async work while suspended
      } else throw new Error("unexpected non-await suspension");
      frames = f;
      continue;
    }
    return { value: res.value, awaits, maxWire };
  }
}

let pass = true;
const check = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); pass &&= cond; };

console.log("Probe: async-as-suspension + serializable continuations\n");

const plain = await runAsync("loadUser", [7]);
check(`async program runs on the runtime (result ${JSON.stringify(plain.value)})`,
  plain.value.name === "User#7" && plain.value.postCount === 3);
check(`it actually suspended and resumed at each await (${plain.awaits} awaits)`, plain.awaits === 2);

const viaWire = await runAsync("loadUser", [7], { roundtrip: true });
check("the SAME program runs end-to-end through serialize/deserialize at every await",
  JSON.stringify(viaWire.value) === JSON.stringify(plain.value));
check(`the await-suspended continuation is small and real (${viaWire.maxWire} B on the wire)`, viaWire.maxWire > 0 && viaWire.maxWire < 4096);

// Promise.all resolves its elements CONCURRENTLY (one suspension carrying all the
// pending awaitables), not one-at-a-time. Proven by max-in-flight (timing-independent).
const { loadModule } = await import("./waso-tsc.mjs");
loadModule(PROGRAM, `
  async function go() { const us = await Promise.all([db.fetchUser(1), db.fetchUser(2), db.fetchUser(3)]); return us.map((u) => u.name); }
`, { entry: "go", resources: ["db.fetchUser"] });
let inFlight = 0, maxInFlight = 0;
async function resolveTracked(desc) { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(5); inFlight--; return { id: desc.id, name: "User#" + desc.id }; }
async function runConcurrent() {
  let frames = initialFrames("go", []); const host = { deref: (x) => x };
  while (true) {
    let res; try { res = run(tier, frames, host); }
    catch (e) {
      if (!(e instanceof Suspend) || !("awaitAll" in e.pending)) throw e;
      const resolved = await Promise.all(e.pending.awaitAll.map(resolveTracked));
      const result = e.pending.result.slice(); e.pending.pendingIdx.forEach((idx, k) => { result[idx] = resolved[k]; });
      e.frames[e.frames.length - 1].stack.push(result); frames = e.frames; continue;
    }
    return res.value;
  }
}
const conc = await runConcurrent();
check(`Promise.all result correct (${JSON.stringify(conc)})`, JSON.stringify(conc) === JSON.stringify(["User#1", "User#2", "User#3"]));
check(`Promise.all resolved its 3 elements CONCURRENTLY (max in-flight = ${maxInFlight})`, maxInFlight === 3);

// Contrast: native async state is NOT serializable.
const pausedNative = (async () => { await sleep(10_000); return 42; })(); // a paused async fn === a Promise
check("native async: a paused async function serializes to nothing (JSON = '{}')", JSON.stringify(pausedNative) === "{}");

console.log(`\nResult: ${pass ? "all PASS" : "FAILURES"} — await is just a suspension point; because we own`);
console.log(`the continuation, the async computation migrates across a serialization boundary.`);
console.log(`Same mechanism resolves a remote handle fetch (resume a sync interpreter after async I/O).`);
if (!pass) process.exitCode = 1;

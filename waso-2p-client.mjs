// Waso — two-process demo, CLIENT tier + orchestrator (parent process).
//
//   node waso-2p-client.mjs
//
// Spawns waso-2p-server.mjs as a child and oscillates one program between the
// two REAL OS processes over a pipe. Unlike the single-process spike, the two
// tiers share no memory: a §5 handle owned by the server genuinely cannot be
// read here, and the only way the big dataset could reach this process is if it
// were serialized into a frame — which it must not be. We measure the bytes
// that actually cross each direction of the pipe to prove it doesn't.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  Tier, run, Suspend, serializeContinuation, deserializeContinuation, contBytes,
  initialFrames, isHandle, fmt,
} from "./waso-core.mjs";
import { writeFrame, readFrames } from "./waso-frame.mjs";

const rendered = [];
const client = new Tier("client", {
  "DOM.renderList": ([items]) => { for (const it of items) rendered.push(it); return items.length; },
});
// The client owns no server data; any handle it holds is server-owned and would
// require a fetch. This demo never derefs one, so make a mistake loud.
const host = {
  deref(h) { throw new Error(`client cannot deref ${h.owner} handle ${h.id} (cross-process fetch not implemented; demo shouldn't need it)`); },
};

const serverPath = fileURLToPath(new URL("./waso-2p-server.mjs", import.meta.url));
const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });

// Wire accounting: real bytes per direction of the pipe.
let parentToChild = 0, childToParent = 0, biggestFrameToClient = 0;
const send = (obj) => { parentToChild += writeFrame(child.stdin, obj); };

// Strict ping-pong: send a frame, await the child's reply.
let resolveNext = null;
readFrames(child.stdout, (msg, len) => {
  childToParent += len;
  biggestFrameToClient = Math.max(biggestFrameToClient, len);
  const r = resolveNext; resolveNext = null; r && r(msg);
});
const nextFromChild = () => new Promise((res) => { resolveNext = res; });

const minAge = 99;
const migrations = [];
let meta = null;

async function main() {
  let frames = initialFrames("render", [minAge]);
  let pending = null;

  while (true) {
    try {
      if (pending) { // run a resource we have locally (DOM.renderList) on arrival
        frames[frames.length - 1].stack.push(client.resources[pending.name](pending.args));
        pending = null;
      }
      const result = run(client, frames, host); // finishes on the client
      finish(result.value);
      return;
    } catch (e) {
      if (!(e instanceof Suspend)) throw e;
      // Client lacks this resource (db.query) -> migrate to the server process.
      const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, client);
      const bytes = contBytes(wire);
      migrations.push({ from: "client", to: "server", resource: e.pending.name, bytes });
      send({ type: "resume", wire });

      const msg = await nextFromChild();
      if (msg.type === "error") throw new Error("server: " + msg.message);
      if (msg.type === "done") { finish(msg.value); return; }
      if (msg.type !== "suspend") throw new Error("unexpected " + msg.type);

      meta = msg.meta;
      const back = contBytes(msg.wire);
      migrations.push({ from: "server", to: "client", resource: msg.wire.pending.name, bytes: back });

      // Prove the big array did NOT come back: the rows local must be a handle.
      const rowsLocal = msg.wire.frames[0].locals[1];
      if (!isHandle(rowsLocal)) throw new Error("FAIL: server shipped the rows array inline!");

      const got = deserializeContinuation(msg.wire);
      frames = got.frames;
      pending = got.pending;
    }
  }
}

function finish(value) {
  send({ type: "shutdown" });
  child.stdin.end();
  report(value);
}

function report(value) {
  const fullResultBytes = meta.fullResultBytes;
  const s2c = migrations.find((m) => m.from === "server" && m.to === "client");

  console.log("\nWaso — two real OS processes, continuation crossing a pipe\n");
  console.log(`Program: render(minAge=${minAge})  cold-started on the CLIENT process`);
  console.log(`Dataset: ${meta.n.toLocaleString()} rows, living ONLY in the server process`);
  console.log(`Full result set (if it had been shipped here): ${fmt(fullResultBytes)}\n`);

  console.log("Migrations (continuations crossing the pipe):");
  for (const m of migrations)
    console.log(`  ${m.from.padEnd(6)} -> ${m.to.padEnd(6)}  forced by ${m.resource.padEnd(14)}  continuation = ${fmt(m.bytes)}`);
  console.log("");

  console.log(`Key claim (§11): the server->client continuation carried the live stack,`);
  console.log(`not the heap. rows arrived as a §5 handle (verified), staying server-side.`);
  console.log(`  continuation crossing the pipe : ${fmt(s2c.bytes)}`);
  console.log(`  full result set, had we shipped : ${fmt(fullResultBytes)}`);
  console.log(`  ratio                          : ${(fullResultBytes / s2c.bytes).toFixed(0)}x smaller\n`);

  console.log("Real bytes measured on the pipe:");
  console.log(`  parent -> child total : ${fmt(parentToChild)}`);
  console.log(`  child -> parent total : ${fmt(childToParent)}`);
  console.log(`  largest single frame to client : ${fmt(biggestFrameToClient)}  (<< ${fmt(fullResultBytes)} dataset)\n`);

  // We can't recompute the expectation here — the data lives only on the server.
  // Check what we can from this side, including that the dataset never crossed.
  const ok = value === rendered.length && rendered.length > 0 &&
             rendered[0] === "Person 99 (99)" &&
             childToParent < fullResultBytes / 10; // dataset clearly never crossed
  console.log(`Correctness: render returned ${value}; DOM received ${rendered.length} items.`);
  console.log(`Sample rendered: ${rendered.slice(0, 3).join(", ")} ...`);
  console.log(`Dataset never crossed the pipe? ${ok ? "YES" : "NO"}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

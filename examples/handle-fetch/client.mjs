// Cross-process fetch demo — CLIENT tier + orchestrator (parent process).
//
//   node stackmix-fetch-2p-client.mjs
//
// The capstone: a continuation migrates between two real OS processes, and when
// the client dereferences a handle to data that stayed on the server, the
// deref-miss SUSPENDS (a deref-miss is an await on the fetch, #3), the
// orchestrator fetches the object over the pipe, caches it, and resumes the
// synchronous interpreter. The big profile crosses ONLY because the client
// touched it — on-demand §5 fetch, end-to-end across processes.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Tier, run, Suspend, Miss, serializeContinuation, deserializeContinuation, initialFrames, contBytes, fmt } from "#stackmix/runtime/core.mjs";
import { decodeGraph } from "#stackmix/runtime/heap.mjs";
import { writeFrame, readFrames } from "#stackmix/runtime/frame.mjs";
import "./profile.mjs";

const rendered = [];
const client = new Tier("client", { "render": ([name]) => { rendered.push(name); return name.length; } });

// Deref: local -> master; cached -> snapshot; otherwise a Miss (the interpreter
// turns it into a fetch suspension that the orchestrator resolves over the pipe).
const cache = new Map();
const host = { deref(h) { if (h.owner === client.id) return client.heap.get(h.id); return cache.has(h.id) ? cache.get(h.id) : new Miss(h); } };

const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] });
let toServer = 0, fromServer = 0, fetchBytes = 0, migrateBackBytes = 0;
const send = (obj, bin) => { toServer += writeFrame(child.stdin, obj, bin); };
let resolveNext = null;
readFrames(child.stdout, (msg, bin, total) => { fromServer += total; const r = resolveNext; resolveNext = null; r && r({ msg, bin }); });
const next = () => new Promise((res) => { resolveNext = res; });

async function fetchRemote(handle) {
  send({ type: "fetch", id: handle.id });
  const { msg, bin } = await next();
  if (msg.type !== "fetchResult") throw new Error("expected fetchResult, got " + msg.type);
  fetchBytes += bin.length;
  return decodeGraph(JSON.parse(bin.toString("utf8")))[0];
}

async function main() {
  let frames = initialFrames("profileView", [7]);
  let pending = null;
  while (true) {
    try {
      if (pending) { frames[frames.length - 1].stack.push(client.resources[pending.name](pending.args)); pending = null; }
      const res = run(client, frames, host);
      return finish(res.value);
    } catch (e) {
      if (!(e instanceof Suspend)) throw e;
      if (e.pending.fetch) {                                   // deref-miss -> fetch over the pipe
        const obj = await fetchRemote(e.pending.fetch);
        cache.set(e.pending.fetch.id, obj);
        frames = e.frames;                                     // re-run; the deref now hits cache
        continue;
      }
      // resource the client lacks (db.profile) -> migrate the continuation to the server
      const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, client);
      send({ type: "resume", wire });
      const { msg } = await next();
      if (msg.type === "error") throw new Error("server: " + msg.message);
      if (msg.type === "done") return finish(msg.value);
      if (msg.type !== "suspend") throw new Error("unexpected " + msg.type);
      migrateBackBytes = contBytes(msg.wire);
      const got = deserializeContinuation(msg.wire);
      frames = got.frames; pending = got.pending;
    }
  }
}

function finish(value) {
  send({ type: "shutdown" }); child.stdin.end();
  const BIO = 120_000;
  console.log("\nStackmix — cross-process on-demand fetch (async suspension + heap + real pipe)\n");
  console.log(`Program: profileView(7) cold-started on the CLIENT; profile.bio = ${fmt(BIO)} lives on the server`);
  console.log(`Flow: migrate to server (db.profile) -> migrate back to client (render) -> deref p.bio -> fetch\n`);
  console.log(`  migrate-back continuation (server->client) : ${fmt(migrateBackBytes)}  (profile stayed as a handle)`);
  console.log(`  on-demand fetch of the profile (deref)      : ${fmt(fetchBytes)}  (the bio crosses only here)`);
  console.log(`  total bytes server->client                 : ${fmt(fromServer)}`);
  console.log("");
  const ok = value === BIO && rendered.length === 1 && rendered[0] === "Profile 7" &&
    migrateBackBytes < BIO / 10 && fetchBytes > BIO / 2;
  console.log(`Key point: the ${fmt(BIO)} bio did NOT ride the migration; it crossed only when the`);
  console.log(`client dereferenced p.bio — a deref-miss resolved by an async fetch over the pipe.`);
  console.log(`Correctness: returned p.bio.length = ${value} (expected ${BIO}); rendered ${JSON.stringify(rendered)}`);
  console.log(`On-demand (big data crossed only on deref)? ${ok ? "YES" : "NO"}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

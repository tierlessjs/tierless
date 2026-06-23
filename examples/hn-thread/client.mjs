// Capstone — CLIENT tier + orchestrator (parent process).
//
//   node examples/hn-thread/client.mjs
//
// Proves the whole stack composes: a program authored in ordinary TypeScript is
// compiled by the frontend, cold-starts on the client, and SUSPENDS/RESUMES
// across two real OS processes as its resource dependencies pull it between
// tiers. Each migration is mapped back to the TS source line via the source-map
// metadata. The data-dependent work (build) runs on the server in ONE migration
// instead of N round trips.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Tier, Suspend, serializeContinuation, deserializeContinuation, contBytes, pendingName, wireHandles, initialFrames, fmt, writeFrame, readFrames } from "#stackmix";
import { N, buildRuntime } from "./thread.mjs";

const rt = buildRuntime();

const rendered = [];
const client = new Tier("client", { "ui.render": ([lines]) => { for (const l of lines) rendered.push(l); return lines.length; } });
const host = { deref() { throw new Error("client deref unexpected"); } };

const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] });
let resolveNext = null;
readFrames(child.stdout, (msg) => { const r = resolveNext; resolveNext = null; r && r(msg); });
const next = () => new Promise((res) => { resolveNext = res; });
const send = (obj) => writeFrame(child.stdin, obj);

const migrations = [];

const topLoc = (frames) => { const t = rt.describe(frames); return t[t.length - 1]?.loc; };

async function main() {
  let frames = initialFrames("main", []);
  let pending = null;
  while (true) {
    try {
      if (pending) { frames[frames.length - 1].stack.push(client.resources[pending.name](pending.args)); pending = null; }
      const res = rt.run(client, frames, host);
      return finish(res.value);
    } catch (e) {
      if (!(e instanceof Suspend)) throw e;
      // client lacks this resource (db.*) -> migrate the continuation to the server
      const loc = topLoc(e.frames);
      const wire = serializeContinuation({ frames: e.frames, pending: e.pending }, client);
      migrations.push({ dir: "client→server", res: e.pending.name, bytes: contBytes(wire), frames: e.frames.length, loc });
      send({ type: "resume", wire });
      const msg = await next();
      if (msg.type === "error") throw new Error("server: " + msg.message);
      if (msg.type === "done") return finish(msg.value);
      if (msg.type !== "suspend") throw new Error("unexpected " + msg.type);
      const back = deserializeContinuation(msg.wire);
      migrations.push({ dir: "server→client", res: pendingName(msg.wire), bytes: contBytes(msg.wire), frames: msg.wire.frames.length, loc: topLocFromWire(msg.wire), handles: wireHandles(msg.wire).length });
      frames = back.frames; pending = back.pending;
    }
  }
}

function topLocFromWire(wire) {
  // reconstruct frames cheaply for the trace: the wire's frame fn+ip are enough
  const frames = wire.frames.map((f) => ({ fn: f.fn, ip: f.ip }));
  const t = rt.describe(frames);
  return t[t.length - 1]?.loc;
}

function finish(value) {
  send({ type: "shutdown" }); child.stdin.end();
  const nInstrs = Object.values(rt.program).reduce((s, f) => s + f.code.length, 0);
  console.log("\nStackmix capstone — real TypeScript, suspended/resumed across two OS processes\n");
  console.log(`Authored: app-thread.ts -> compiled to ${nInstrs} IR instrs across ${Object.keys(rt.program).length} functions`);
  console.log(`Program: main() cold-started on the CLIENT; db.* live on the server, ui.* on the client\n`);
  console.log("Migrations (continuation crossing the pipe, mapped to TS source):");
  for (const m of migrations)
    console.log(`  ${m.dir}  forced by ${String(m.res).padEnd(10)}  ${m.frames} frame(s), ${fmt(m.bytes).padStart(8)}` +
      `${m.loc ? `   @ ${m.loc.file}:${m.loc.line}  \`${m.loc.text}\`` : ""}`);
  console.log("");
  console.log(`The data-dependent loop (build) ran on the server in ONE migration: ${migrations.length} round trips total,`);
  console.log(`vs ~${N + 2} if the client fetched db.items + each of ${N} db.title + render.`);
  const ok = value === N && rendered.length === N && rendered[0] === "Title #0" && rendered[N - 1] === "Title #" + (N - 1) && migrations.length === 2;
  console.log(`Correctness: render returned ${value} (expected ${N}); rendered[0]=${rendered[0]}, rendered[last]=${rendered[N - 1]}`);
  console.log(`Real TS migrated across processes and computed correctly? ${ok ? "YES" : "NO"}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

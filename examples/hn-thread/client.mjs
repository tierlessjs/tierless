// Capstone — CLIENT tier + orchestrator.
//
//   node examples/hn-thread/client.mjs
//
// Proves the whole stack composes: a program authored in ordinary TypeScript is
// compiled by the frontend, cold-starts on the client, and SUSPENDS/RESUMES over
// a real WebSocket as its resource dependencies pull it between tiers. Each
// migration is mapped back to the TS source line via source-map metadata. The
// data-dependent work (build) runs on the server in ONE migration instead of N
// round trips.
import { WebSocket } from "ws";
import { Tier, connectWss, contBytes, pendingName, wireHandles, fmt } from "#stackmix";
import { startServer } from "./server.mjs";
import { N, buildRuntime } from "./thread.mjs";

const rt = buildRuntime();
const rendered = [];
const client = new Tier("client", { "ui.render": ([lines]) => { for (const l of lines) rendered.push(l); return lines.length; } });

const topLocFromWire = (wire) => { const t = rt.describe(wire.frames.map((f) => ({ fn: f.fn, ip: f.ip }))); return t[t.length - 1]?.loc; };

const migrations = [];
const onMigrate = (dir, wire) => migrations.push({
  dir: dir === "out" ? "client→server" : "server→client",
  res: pendingName(wire), bytes: contBytes(wire), frames: wire.frames.length,
  loc: topLocFromWire(wire), handles: wireHandles(wire).length,
});

async function main() {
  const { wss, port } = await startServer(0);
  const conn = connectWss(`ws://127.0.0.1:${port}`, {
    rt, tier: client, entry: "main", args: [], onMigrate, WebSocketImpl: WebSocket,
  });
  const value = await conn.run();
  conn.close();
  wss.close();
  finish(value);
}

function finish(value) {
  const nInstrs = Object.values(rt.program).reduce((s, f) => s + f.code.length, 0);
  console.log("\nStackmix capstone — real TypeScript, suspended/resumed over a real WebSocket\n");
  console.log(`Authored: app-thread.ts -> compiled to ${nInstrs} IR instrs across ${Object.keys(rt.program).length} functions`);
  console.log(`Program: main() cold-started on the CLIENT; db.* live on the server, ui.* on the client\n`);
  console.log("Migrations (continuation crossing the socket, mapped to TS source):");
  for (const m of migrations)
    console.log(`  ${m.dir}  forced by ${String(m.res).padEnd(10)}  ${m.frames} frame(s), ${fmt(m.bytes).padStart(8)}` +
      `${m.loc ? `   @ ${m.loc.file}:${m.loc.line}  \`${m.loc.text}\`` : ""}`);
  console.log("");
  console.log(`The data-dependent loop (build) ran on the server in ONE migration: ${migrations.length} round trips total,`);
  console.log(`vs ~${N + 2} if the client fetched db.items + each of ${N} db.title + render.`);
  const ok = value === N && rendered.length === N && rendered[0] === "Title #0" && rendered[N - 1] === "Title #" + (N - 1) && migrations.length === 2;
  console.log(`Correctness: render returned ${value} (expected ${N}); rendered[0]=${rendered[0]}, rendered[last]=${rendered[N - 1]}`);
  console.log(`Real TS migrated over a WebSocket and computed correctly? ${ok ? "YES" : "NO"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

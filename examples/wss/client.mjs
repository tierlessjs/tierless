// Stackmix — WSS demo CLIENT + CI check (the real-transport capstone).
//
//   node examples/wss/client.mjs
//
// Starts the server in-process (a REAL ws endpoint on loopback), connects a REAL
// WebSocket client, and runs one program that migrates browser -> server ->
// browser and then fetches a §5 handle back over the SAME socket. This replaces
// the stdio two-process / handle-fetch pipe demos: the cross-tier evidence now
// runs over an actual WebSocket, which is what the browser will use.
//
// The client uses `ws`'s WebSocket (Node 20 has no global WebSocket); a real
// browser passes nothing and gets `globalThis.WebSocket`. Either way it drives
// the same connectWss() path.
import { WebSocket } from "ws";
import { Tier, connectWss, fmt } from "#stackmix";
import { startServer } from "./server.mjs";
import { buildRuntime, BIO } from "./app.mjs";

// A WebSocket subclass that tallies the real bytes on the wire, so we can prove
// the big profile crossed only on the fetch — not on the migration.
const byteLen = (d) => (d == null ? 0 : d.byteLength != null ? d.byteLength : d.length != null ? d.length : 0);
const recvSizes = [];
let sentBytes = 0;
class CountingWS extends WebSocket {
  constructor(...a) { super(...a); this.addEventListener("message", (ev) => recvSizes.push(byteLen(ev.data))); }
  send(data) { sentBytes += byteLen(data); return super.send(data); }
}

async function main() {
  const { wss, port } = await startServer(0);

  const rendered = [];
  const rt = buildRuntime();
  const client = new Tier("client", { "render": ([name]) => { rendered.push(name); return name.length; } });

  const conn = connectWss(`ws://127.0.0.1:${port}`, {
    rt, tier: client, entry: "profileView", args: [7], WebSocketImpl: CountingWS,
  });
  const value = await conn.run();
  conn.close();
  wss.close();

  const sorted = recvSizes.slice().sort((a, b) => b - a);
  const fetchBytes = sorted[0] || 0;          // the one big transfer: the bio
  const otherMax = sorted[1] || 0;            // the migration-back continuation (and the rest)
  const bytesOk = fetchBytes >= BIO / 2 && otherMax < BIO / 10;
  const correct = value === BIO && rendered.length === 1 && rendered[0] === "Profile 7";

  console.log("\nStackmix — continuation migration + on-demand §5 fetch over a real WebSocket\n");
  console.log(`Program: profileView(7); profile.bio = ${fmt(BIO)} lives only on the server`);
  console.log(`Flow: migrate to server (db.profile) -> migrate back to browser (render) -> deref p.bio -> fetch\n`);
  console.log(`  largest single message browser<-server : ${fmt(fetchBytes)}  (the bio, fetched on deref)`);
  console.log(`  every other server->browser message    : <= ${fmt(otherMax)}  (continuations stayed small)`);
  console.log(`  total bytes browser->server            : ${fmt(sentBytes)}\n`);
  console.log(`Correctness: returned p.bio.length = ${value} (expected ${BIO}); rendered ${JSON.stringify(rendered)}`);
  console.log(`Big data crossed only on the fetch, not the migration? ${bytesOk ? "YES" : "NO"}`);
  console.log(`Ran over a real WebSocket (browser<->server)? ${correct && bytesOk ? "YES" : "NO"}`);
  process.exit(correct && bytesOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

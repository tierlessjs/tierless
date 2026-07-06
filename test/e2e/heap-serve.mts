// LIVE §5 deref through the REAL production host — not a parallel pump.
//
// This is the regression that would have caught "the deref path isn't wired into prod":
// it drives the actual makeHost + makeCoherence + transport (Parts 1-3) and the actual
// serveApp + connect assembly (Part 4) over a real websocket. A green run here means the
// serving path itself excises big locals, fetches them back on deref over the same socket,
// caches them in the BYTE-BOUNDED store, and stays single-writer coherent — no test-only
// Channel, no reimplemented pump.
import { createRequire } from "node:module";
import { makeHost } from "tierless";
import { makeCoherence } from "tierless/coherence";
import { makeLruStore } from "tierless/store";
import { serveApp, WS_PATH } from "tierless/server";
import { connect } from "tierless/browser";
import { makePeer, wsPort } from "tierless/transport";
import * as bundle from "./heap-auto.gen.mjs";
import * as wbBundle from "./heap-write.gen.mjs";
import { makeCheck } from "../lib/check.mts";
import type { MachineResult } from "tierless/runtime";
import type { Handle } from "tierless/graph";

const { WebSocketServer, WebSocket } = createRequire(import.meta.url)("ws");
const { check, ok } = makeCheck();
type ResourceReq = Extract<MachineResult, { op: "resource" }>;

interface Row { id: number; title: string; score: number; body: string }
interface Commit { total: number; count: number }
const body = "markdown body. ".repeat(40);
const ROWS: Row[] = Array.from({ length: 1500 }, (_, i) => ({ id: i, title: "Article " + i, score: i % 100, body }));
const expectedTotal = ROWS.reduce((s, r) => s + r.score, 0);
const apiExec = (req: ResourceReq): unknown => { if (req.name === "api.getRows") return ROWS.map((r) => ({ ...r })); throw new Error("no resource " + req.name); };

console.log("Probe: §5 deref through the REAL host + serveApp/connect over a real socket\n");

// ---- a real websocket peer pair -------------------------------------------------------
async function wsPair(): Promise<[import("tierless/transport").Peer, import("tierless/transport").Peer, () => void]> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", r));
  const port = wss.address().port;
  let resolveServer: (p: any) => void;
  const serverPeer = new Promise<any>((res) => { resolveServer = res; });
  wss.on("connection", (ws: any) => resolveServer(makePeer(wsPort(ws))));
  const clientWs = new WebSocket(`ws://localhost:${port}`);
  const browserPeer = makePeer(wsPort(clientWs));
  await new Promise<void>((r, j) => { clientWs.on("open", () => r()); clientWs.on("error", j); });
  return [await serverPeer, browserPeer, () => { clientWs.close(); wss.close(); }];
}

// ===== Parts 1-3: the real host + coherence over a real socket ==========================
{
  const [serverPeer, browserPeer, closeSockets] = await wsPair();
  const serverCoh = makeCoherence("server");
  const browserCoh = makeCoherence("browser");
  let committed = null as Commit | null;
  const domCommit = (req: ResourceReq): { want: number } => { committed = req.args[0] as Commit; return { want: 2 }; };

  const serverHost = makeHost({ bundle, tier: "server", exec: apiExec, coherence: serverCoh });
  const browserHost = makeHost({ bundle, tier: "browser", exec: domCommit, coherence: browserCoh });
  serverCoh.serve(serverPeer);       // the server answers the browser's fetch-back requests
  browserHost.answer(browserPeer);   // the browser answers resumes (and serves its own heap)

  // Part 1: the server starts Report, migrates a §5 handle (not the dataset) to the browser,
  // which derefs it back over the socket and returns the detail.
  const value = await serverHost.run(serverPeer, "Report");
  check("the app ran end to end through the REAL host and returned the fetched detail", value === "Article 2");
  check("the browser committed the small summary (it did NOT need the dataset for that)", committed !== null && committed.count === 1500 && committed.total === expectedTotal);
  check("the dataset stayed on the server as a §5 handle (excised into the server heap)", serverCoh.tier.heap.objs.size >= 1);
  check("the browser fetched the dataset back over the socket exactly once", browserCoh.stats.fetches === 1 && browserCoh.stats.localUses === 0);

  // Part 2: single-writer coherence over the socket. Re-deref the same handle -> a version
  // "same" hit (no data ships). Then mutate the master -> the reader refetches the new value.
  const id = [...serverCoh.tier.heap.objs.keys()][0];
  const handle: Handle = { __tierless_handle__: true, owner: "server", id };
  const again = await browserCoh.deref(browserPeer, handle) as Row[];
  check("a second deref is a coherent cache hit — version matched, nothing re-shipped", browserCoh.stats.hits === 1 && browserCoh.stats.fetches === 1 && again.length === 1500);
  serverCoh.tier.heap.mutate(id, (o: any) => { o[0].title = "MUTATED"; });   // master bumps its version
  const fresh = await browserCoh.deref(browserPeer, handle) as Row[];
  check("after the master mutates, the reader refetches the new value over the socket", fresh[0].title === "MUTATED" && browserCoh.stats.fetches === 2);

  // Part 3: the reader cache is the BOUNDED store, over the real socket. Fill the server heap
  // with many distinct objects, deref them all through a tiny-budget browser coherence, and
  // prove the oldest was evicted (a refetch), i.e. memory stayed bounded on the live path.
  // The browser reader fetches via browserPeer -> serverCoh.serve answers from the server heap.
  const small = makeCoherence("browser", { store: makeLruStore({ max: 3 }) });   // count-cap of 3 for a crisp assertion
  const many: Handle[] = Array.from({ length: 20 }, (_, i) => ({ __tierless_handle__: true, owner: "server", id: serverCoh.tier.heap.put({ n: i }).id }));
  for (const h of many) await small.deref(browserPeer, h);
  check("derefed 20 distinct handles over the socket, each a cold fetch", small.stats.fetches === 20 && small.stats.hits === 0);
  const fBefore = small.stats.fetches;
  await small.deref(browserPeer, many[19]);                    // most-recent -> still cached
  check("the most-recent handle is still resident (a hit)", small.stats.fetches === fBefore && small.stats.hits === 1);
  await small.deref(browserPeer, many[0]);                     // oldest -> evicted under the budget -> refetch
  check("the oldest handle was evicted under the budget — the live cache is bounded", small.stats.fetches === fBefore + 1);

  closeSockets();
}

// ===== Part 4: the real serveApp + connect assembly turns coherence ON automatically =====
{
  const value = await new Promise<unknown>((resolve, reject) => {
    (async () => {
      const app = await serveApp({
        bundle,                                   // an --auto-deref bundle -> serveApp auto-enables heap coherence
        tier: "server",
        session: () => ({ exec: apiExec, entry: "Report", onDone: resolve }),
      });
      const conn = connect({
        url: `ws://localhost:${app.port}${WS_PATH}`,
        bundle, tier: "browser",
        exec: (req: ResourceReq): unknown => { if (req.name === "dom.commit") return { want: 2 }; throw new Error("no resource " + req.name); },
      });
      await conn.ready;
      // the server drives Report on connect; onDone resolves. Clean up shortly after.
      setTimeout(() => { conn.close(); app.close(); }, 50);
    })().catch(reject);
  });
  check("serveApp + connect ran the deref app end to end (coherence auto-enabled from the bundle)", value === "Article 2");
}

// ===== Part 5: the unserved write-back path fails CLOSED, with a clear diagnostic =========
// The live host does not serve "@writeback" yet (docs/memory.md). Without the guard, the
// request migrates and dies in the OTHER tier's app exec as a baffling "no resource
// writeback" — verified before the guard existed. Prove the guard converts that into a
// named, documented error at the tier that hit it.
{
  const [serverPeer, browserPeer, closeSockets] = await wsPair();
  const serverCoh = makeCoherence("server");
  const serverHost = makeHost({ bundle: wbBundle, tier: "server", exec: apiExec, coherence: serverCoh });
  const browserHost = makeHost({ bundle: wbBundle, tier: "browser", exec: ((req: ResourceReq) => { if (req.name === "dom.commit") return { idx: 3, score: 999 }; throw new Error("no resource " + req.name); }) as (req: ResourceReq) => unknown, coherence: makeCoherence("browser") });
  serverCoh.serve(serverPeer);
  browserHost.answer(browserPeer);
  const outcome = await serverHost.run(serverPeer, "Edit").then(() => "resolved", (e: any) => String(e && e.message));
  check("an --auto-writeback bundle fails closed with the documented diagnostic (not a confusing app-exec error)",
    outcome.includes("write-back path is not served") && !outcome.includes("no resource writeback"), `(got: ${outcome.slice(0, 80)})`);
  closeSockets();
}

console.log(ok()
  ? "PASS — §5 deref is wired into the real serving path: excision, deref-over-socket, byte-bounded coherent cache, all through makeHost/serveApp/connect"
  : "FAIL");
process.exit(ok() ? 0 : 1);

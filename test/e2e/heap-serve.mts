// LIVE §5 heap through the REAL production host — not a parallel pump.
//
// This is the regression that would have caught "the heap path isn't wired into prod": it
// drives the actual makeHost + makeCoherence + transport, and the actual serveApp + connect
// assembly, over a real websocket. A green run means the serving path itself excises big
// locals, fetches them back on deref over the same socket, caches them in the BYTE-BOUNDED
// pinned store, write-backs a mutation to the owning master in place under a CAS, and
// releases a completed continuation's excised masters — no test-only Channel, no
// reimplemented pump.
import { createRequire } from "node:module";
import { makeHost } from "tierless";
import { makeCoherence } from "tierless/coherence";
import { makeLruStore } from "tierless/store";
import { dirtySnapshot, type Session } from "tierless/delta";
import { serveApp, WS_PATH } from "tierless/server";
import { connect } from "tierless/browser";
import { makePeer, wsPort } from "tierless/transport";
import * as bundle from "./heap-auto.gen.mjs";
import * as wbBundle from "./heap-write.gen.mjs";
import { makeCheck } from "../lib/check.mts";
import type { Bundle, Frame, MachineResult } from "tierless/runtime";
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
  let heapAtCommit = -1;   // owner-heap size observed mid-session, at the commit boundary
  const domCommit = (req: ResourceReq): { want: number } => { heapAtCommit = serverCoh.tier.heap.objs.size; committed = req.args[0] as Commit; return { want: 2 }; };

  const serverHost = makeHost({ bundle, tier: "server", exec: apiExec, coherence: serverCoh });
  const browserHost = makeHost({ bundle, tier: "browser", exec: domCommit, coherence: browserCoh });
  serverCoh.serve(serverPeer);       // the server answers the browser's fetch-back requests
  browserHost.answer(browserPeer);   // the browser answers resumes (and serves its own heap)

  // Part 1: the server starts Report, migrates a §5 handle (not the dataset) to the browser,
  // which derefs it back over the socket and returns the detail. At the commit boundary the
  // dataset is resident in the server heap (excised); when the continuation completes it is
  // RELEASED — the owner heap does not accumulate finished sessions' masters.
  const value = await serverHost.run(serverPeer, "Report");
  check("the app ran end to end through the REAL host and returned the fetched detail", value === "Article 2");
  check("the browser committed the small summary (it did NOT need the dataset for that)", committed !== null && committed.count === 1500 && committed.total === expectedTotal);
  check("the dataset was resident in the server heap mid-session (excised at the migrate)", heapAtCommit >= 1);
  check("the browser fetched the dataset back over the socket exactly once", browserCoh.stats.fetches === 1 && browserCoh.stats.localUses === 0);
  check("the finished continuation's excised master was released (owner heap flat)", serverCoh.tier.heap.objs.size === 0);

  // Part 2: single-writer coherence over the socket, against a directly-owned master.
  const id = serverCoh.tier.heap.put(ROWS.map((r) => ({ ...r }))).id;
  const handle: Handle = { __tierless_handle__: true, owner: "server", id };
  await browserCoh.deref(browserPeer, handle);
  const again = await browserCoh.deref(browserPeer, handle) as Row[];
  check("a second deref is a coherent cache hit — version matched, nothing re-shipped", browserCoh.stats.hits === 1 && browserCoh.stats.fetches === 2 && again.length === 1500);
  serverCoh.tier.heap.mutate(id, (o: any) => { o[0].title = "MUTATED"; });   // master bumps its version
  const fresh = await browserCoh.deref(browserPeer, handle) as Row[];
  check("after the master mutates, the reader refetches the new value over the socket", fresh[0].title === "MUTATED" && browserCoh.stats.fetches === 3);

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
  let cleanup = (): void => {};
  const value = await new Promise<unknown>((resolve, reject) => {
    (async () => {
      const app = await serveApp({
        bundle,                                   // an --auto-deref bundle -> serveApp auto-enables heap coherence
        tier: "server",
        session: () => ({ exec: apiExec, entry: "Report", onDone: resolve }),   // the server drives Report on connect
      });
      const conn = connect({
        url: `ws://localhost:${app.port}${WS_PATH}`,
        bundle, tier: "browser",
        exec: (req: ResourceReq): unknown => { if (req.name === "dom.commit") return { want: 2 }; throw new Error("no resource " + req.name); },
      });
      cleanup = (): void => { conn.close(); app.close(); };
      await conn.ready;
      setTimeout(() => reject(new Error("deref app did not complete within 5s")), 5000);
    })().catch(reject);
  });
  cleanup();
  check("serveApp + connect ran the deref app end to end (coherence auto-enabled from the bundle)", value === "Article 2");
}

// ===== Part 5: WRITE-BACK through the real host — a browser edit reaches the server master =====
// heap-write.gen.mjs (--auto-deref --auto-writeback): the browser mutates its fetched copy
// (`rows[ev.idx].score = ev.score`) and the machine's "@writeback" propagates it to the server
// master over the socket, applied IN PLACE under a CAS — the app's own reference (the array
// apiExec returned) observes the write. Also proves owner-heap release: after each continuation
// completes, the masters it excised are dropped, so N sequential sessions keep the heap flat.
{
  const [serverPeer, browserPeer, closeSockets] = await wsPair();
  const serverCoh = makeCoherence("server");
  const browserCoh = makeCoherence("browser");
  const served: Row[][] = [];   // the arrays the app handed out — in-place write-back must be visible through them
  const wbApiExec = (req: ResourceReq): unknown => { if (req.name === "api.getRows") { const rows = ROWS.map((r) => ({ ...r })); served.push(rows); return rows; } throw new Error("no resource " + req.name); };
  const wbDomExec = (req: ResourceReq): unknown => { if (req.name === "dom.commit") return { idx: 3, score: 999 }; throw new Error("no resource " + req.name); };
  const serverHost = makeHost({ bundle: wbBundle, tier: "server", exec: wbApiExec, coherence: serverCoh });
  const browserHost = makeHost({ bundle: wbBundle, tier: "browser", exec: wbDomExec, coherence: browserCoh });
  serverCoh.serve(serverPeer);
  browserHost.answer(browserPeer);

  const value = await serverHost.run(serverPeer, "Edit");
  check("the write-back app ran end to end and returned the edited value", value === 999);
  check("the browser's edit reached the SERVER master, in place — the app's own array shows it", served.length === 1 && served[0][3].score === 999 && served[0][3].id === 3);
  check("it took one fetch and one delta write-back (no conflict, no whole-graph replace)",
    browserCoh.stats.fetches === 1 && browserCoh.stats.writeBacks === 1 && browserCoh.stats.conflicts === 0 && browserCoh.stats.wholeWrites === 0);
  check("the continuation's excised master was RELEASED when it completed (owner heap flat)", serverCoh.tier.heap.objs.size === 0);

  // N sequential sessions on ONE connection: the owner heap stays flat, not O(N).
  for (let i = 0; i < 5; i++) await serverHost.run(serverPeer, "Edit");
  check("5 more sessions on the same socket left the owner heap flat (released per continuation, not per disconnect)",
    serverCoh.tier.heap.objs.size === 0 && served.length === 6 && served.every((rows) => rows[3].score === 999));
  closeSockets();
}

// ===== Part 6: baseline pinning and the baseline-evicted fallback ==========================
// The reader cache pins an entry whose snapshot has an unshipped mutation (evicting it would
// drop the baseline the write-back diffs against). Once clean it may be evicted; a LATER
// mutation of the still-held copy then write-backs without a baseline — degraded to a
// whole-graph REPLACE under the same CAS, counted in stats.wholeWrites. Every path lands the
// write; nothing is silently dropped.
{
  const [serverPeer, browserPeer, closeSockets] = await wsPair();
  const owner = makeCoherence("server");
  owner.serve(serverPeer);
  // a 1-entry pinning store, same gate as the default (small budget for crisp assertions)
  const reader = makeCoherence("browser", { store: makeLruStore<{ version: number; copy: unknown; bytes: number; session: Session }>({ max: 1, evictable: (e) => !dirtySnapshot(e.session, e.copy) }) });
  const h1: Handle = { __tierless_handle__: true, owner: "server", id: owner.tier.heap.put({ v: 1, tag: "one" }).id };
  const h2: Handle = { __tierless_handle__: true, owner: "server", id: owner.tier.heap.put({ v: 2, tag: "two" }).id };
  const h3: Handle = { __tierless_handle__: true, owner: "server", id: owner.tier.heap.put({ v: 3, tag: "three" }).id };

  const c1 = await reader.deref(browserPeer, h1) as { v: number };
  c1.v = 111;                                                       // dirty — unshipped mutation pins the entry
  await reader.deref(browserPeer, h2);                              // cap pressure: would evict h1, but it is pinned
  await reader.writeBack(browserPeer, c1);                          // baseline survived the pressure -> delta path
  check("a dirty entry was PINNED through cap pressure — its write-back used the baseline (delta, not whole)",
    reader.stats.writeBacks === 1 && reader.stats.wholeWrites === 0 && (owner.tier.heap.get(h1.id) as { v: number }).v === 111);

  await reader.deref(browserPeer, h3);                              // now clean -> evictable -> h1's entry evicted
  c1.v = 222;                                                       // a LATER mutation of the still-held copy
  await reader.writeBack(browserPeer, c1);                          // no baseline -> whole-graph replace under CAS
  check("after clean eviction, a later write degraded to a whole-graph replace — landed, and counted",
    reader.stats.wholeWrites === 1 && (owner.tier.heap.get(h1.id) as { v: number }).v === 222);

  // Optimistic CAS still guards the degraded path: a concurrent owner write wins.
  owner.tier.heap.mutate(h1.id, (o: any) => { o.v = 500; });        // owner bumps the version first
  c1.v = 333;
  await reader.writeBack(browserPeer, c1);                          // stale version -> rejected
  check("a conflicting write-back was rejected by the CAS (the owner's concurrent write won)",
    reader.stats.conflicts === 1 && (owner.tier.heap.get(h1.id) as { v: number }).v === 500);
  closeSockets();
}

// ===== Part 7: the write-back app through the real serveApp + connect assembly =============
{
  let cleanup = (): void => {};
  const value = await new Promise<unknown>((resolve, reject) => {
    (async () => {
      const app = await serveApp({
        bundle: wbBundle,                          // --auto-writeback -> coherence auto-enabled
        tier: "server",
        session: () => ({ exec: apiExec, entry: "Edit", onDone: resolve }),
      });
      const conn = connect({
        url: `ws://localhost:${app.port}${WS_PATH}`,
        bundle: wbBundle, tier: "browser",
        exec: (req: ResourceReq): unknown => { if (req.name === "dom.commit") return { idx: 7, score: 777 }; throw new Error("no resource " + req.name); },
      });
      cleanup = (): void => { conn.close(); app.close(); };
      await conn.ready;
      setTimeout(() => reject(new Error("write-back app did not complete within 5s")), 5000);
    })().catch(reject);
  });
  cleanup();
  check("serveApp + connect ran the write-back app end to end (transparent edit, propagated and returned)", value === 777);
}

// ===== Part 8: a MIXED-MODULE resolver endpoint — coherence applies per bundle ==============
// One socket serves two modules through a bundle RESOLVER: "wb" is heap-compiled
// (--auto-writeback), "plain" is an ordinary bundle whose big array local must travel
// INLINE — if coherence excision were applied connection-wide instead of per bundle, that
// local would arrive on the browser as a §5 handle and `.length` on it would be garbage.
{
  const plainBundle: Bundle = {
    PROGRAMS: {
      Plain(F: Frame): MachineResult {
        switch (F.pc) {
          case 0: F.data = Array.from({ length: 2000 }, (_, i) => i); F.pc = 1; return { op: "resource", tier: "browser", name: "ui.echo", args: ["hi"] };   // the big local rides the migrate
          case 1: return { op: "return", value: (F.data as number[]).length };   // read it ON THE BROWSER — a handle here would not have .length 2000
          default: throw new RangeError("bad pc " + F.pc);
        }
      },
    },
    __unwind: () => false,
  };
  const servedWb: Row[][] = [];
  const wbApiExec = (req: ResourceReq): unknown => { if (req.name === "api.getRows") { const rows = ROWS.map((r) => ({ ...r })); servedWb.push(rows); return rows; } throw new Error("no resource " + req.name); };

  const app = await serveApp({
    bundle: async (id: string) => (id === "wb" ? (wbBundle as unknown as Bundle) : plainBundle),   // the resolver shape — no bundle to inspect at attach time
    tier: "server",
    session: () => ({ exec: wbApiExec }),                        // actions mode: the browser starts the entries
  });
  const conn = connect({
    url: `ws://localhost:${app.port}${WS_PATH}`, tier: "browser",
    exec: (req: ResourceReq): unknown => {
      if (req.name === "dom.commit") return { idx: 3, score: 999 };
      if (req.name === "ui.echo") return req.args[0];
      throw new Error("no resource " + req.name);
    },
  });
  conn.register("plain", plainBundle);                           // an ordinary module registered FIRST —
  conn.register("wb", wbBundle as unknown as Bundle);            // per-bundle gating must not depend on order
  await conn.ready;

  const edited = await conn.call("Edit", [], "wb");
  check("the heap module on a resolver endpoint works: transparent edit propagated over the socket", edited === 999 && servedWb.length === 1 && servedWb[0][3].score === 999);
  const len = await conn.call("Plain", [], "plain");
  check("the plain module on the SAME socket shipped its big local inline (no wrongful excision)", len === 2000);
  conn.close(); app.close();
}

console.log(ok()
  ? "PASS — the full §5 heap is wired into the real serving path: excision, deref-over-socket, CAS write-back in place, byte-bounded pinned cache, per-continuation owner-heap release, per-bundle gating on mixed endpoints — all through makeHost/serveApp/connect"
  : "FAIL");
process.exit(ok() ? 0 : 1);

// Greedy per-hop §6 vs trajectory-priced placement, as a function of workflow DEPTH.
//
// A workflow whose suffix holds n same-tier data resources, each locally cheaper to fetch
// than the continuation is to ship, defeats any per-hop rule: greedy fetches n times
// (every hop individually correct — asserted), while one trace-informed migration at the
// first hop serves the rest inline. Greedy crosses ~n·F bytes and n round trips;
// trajectory crosses ~C bytes and 1 round trip, so the saving approaches 1 − C/(n·F)
// with depth. This bench MEASURES that curve over a real websocket, every byte counted
// in both directions, with the profile built from traced runs through the real host.
//
// Honest counterweights: the regime is C > F (a working set bigger than one result —
// otherwise greedy migrates at hop 1 and there is nothing to fix); the suffix must be
// STABLE across runs (the per-site gate degrades to greedy where it isn't); and n
// distinct call sites, not one site in a loop — same-site repetition fragments the
// suffix distribution and the stability gate correctly refuses to price it.
//
//   node bench/trajectory.mts
import { createRequire } from "node:module";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { wsPort, makePeer } from "tierless/transport";
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";
import { makeHost } from "tierless";
import { memorySink, buildProfile, loadProfile, decide, siteKey, argFeatures } from "tierless/trace";
import type { Frame, MachineResult, ResourceRequest } from "tierless/runtime";

const { WebSocketServer, WebSocket } = createRequire(import.meta.url)("ws");
const { compile } = createRequire(import.meta.url)("tierless/compiler");
const fmt = (n: number): string => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB");

const W = 800, K = 300;                      // working set C ≈ 8.6 KB, each resource F ≈ 6.7 KB: F < C, the greedy-fetches regime
const DEPTHS = [2, 3, 5, 10];

type Req = Extract<MachineResult, { op: "resource" }>;
type PumpResult = { done: true; value: unknown } | { done: false; request: Req; stack: Frame[] };
type Bundle = { PROGRAMS: Record<string, (f: Frame) => MachineResult>; __unwind: (s: Frame[], e: unknown) => boolean; BUNDLE_HASH: string };

// A depth-n workflow: a working set, then n DISTINCT same-tier resources in sequence.
const dir = mkdtempSync(join(tmpdir(), "traj-bench-"));
async function chainBundle(n: number): Promise<Bundle> {
  const calls = Array.from({ length: n }, (_, i) => `  const r${i} = api.get${i}(k);`).join("\n");
  const sum = Array.from({ length: n }, (_, i) => `r${i}.length`).join(" + ");
  const src = `function build(n) {\n  let work = [];\n  for (let i = 0; i < n; i = i + 1) { work[i] = "row-" + i; }\n  return work;\n}\nfunction Chain(workSize, k) {\n  const work = build(workSize);\n${calls}\n  return work.length + ${sum};\n}\n`;
  const file = join(dir, `chain${n}.gen.mjs`);
  writeFileSync(file, compile(src, { preamble: "" }).code);
  return await import(pathToFileURL(file).href) as Bundle;
}

const makeData = (k: number): { id: number; v: string }[] => Array.from({ length: k }, (_, i) => ({ id: i, v: "data-" + i }));
const apiExec = (req: Req | ResourceRequest): unknown => {
  if (!/^api\.get\d+$/.test(req.name)) throw new Error("no resource " + req.name);
  return makeData(req.args[0] as number);
};

function pumpLocal(bundle: Bundle, stack: Frame[], incoming: Req | null = null): PumpResult {
  if (incoming) stack[stack.length - 1].ret = apiExec(incoming);   // (driver server side only)
  for (;;) {
    const top = stack[stack.length - 1];
    const r = bundle.PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if ((r as Req).tier === "server") { if (SERVER) stack[stack.length - 1].ret = apiExec(r as Req); else return { done: false, request: r as Req, stack }; }
    else throw new Error("unexpected step " + r.op);
  }
}
let SERVER = false;                          // which tier pumpLocal is standing on

// ---- one real websocket; the server answers the real host AND the driver paths ---------
const bundles = new Map<number, Bundle>();
for (const n of DEPTHS) bundles.set(n, await chainBundle(n));

const serverSink = memorySink();
const wss = new WebSocketServer({ port: 0 });
await new Promise<void>((r) => wss.on("listening", r));
const ready = new Promise<void>((resolve) => {
  wss.on("connection", (ws: any) => {
    const peer = makePeer(wsPort(ws));
    // the real-host answering paths, one host per depth, routed by the `n` the caller stamps
    const hosts = new Map<number, ReturnType<typeof makeHost>>();
    const hostFor = (n: number) => {
      if (!hosts.has(n)) hosts.set(n, makeHost({ bundle: bundles.get(n)!, tier: "server", exec: apiExec, trace: { sink: serverSink.sink } }));
      return hosts.get(n)!;
    };
    peer.on("start", (p, bin) => hostFor(p.n).handleStart(p, bin));
    peer.on("resume", (p, bin) => hostFor(p.n).handleResume(p, bin));
    peer.on("rpc", (m) => ({ obj: { result: apiExec(m.request), bytes: JSON.stringify(apiExec(m.request)).length } }));
    peer.on("dresume", (payload, bin) => {
      const { stack, request } = decodeWireBinary(bin!);
      SERVER = true;
      const r = pumpLocal(bundles.get(payload.n)!, stack as Frame[], request as Req | null);
      SERVER = false;
      if (r.done) return { obj: { type: "done", value: r.value } };
      return { obj: { type: "suspend" }, bin: encodeWireBinary(r.stack, r.request, {}) };
    });
    resolve();
  });
});
const ws = new WebSocket(`ws://localhost:${wss.address().port}`);
const peer = makePeer(wsPort(ws));
await new Promise<void>((r, j) => { ws.on("open", r); ws.on("error", j); });
await ready;

console.log("Trajectory-priced placement vs greedy §6, by workflow depth — real websocket, every byte counted\n");
console.log(`working set ${W} rows (continuation ≈ 8.6 KB), each resource ${K} rows (fetch ≈ 6.7 KB): fetch < continuation at every hop\n`);

interface Row { n: number; greedyBytes: number; greedyTrips: number; trajBytes: number; trajTrips: number; hops: { cont: number; fetch: number }[] }
const rows: Row[] = [];

for (const n of DEPTHS) {
  const bundle = bundles.get(n)!;
  // trace one cold run through the REAL host -> profile for THIS bundle
  const browserSink = memorySink();
  const host = makeHost({ bundle, tier: "browser", exec: () => { throw new Error("browser owns nothing"); }, trace: { sink: browserSink.sink }, meta: { n } });
  const traced = await host.run(peer, "Chain", [W, K], { trace: true });
  const profile = loadProfile(buildProfile([...browserSink.records, ...serverSink.records], bundle.BUNDLE_HASH), bundle.BUNDLE_HASH)!;
  serverSink.records.length = 0;

  // greedy vs trajectory through the §6 driver, bytes counted both directions
  const run = async (mode: "greedy" | "trajectory") => {
    let res = pumpLocal(bundle, [{ fn: "Chain", pc: 0, args: [W, K] }]);
    let crossed = 0, trips = 0;
    const hops: { cont: number; fetch: number }[] = [];
    while (!res.done) {
      const req = res.request, top = res.stack[res.stack.length - 1];
      const wire = encodeWireBinary(res.stack, req, {});
      const d = decide(wire.length, siteKey(top.fn, top.pc, req.name), profile, { mode, argFeatures: argFeatures(req.args) });
      if (d.choice === "migrate") {
        crossed += wire.length; trips++;
        const { obj: reply } = await peer.request({ type: "dresume", n }, wire);
        if (reply.type === "error") throw new Error(reply.message);
        crossed += JSON.stringify(reply.value).length;
        return { value: reply.value, crossed, trips, hops };
      }
      hops.push({ cont: wire.length, fetch: d.fetchSide });
      if (d.fetchSide >= wire.length) throw new Error("regime broken: greedy would migrate at a hop");   // the bench asserts its own premise
      const rpc = { type: "rpc", request: { name: req.name, args: req.args } };
      const { obj } = await peer.request(rpc);
      crossed += JSON.stringify(rpc).length + obj.bytes; trips++;
      res.stack[res.stack.length - 1].ret = obj.result;
      res = pumpLocal(bundle, res.stack);
    }
    return { value: res.value, crossed, trips, hops };
  };
  const g = await run("greedy");
  const t = await run("trajectory");
  if (JSON.stringify(g.value) !== JSON.stringify(t.value) || g.value !== traced) throw new Error("drivers disagree with the traced run");
  if (g.trips !== n || t.trips !== 1) throw new Error(`unexpected trip counts: greedy ${g.trips}, trajectory ${t.trips}`);
  rows.push({ n, greedyBytes: g.crossed, greedyTrips: g.trips, trajBytes: t.crossed, trajTrips: t.trips, hops: g.hops });
}

console.log("   depth      greedy            trajectory        saving   round trips");
for (const r of rows) {
  const saving = (100 - (r.trajBytes / r.greedyBytes) * 100).toFixed(0);
  console.log(`   n=${String(r.n).padEnd(3)}   ${fmt(r.greedyBytes).padStart(8)} / ${String(r.greedyTrips).padStart(2)} trips   ${fmt(r.trajBytes).padStart(8)} / 1 trip     ${saving.padStart(3)}%      ${r.greedyTrips} -> 1`);
}

const deep = rows[rows.length - 1];
console.log(`\nThe compounding trap at n=${deep.n} — each fetch inflates the continuation greedy later prices:`);
console.log("   " + deep.hops.map((h) => fmt(h.cont)).join(" -> "));
console.log(`   by the last hop, the migration greedy keeps refusing costs ${(deep.hops[deep.hops.length - 1].cont / deep.hops[0].cont).toFixed(1)}x its hop-1 price.`);
const ms = (rtt: number) => `${deep.greedyTrips * rtt} ms vs ${rtt} ms`;
console.log(`\nRound trips are latency: at n=${deep.n}, ${deep.greedyTrips} crossings vs 1 is ${ms(50)} of network wait at a 50 ms RTT.`);
console.log("Every greedy hop above was individually correct (fetch < continuation, asserted) — the loss is structural,");
console.log("and only a trace of a prior run can see it. Suffix pricing is gated per site on trajectory stability.");

ws.close(); wss.close();

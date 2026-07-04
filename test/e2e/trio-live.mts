// LIVE trajectory-priced placement, end to end over a real websocket:
//
//   1. TRACED PRODUCTION RUNS through the real host (makeHost + __trace riding the real
//      binary wire): the cold rule migrates at fetchA, the server serves B and C inline,
//      and BOTH tiers' recorders stream records that correlate by the stack-carried
//      (id, seq) — no clocks, no envelope fields.
//   2. buildProfile() derives the per-site size models, the same-tier suffix behind
//      fetchA, and its stability — stamped with the bundle's own BUNDLE_HASH.
//   3. The §6 driver (policy-live's loop) replays Trio twice against that profile, every
//      byte counted in both directions: GREEDY prices each hop's fetch alone and fetches
//      three times — each hop individually correct, and each fetch inflating the
//      continuation it later prices; TRAJECTORY prices fetchA's whole same-tier suffix
//      and migrates once. Same result, fewer bytes.
//   4. The bundle-hash gate: a profile from a different build is refused, and decide()
//      falls back to the cold floor — a stale profile silently MISATTRIBUTES sites
//      (a pc renumbered by an edit inherits another site's trajectory history), so
//      refusal, not degradation, is the correct failure.
//
// Run:  node test/e2e/trio-live.mts
import { createRequire } from "node:module";
import { wsPort, makePeer } from "tierless/transport";
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";
import { makeHost } from "tierless";
import { memorySink, buildProfile, loadProfile, decide, siteKey, argFeatures } from "tierless/trace";
import * as bundle from "./trio-app.gen.mjs";
import { makeCheck } from "../lib/check.mts";
import type { Frame, MachineResult } from "tierless/runtime";
import type { TraceRecord } from "tierless/trace";

const { WebSocketServer, WebSocket } = createRequire(import.meta.url)("ws");
const fmt = (n: number): string => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB");
const { check, ok } = makeCheck();

const W = 800, K = 300;                                            // the §1.1 regime: fetch < cont(A) < suffix sum
type Req = Extract<MachineResult, { op: "resource" }>;
type PumpResult = { done: true; value: unknown } | { done: false; request: Req; stack: Frame[] };
type TrioValue = { work: number; a: number; b: number; c: number };

// ---- server tier: three same-tier data resources ---------------------------------------
const ownsServer = (tier: string): boolean => tier === "server";
const makeData = (k: number, tag: string): { id: number; v: string }[] => Array.from({ length: k }, (_, i) => ({ id: i, v: tag + "-" + i }));
const apiExec = (req: Req | { name: string; args: unknown[] }): unknown => {
  const m = /^api\.fetch([ABC])$/.exec(req.name);
  if (!m) throw new Error("no resource " + req.name);
  return makeData(req.args[0] as number, m[1]);
};

// One pump, both tiers — the §6 driver's local loop (same as policy-live).
const { PROGRAMS } = bundle;
function pumpLocal(stack: Frame[], ownsHere: (tier: string) => boolean, execHere: (req: Req) => unknown, incoming: Req | null = null): PumpResult {
  if (incoming) stack[stack.length - 1].ret = execHere(incoming);
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (ownsHere((r as Req).tier)) { stack[stack.length - 1].ret = execHere(r as Req); }
    else return { done: false, request: r as Req, stack };
  }
}

// ---- wire up: one real websocket, the REAL host answering start/resume, plus the §6
// driver's endpoints (rpc = fetch one resource; dresume = run a migrated continuation) ----
const serverSink = memorySink();
const wss = new WebSocketServer({ port: 0 });
await new Promise<void>((r) => wss.on("listening", r));
const serverReady = new Promise<void>((resolve) => {
  wss.on("connection", (ws: any) => {
    const peer = makePeer(wsPort(ws));
    makeHost({ bundle, tier: "server", exec: apiExec as any, trace: { sink: serverSink.sink } }).answer(peer);
    peer.on("rpc", (m) => {                                        // FETCH: one resource, result + its real size
      const result = apiExec(m.request);
      return { obj: { type: "rpcResult", result, bytes: JSON.stringify(result).length } };
    });
    peer.on("dresume", (payload, bin) => {                         // MIGRATE (driver path): run the continuation here
      try {
        const { stack, request } = decodeWireBinary(bin!);
        const r = pumpLocal(stack as Frame[], ownsServer, apiExec, request as Req | null);
        if (r.done) return { obj: { type: "done", value: r.value } };
        return { obj: { type: "suspend" }, bin: encodeWireBinary(r.stack, r.request, {}) };
      } catch (e: any) { return { obj: { type: "error", message: String((e && e.message) || e) } }; }
    });
    resolve();
  });
});
const ws = new WebSocket(`ws://localhost:${wss.address().port}`);
const peer = makePeer(wsPort(ws));
await new Promise<void>((r, j) => { ws.on("open", r); ws.on("error", j); });
await serverReady;

console.log("LIVE trajectory placement — trace through the real host, profile offline, steer the §6 driver\n");

// ---- 1. traced production runs through the REAL host -----------------------------------
const browserSink = memorySink();
const browserHost = makeHost({ bundle, tier: "browser", exec: (() => { throw new Error("browser owns no resource"); }) as any, trace: { sink: browserSink.sink } });
const RUNS = 3;
for (let i = 0; i < RUNS; i++) {
  const v = await browserHost.run(peer, "Trio", [W, K], { trace: true }) as TrioValue;
  if (i === 0) check("the traced run computes the right answer through the real host", v.work === W && v.a === K && v.b === K && v.c === K, v);
}
const records: TraceRecord[] = [...browserSink.records, ...serverSink.records];
const runIds = new Set(records.map((r) => r.id));
check(`each run traced under one id carried across the wire (${RUNS} runs)`, runIds.size === RUNS);
{
  const one = records.filter((r) => r.id === [...runIds][0]).sort((a, b) => a.seq - b.seq);
  const kinds = one.map((r) => (r.t === "res" ? r.resource : r.t));
  check("one global order across both tiers from the stack-carried seq: hop, A, B, C, end",
    JSON.stringify(kinds) === JSON.stringify(["hop", "api.fetchA", "api.fetchB", "api.fetchC", "end"]), kinds);
  const hop = one[0];
  check("the crossing record priced the real shipped wire", hop.t === "hop" && hop.contBytes > 4096 && hop.choice === "migrate", hop);
}

// ---- 2. the profile: sizes, the suffix behind fetchA, stability, bundle identity --------
const profile = loadProfile(buildProfile(records, bundle.BUNDLE_HASH as string), bundle.BUNDLE_HASH as string)!;
check("the profile loads against the bundle that produced the traces", profile !== null);
const siteA = Object.keys(profile.sites).find((k) => k.endsWith("api.fetchA"))!;
const sA = profile.sites[siteA];
check("fetchA's recorded suffix is [fetchB, fetchC], fully stable",
  sA.modal !== null && sA.modal.includes("api.fetchB") && sA.modal.includes("api.fetchC") && sA.stability === 1, sA.modal);
check("the suffix carries its summed fetch cost", sA.suffixes[sA.modal!].fetchSum > 2 * 4096, sA.suffixes[sA.modal!]);

// ---- 3. the §6 driver, greedy vs trajectory, every byte counted both directions ---------
interface Hop { site: string; contBytes: number; fetchSide: number; choice: string }
async function runTrio(mode: "greedy" | "trajectory"): Promise<{ value: TrioValue; crossed: number; hops: Hop[] }> {
  let res = pumpLocal([{ fn: "Trio", pc: 0, args: [W, K] }], () => false, () => { throw new Error("browser owns nothing"); });
  let crossed = 0;
  const hops: Hop[] = [];
  while (!res.done) {
    const req = res.request, top = res.stack[res.stack.length - 1];
    const key = siteKey(top.fn, top.pc, req.name);
    const wire = encodeWireBinary(res.stack, req, {});
    const d = decide(wire.length, key, profile, { mode, argFeatures: argFeatures(req.args) });
    hops.push({ site: req.name, contBytes: wire.length, fetchSide: d.fetchSide, choice: d.choice });
    if (d.choice === "migrate") {
      crossed += wire.length;
      const { obj: reply } = await peer.request({ type: "dresume" }, wire);
      if (reply.type === "error") throw new Error(reply.message);
      crossed += JSON.stringify(reply.value).length;               // the result travels back
      return { value: reply.value as TrioValue, crossed, hops };   // Trio never bounces back once server-side
    }
    const rpc = { type: "rpc", request: { name: req.name, args: req.args } };
    const { obj } = await peer.request(rpc);
    if (obj.type === "error") throw new Error(obj.message);
    crossed += JSON.stringify(rpc).length + obj.bytes;             // the request out, the data back
    res.stack[res.stack.length - 1].ret = obj.result;
    res = pumpLocal(res.stack, () => false, () => { throw new Error("browser owns nothing"); });
  }
  return { value: res.value as TrioValue, crossed, hops };
}

const greedy = await runTrio("greedy");
const traj = await runTrio("trajectory");

console.log("GREEDY (per-hop §6):");
for (const h of greedy.hops) console.log(`  at ${h.site}: cont=${fmt(h.contBytes)} vs fetch ${fmt(h.fetchSide)} -> ${h.choice.toUpperCase()}`);
console.log(`  crossed: ${fmt(greedy.crossed)}`);
console.log("TRAJECTORY (trace-informed):");
for (const h of traj.hops) console.log(`  at ${h.site}: cont=${fmt(h.contBytes)} vs fetch side ${fmt(h.fetchSide)} -> ${h.choice.toUpperCase()}`);
console.log(`  crossed: ${fmt(traj.crossed)}  -> ${(100 - (traj.crossed / greedy.crossed) * 100).toFixed(0)}% saving\n`);

check("both drivers computed the identical result",
  JSON.stringify(greedy.value) === JSON.stringify(traj.value) && greedy.value.work === W && greedy.value.a === K);
check("greedy fetched at every hop", greedy.hops.length === 3 && greedy.hops.every((h) => h.choice === "fetch"), greedy.hops.map((h) => h.choice));
check("every greedy hop was INDIVIDUALLY correct by the per-hop rule (fetch < continuation)",
  greedy.hops.every((h) => h.fetchSide < h.contBytes));
check("each fetch INFLATED the continuation greedy later priced (the compounding effect)",
  greedy.hops[0].contBytes < greedy.hops[1].contBytes && greedy.hops[1].contBytes < greedy.hops[2].contBytes,
  greedy.hops.map((h) => fmt(h.contBytes)));
check("trajectory migrated at the FIRST hop (the suffix flipped the locally-losing choice)",
  traj.hops.length === 1 && traj.hops[0].choice === "migrate" && traj.hops[0].site === "api.fetchA");
check("trajectory crossed fewer bytes than greedy (>= 30% saving)", traj.crossed < 0.7 * greedy.crossed,
  `${fmt(traj.crossed)} vs ${fmt(greedy.crossed)}`);

// ---- 4. the bundle-hash gate ------------------------------------------------------------
check("a profile from a DIFFERENT build is refused", loadProfile(buildProfile(records, "00000000"), bundle.BUNDLE_HASH as string) === null);
const cold = decide(9999, siteA, null, { mode: "trajectory" });
check("without a valid profile the rule is the cold floor: migrate", cold.choice === "migrate" && cold.why.includes("cold"));

ws.close(); wss.close();
console.log(ok()
  ? `\nPASS — traces recorded through the real host priced fetchA's whole suffix and flipped a locally-losing hop into a ${(100 - (traj.crossed / greedy.crossed) * 100).toFixed(0)}% saving; the hash gate refuses stale history`
  : "\nFAIL");
process.exit(ok() ? 0 : 1);

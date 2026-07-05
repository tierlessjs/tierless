// A THROWING trace sink must not change the traced run's outcome. Sinks are user-written
// callbacks in every deployment; without containment, a sink bug becomes a fault injector
// for exactly the sampled fraction of production traffic — a 1% heisencrash that vanishes
// when tracing turns off, the worst debugging shape. Worse, a sink throw inside the exec
// wrapper routes through the pump's error unwinding, so app-level try/catch could catch it
// as a fake resource failure. The recorder swallows and COUNTS sink errors instead.
//
// This drives the same real-host, real-websocket loop as trio-live with a sink that throws
// on every record, on both tiers, and asserts: the traced run completes with the correct
// value, the drops are counted, and a healthy sink on the same host still records.
//
// Run:  node test/e2e/sink-throw.mts
import { createRequire } from "node:module";
import { wsPort, makePeer } from "tierless/transport";
import { makeHost } from "tierless";
import { makeRecorder, memorySink } from "tierless/trace";
import type { Recorder } from "tierless/trace";
import * as bundle from "./trio-app.gen.mjs";
import { makeCheck } from "../lib/check.mts";
import type { ResourceRequest } from "tierless/runtime";

const { WebSocketServer, WebSocket } = createRequire(import.meta.url)("ws");
const { check, ok } = makeCheck();

const W = 100, K = 20;
type TrioValue = { work: number; a: number; b: number; c: number };
const makeData = (k: number, tag: string): { id: number; v: string }[] => Array.from({ length: k }, (_, i) => ({ id: i, v: tag + "-" + i }));
const apiExec = (req: ResourceRequest): unknown => {
  const m = /^api\.fetch([ABC])$/.exec(req.name);
  if (!m) throw new Error("no resource " + req.name);
  return makeData(req.args[0] as number, m[1]);
};

console.log("A throwing trace sink must not change the traced run's outcome\n");

const throwingSink = () => { throw new Error("sink bug: disk full"); };
const serverRec = makeRecorder({ sink: throwingSink });
const browserRec = makeRecorder({ sink: throwingSink });

const wss = new WebSocketServer({ port: 0 });
await new Promise<void>((r) => wss.on("listening", r));
const serverReady = new Promise<void>((resolve) => {
  wss.on("connection", (ws: any) => {
    makeHost({ bundle, tier: "server", exec: apiExec, trace: serverRec }).answer(makePeer(wsPort(ws)));
    resolve();
  });
});
const ws = new WebSocket(`ws://localhost:${wss.address().port}`);
const peer = makePeer(wsPort(ws));
await new Promise<void>((r, j) => { ws.on("open", r); ws.on("error", j); });
await serverReady;

const browserExec = (): unknown => { throw new Error("browser owns no resource"); };
const host = makeHost({ bundle, tier: "browser", exec: browserExec, trace: browserRec });

// untraced control: the sink never fires, the run completes
const control = await host.run(peer, "Trio", [W, K], { trace: false }) as TrioValue;
check("the untraced control run completes", control.work === W && control.a === K, control);

// the traced run: every record's sink call throws, on both tiers — the run must not notice
const traced = await host.run(peer, "Trio", [W, K], { trace: true }) as TrioValue;
check("the TRACED run completes with the identical value despite a sink throwing on every record",
  JSON.stringify(traced) === JSON.stringify(control), traced);
check("the drops were counted, not silently lost (browser tier: the crossing record)", browserRec.dropped >= 1, browserRec.dropped);
check("the drops were counted on the answering tier too (res + end records)", serverRec.dropped >= 2, serverRec.dropped);

// and a healthy sink on the same wiring still records — containment, not suppression
const healthy = memorySink();
const host2 = makeHost({ bundle, tier: "browser", exec: browserExec, trace: { sink: healthy.sink } });
await host2.run(peer, "Trio", [W, K], { trace: true });
check("a healthy sink on the same wiring still records the crossing", healthy.records.some((r) => r.t === "hop"), healthy.records.length);

// negative control: a recorder that PROPAGATES from ship() does kill the traced run — the
// failure mode is real and this test would catch anyone reintroducing it (e.g. by moving a
// sink call outside the recorder's containment).
const evil: Recorder = { ...makeRecorder({ sink: () => {} }), ship: () => { throw new Error("propagating recorder"); } };
const host3 = makeHost({ bundle, tier: "browser", exec: browserExec, trace: evil });
const died = await host3.run(peer, "Trio", [W, K], { trace: true }).then(() => null, (e: any) => String(e && e.message || e));
check("a PROPAGATING recorder error does kill the run (what containment prevents)", died !== null && died.includes("propagating recorder"), died);

ws.close(); wss.close();
console.log(ok()
  ? "\nPASS — a throwing sink is contained and counted: observability never changes the observed run's outcome"
  : "\nFAIL");
process.exit(ok() ? 0 : 1);

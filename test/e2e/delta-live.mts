// LIVE write-tracked DELTA over a real websocket — the full composition. A continuation bounces
// server↔browser every hop (api.poll + commit), carrying a big reference dataset AND a small UI.
// Every wire optimization is live and composed:
//   • the dataset EXCISES into the server's §5 heap and rides as a handle leaf (it never crosses);
//   • each crossing ships min(delta, full) — the compact full binary frame on the cold hop (both
//     tiers adoptBaseline to a shared baseline), a write-tracked delta on every warm hop — and the
//     full and delta paths excise the SAME objects to the SAME handles, so ids stay consistent;
//   • the browser DEREFS the handle once, fetching the dataset from the server over the same socket.
// The compiler's __dirty barriers (delta-app, --track-writes) drive the tracking on plain source.
//
// Run:  node test/e2e/delta-live.mts
import { createRequire } from "node:module";
import { wsPort, makePeer } from "tierless/transport";
import { initialStack, type Frame, type MachineResult } from "tierless/runtime";
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";
import { encodeGraph, decodeGraph, isHandle, type Handle } from "tierless/graph";
import { makeTier, type Tier } from "tierless/heap";
import { makeTrackedSession, planDelta, applyDeltaTracked, adoptBaseline, exciseForCapture, subForFullWire, touch, type Session } from "tierless/delta";
import { PROGRAMS, __setDirtySink } from "./delta-app.gen.mjs";
import { makeCheck } from "../lib/check.mts";

const { WebSocketServer, WebSocket } = createRequire(import.meta.url)("ws");
const fmt = (n: number): string => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB");
const THRESH = 8192;
const { check, ok } = makeCheck();

// The resource-request arm of a machine step, and what our hand-rolled local pump resolves to —
// mirrors runtime.mts's real Pump/PumpResult, simplified for this fixture: no "throw" handling,
// since these compiled PROGRAMS never emit one at the top level (same assumption the original
// untyped pump made — it only ever branched on ownsHere(r.tier), never on r.op === "throw").
type Req = Extract<MachineResult, { op: "resource" }>;
type PumpResult = { done: true; value: unknown } | { done: false; request: Req; stack: Frame[] };

async function pumpLocal(stack: Frame[], ownsHere: (tier: string) => boolean, execHere: (req: Req) => unknown | Promise<unknown>, incoming: Req | null = null): Promise<PumpResult> {
  if (incoming) stack[stack.length - 1].ret = await execHere(incoming);
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (ownsHere((r as Req).tier)) { stack[stack.length - 1].ret = await execHere(r as Req); }  // see the Req/PumpResult note above — r is never "throw" here
    else return { done: false, request: r as Req, stack };
  }
}

type Mode = "full" | "delta";
interface Net { wire: number; full: number; fetchBytes: number; fetches: number; modes: Mode[] }

// min(delta, full) with §5 excision unified: exciseForCapture first so BOTH paths agree on handles;
// the full path ships the binary wire over the subbed graph (handles where big subgraphs were).
function ship(session: Session, tier: Tier, stack: Frame[], request: Req, net: Net): { mode: Mode; bin: Uint8Array } {
  exciseForCapture(session, stack, request, tier, THRESH);
  const subbed = subForFullWire(session, stack, request);
  const full = encodeWireBinary(subbed.stack, subbed.request, {});
  net.full += full.length;
  const take = (mode: Mode, bin: Uint8Array): { mode: Mode; bin: Uint8Array } => { net.wire += bin.length; net.modes.push(mode); return { mode, bin }; };
  if (!session.based) { adoptBaseline(session, stack, request); return take("full", full); }
  const plan = planDelta(session, stack, request, { tier, threshold: THRESH });
  if (plan.bytes.length <= full.length) { plan.commit(); return take("delta", plan.bytes); }
  adoptBaseline(session, stack, request); return take("full", full);
}
function recv(session: Session, mode: Mode, bin: Uint8Array) {
  if (mode === "delta") return applyDeltaTracked(session, bin);
  const { stack, request } = decodeWireBinary(bin);
  adoptBaseline(session, stack, request);
  return { stack, request };
}

const ownsServer = (tier: string): boolean => tier === "server";
const ownsBrowser = (tier: string): boolean => tier === "browser";
const serverTier = makeTier("server"), browserTier = makeTier("browser");

// the big reference dataset the continuation carries, plus the server's scripted change feed
const CATALOG = { items: Array.from({ length: 600 }, (_, i) => ({ id: i, name: "item " + i, detail: "lorem ipsum ".repeat(8) })) };
const POLLS = [
  { kind: "add", id: 1, label: "alpha" }, { kind: "add", id: 2, label: "beta" }, { kind: "add", id: 3, label: "gamma" },
  { kind: "heat", idx: 0 }, { kind: "label", idx: 1, label: "beta-2" }, { kind: "heat", idx: 2 },
  { kind: "add", id: 4, label: "delta" }, { kind: "label", idx: 0, label: "alpha-2" }, { kind: "heat", idx: 1 },
  { kind: "label", idx: 3, label: "delta-2" }, { kind: "heat", idx: 3 },
];
const apiExec = (req: Req): unknown => {
  if (req.name === "api.getCatalog") return CATALOG;                    // big reference dataset, fetched once
  if (req.name !== "api.poll") throw new Error("no resource " + req.name);
  const i = req.args[0] as number;                                      // api.poll's single arg is the cursor
  return i >= POLLS.length ? { stop: true } : { ...POLLS[i], cursor: i + 1 };
};

const serverSess = makeTrackedSession("server"), browserSess = makeTrackedSession("browser");
const net: Net = { wire: 0, full: 0, fetchBytes: 0, fetches: 0, modes: [] };

// ---------------------------------------------------------------- server tier ----
const wss = new WebSocketServer({ port: 0 });
await new Promise<void>((r) => wss.on("listening", r));
const PORT = wss.address().port;
const serverDone = new Promise((resolve, reject) => {
  wss.on("connection", async (ws: any) => {
    const peer = makePeer(wsPort(ws));
    peer.on("fetch", (req) => ({ obj: { graph: encodeGraph([serverTier.heapGet(req.id)]) } }));   // serve a handle's data from the heap
    try {
      __setDirtySink((o) => touch(serverSess, o));
      let res = await pumpLocal(initialStack("Board"), ownsServer, apiExec);
      while (!res.done) {
        const msg = ship(serverSess, serverTier, res.stack, res.request, net);                     // server → browser
        const { obj: reply, bin } = await peer.request({ type: "resume", mode: msg.mode }, msg.bin);
        if (reply.type === "error") throw new Error("browser: " + reply.message);
        if (reply.type === "done") { res = { done: true, value: reply.value }; break; }
        const { stack, request } = recv(serverSess, reply.mode, bin!);                             // browser → server
        __setDirtySink((o) => touch(serverSess, o));
        res = await pumpLocal(stack as Frame[], ownsServer, apiExec, request as Req | null);
      }
      resolve(res.value);
    } catch (e) { reject(e); }
  });
});

// --------------------------------------------------------------- browser tier ----
const ws = new WebSocket(`ws://localhost:${PORT}`);
const peer = makePeer(wsPort(ws));
let derefRows = -1;
async function fetchHandle(h: Handle): Promise<unknown> {                // deref over the socket: pull the dataset from its owner
  const { obj } = await peer.request({ type: "fetch", id: h.id });
  net.fetches++; net.fetchBytes += JSON.stringify(obj.graph).length;
  return decodeGraph(obj.graph)[0];
}
const commitExec = (): unknown => ({ note: "rendered", done: false });   // the browser "renders" the model
peer.on("resume", async (payload, bin) => {
  try {
    const { stack, request } = recv(browserSess, payload.mode, bin!);
    // the catalog rode as a §5 handle (its own frame local); deref it once over the socket to render its detail
    if (derefRows < 0 && stack[0] && isHandle(stack[0].catalog)) {
      const c = (await fetchHandle(stack[0].catalog)) as { items: unknown[] };                     // this app's own CATALOG shape
      derefRows = c.items.length;
    }
    __setDirtySink((o) => touch(browserSess, o));
    const res = await pumpLocal(stack as Frame[], ownsBrowser, commitExec, request as Req | null);
    if (res.done) return { obj: { type: "done", value: res.value } };
    const msg = ship(browserSess, browserTier, res.stack, res.request, net);                       // browser → server
    return { obj: { type: "suspend", mode: msg.mode }, bin: msg.bin };
  } catch (e: any) { return { obj: { type: "error", message: String((e && e.message) || e) } }; }
});
await new Promise<void>((r, j) => { ws.on("open", r); ws.on("error", j); });

// ----------------------------------------------------------------------- run ----
const value = await serverDone;
ws.close(); wss.close();
const fulls = net.modes.filter((m) => m === "full").length, deltas = net.modes.filter((m) => m === "delta").length;
const inlineCatalog = JSON.stringify(encodeGraph([CATALOG])).length;

console.log("LIVE delta over a real websocket — bounce + min(delta,full) + §5 excision + deref, composed\n");
check("the continuation bounced across the socket many times (server↔browser each hop)", net.modes.length >= 18, `(${net.modes.length} crossings)`);
check("the cold crossing shipped a full binary frame; the warm crossings shipped deltas", net.modes[0] === "full" && deltas >= net.modes.length - 4, `(${deltas} delta / ${fulls} full)`);
check("the 600-item catalog stayed home — it never crossed inline (the total wire is far under it)", net.wire < inlineCatalog / 4, `(wire ${fmt(net.wire)} vs catalog ${fmt(inlineCatalog)})`);
check("the browser DEREFED the catalog handle over the socket and got the real data (600 items)", net.fetches === 1 && derefRows === 600);
check("min(delta, full) beat re-shipping the full frame every hop", net.wire < net.full, `(${fmt(net.wire)} vs ${fmt(net.full)})`);
check(`the session ran to completion with the right result (${POLLS.length} changes)`, value === POLLS.length, `(hops=${value})`);

console.log(`\nWire: ${fmt(net.wire)} continuation (${deltas} delta + ${fulls} full) + ${fmt(net.fetchBytes)} one deref, ` +
  `vs ${fmt(inlineCatalog)} if the catalog rode every hop. The big data stayed home; only UI deltas crossed.`);
console.log(ok()
  ? "PASS — over a real socket: bounce + min(delta,full) + §5 excision + deref all compose, end to end"
  : "FAIL");
process.exit(ok() ? 0 : 1);

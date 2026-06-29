// LIVE write-tracked DELTA over a real websocket. The continuation bounces server↔browser every hop
// (api.poll on the server, commit on the browser), and the whole pipeline is real: the compiler's
// __dirty barriers (delta-app compiled with --track-writes) feed a per-tier delta session through an
// installed sink, and each crossing ships min(delta, full) — the compact full binary wire on the cold
// first hop (then both tiers adoptBaseline to a shared baseline), a write-tracked delta on every warm
// hop after. Headless (the "browser" tier is a ws peer), but the socket, the serialize/deserialize
// boundary, and the dirty tracking are the real ones — this is the live integration the bench models.
//
// Run:  node src/delta-live.mjs
import { createRequire } from "node:module";
import { wsPort, makePeer } from "./transport.mjs";
import { initialStack } from "./runtime.mjs";
import { encodeWireBinary, decodeWireBinary } from "./wire-binary.mjs";
import { makeTrackedSession, planDelta, applyDeltaTracked, adoptBaseline, touch } from "./wire-delta.mjs";
import { PROGRAMS, __setDirtySink } from "./delta-app.gen.mjs";

const { WebSocketServer, WebSocket } = createRequire("/home/user/stackmix/")("ws");
const fmt = (n) => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB");
let pass = true;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); pass = pass && cond; };

// drive PROGRAMS on the local tier: run owned resources inline, stop at the first foreign one
async function pumpLocal(stack, ownsHere, execHere, incoming = null) {
  if (incoming) stack[stack.length - 1].ret = await execHere(incoming);
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (ownsHere(r.tier)) { stack[stack.length - 1].ret = await execHere(r); }
    else return { done: false, request: r, stack };
  }
}

// min(delta, full) on the wire. With no baseline yet (or when a delta would be no smaller than the
// full frame), ship the compact full binary wire and adoptBaseline; otherwise ship the delta.
function ship(session, stack, request, net) {
  const full = encodeWireBinary(stack, request, {});
  net.full += full.length;
  if (!session.based) { adoptBaseline(session, stack, request); net.wire += full.length; net.modes.push("full"); return { mode: "full", bin: full }; }
  const plan = planDelta(session, stack, request);
  if (plan.bytes.length <= full.length) { plan.commit(); net.wire += plan.bytes.length; net.modes.push("delta"); return { mode: "delta", bin: plan.bytes }; }
  adoptBaseline(session, stack, request); net.wire += full.length; net.modes.push("full"); return { mode: "full", bin: full };
}
function recv(session, mode, bin) {
  if (mode === "delta") return applyDeltaTracked(session, bin);
  const { stack, request } = decodeWireBinary(bin);
  adoptBaseline(session, stack, request);
  return { stack, request };
}

const ownsServer = (tier) => tier === "server";
const ownsBrowser = (tier) => tier === "browser";

// the server's scripted change feed: build up some rows, then a run of deep in-place edits
const POLLS = [
  { kind: "add", id: 1, label: "alpha" }, { kind: "add", id: 2, label: "beta" }, { kind: "add", id: 3, label: "gamma" },
  { kind: "add", id: 4, label: "delta" }, { kind: "add", id: 5, label: "epsilon" }, { kind: "add", id: 6, label: "zeta" },
  { kind: "heat", idx: 0 }, { kind: "label", idx: 1, label: "beta-2" }, { kind: "heat", idx: 4 },
  { kind: "label", idx: 2, label: "gamma-2" }, { kind: "heat", idx: 3 }, { kind: "label", idx: 5, label: "zeta-2" },
  { kind: "heat", idx: 1 }, { kind: "label", idx: 0, label: "alpha-2" },
];
const apiExec = (req) => { if (req.name !== "api.poll") throw new Error("no resource " + req.name); const i = req.args[0]; return i < POLLS.length ? { ...POLLS[i], cursor: i + 1 } : { stop: true }; };
const commitExec = () => ({ note: "rendered", done: false });   // the browser "renders" the model and returns an interaction

const serverSess = makeTrackedSession("server");
const browserSess = makeTrackedSession("browser");
const net = { wire: 0, full: 0, modes: [] };

// ---------------------------------------------------------------- server tier ----
const wss = new WebSocketServer({ port: 0 });
await new Promise((r) => wss.on("listening", r));
const PORT = wss.address().port;
const serverDone = new Promise((resolve, reject) => {
  wss.on("connection", async (ws) => {
    const peer = makePeer(wsPort(ws));
    try {
      __setDirtySink((o) => touch(serverSess, o));
      let res = await pumpLocal(initialStack("Board"), ownsServer, apiExec);    // runs to the first commit
      while (!res.done) {
        const msg = ship(serverSess, res.stack, res.request, net);              // server → browser
        const { obj: reply, bin } = await peer.request({ type: "resume", mode: msg.mode }, msg.bin);
        if (reply.type === "error") throw new Error("browser: " + reply.message);
        if (reply.type === "done") { res = { done: true, value: reply.value }; break; }
        const { stack, request } = recv(serverSess, reply.mode, bin);           // browser → server
        __setDirtySink((o) => touch(serverSess, o));
        res = await pumpLocal(stack, ownsServer, apiExec, request);
      }
      resolve(res.value);
    } catch (e) { reject(e); }
  });
});

// --------------------------------------------------------------- browser tier ----
const ws = new WebSocket(`ws://localhost:${PORT}`);
const peer = makePeer(wsPort(ws));
peer.on("resume", async (payload, bin) => {
  try {
    const { stack, request } = recv(browserSess, payload.mode, bin);
    __setDirtySink((o) => touch(browserSess, o));
    const res = await pumpLocal(stack, ownsBrowser, commitExec, request);
    if (res.done) return { obj: { type: "done", value: res.value } };
    const msg = ship(browserSess, res.stack, res.request, net);                 // browser → server
    return { obj: { type: "suspend", mode: msg.mode }, bin: msg.bin };
  } catch (e) { return { obj: { type: "error", message: String((e && e.message) || e) } }; }
});
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });

// ----------------------------------------------------------------------- run ----
const value = await serverDone;
ws.close(); wss.close();

const fulls = net.modes.filter((m) => m === "full").length, deltas = net.modes.filter((m) => m === "delta").length;
console.log("LIVE write-tracked delta over a real websocket — the continuation bounces, shipping min(delta, full)\n");
check("the continuation bounced across the socket many times (server↔browser each hop)", net.modes.length >= 20, `(${net.modes.length} crossings)`);
check("the cold first crossing shipped the full binary wire (no shared baseline yet)", net.modes[0] === "full");
check("the warm crossings shipped deltas (the compiler's barriers drove write-tracking)", deltas >= net.modes.length - 4, `(${deltas} delta / ${fulls} full)`);
check("min(delta, full) beat re-shipping the full frame every hop", net.wire < net.full, `(${fmt(net.wire)} vs ${fmt(net.full)})`);
check(`the session ran to completion with the right result (${POLLS.length} changes applied)`, value === POLLS.length, `(hops=${value})`);

console.log(`\nWire over the socket: ${fmt(net.wire)} via min(delta,full) (${deltas} delta + ${fulls} full crossings) ` +
  `vs ${fmt(net.full)} if every crossing re-shipped the full frame — ${(100 * (1 - net.wire / net.full)).toFixed(0)}% less.`);
console.log(pass
  ? "PASS — over a real socket: the compiler-tracked continuation shipped deltas, min(delta, full), end to end"
  : "FAIL");
process.exit(pass ? 0 : 1);

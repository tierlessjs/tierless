// LIVE §6 migrate-vs-fetch over a real websocket. At a pure-DATA foreign resource the
// driver has a real choice: ship THIS continuation to the resource's tier (migrate — the
// working set travels with the computation), or pull the resource's data back over the
// socket and finish where we are (fetch — only the result travels). It prices both with
// REAL measured bytes and picks the cheaper one (§6). Then it actually performs the chosen
// path over the socket, so the bytes that cross are the bytes it priced.
//
// This is the in-process examples/policy cost model, but wired into the live pump so the
// decision genuinely changes the network behaviour. (We ship the FULL continuation on a
// migrate — no §5 handle excision — because §6's whole point is that a large live working
// set is what makes migrating expensive; §5 excision is the complementary optimization,
// proven separately in heap-live.mjs.)
//
// Run:  node src/policy-live.mjs
import { createRequire } from "node:module";
import { wsPort, makePeer } from "stackmix/transport";
import { encodeWireBinary, decodeWireBinary } from "stackmix/wire";   // the §6 decision prices the real (binary) wire
import { PROGRAMS } from "./policy-app.gen.mjs";

const { WebSocketServer, WebSocket } = createRequire("/home/user/stackmix/")("ws");
const fmt = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");
let pass = true;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); pass = pass && cond; };

// One pump, both tiers: run owned resources inline, push sub-frames on a call, stop at a
// resource this tier doesn't own (the §6 boundary). Same logic as runtime.mjs / heap-live.
function pumpLocal(stack, ownsHere, execHere, incoming = null) {
  if (incoming) stack[stack.length - 1].ret = execHere(incoming);
  for (;;) {
    const top = stack[stack.length - 1];
    const r = PROGRAMS[top.fn](top);
    if (r.op === "return") { stack.pop(); if (!stack.length) return { done: true, value: r.value }; stack[stack.length - 1].ret = r.value; }
    else if (r.op === "call") { stack.push({ fn: r.fn, pc: 0, args: r.args }); }
    else if (ownsHere(r.tier)) { stack[stack.length - 1].ret = execHere(r); }
    else return { done: false, request: r, stack };
  }
}

// The §6 decision, priced with real bytes. A side-effecting resource (no fetchBytes) can
// only be reached by migrating. A data resource offers the genuine choice; when uninformed
// (cold) the fetch isn't priced yet so we migrate — the naive "only cross when forced".
function decide(contBytes, fetchBytes, mode) {
  if (mode === "cold") return { choice: "migrate", why: "fetch not yet priced (cost = infinite)" };
  if (fetchBytes === Infinity) return { choice: "migrate", why: "side effect: cannot fetch" };
  return contBytes <= fetchBytes
    ? { choice: "migrate", why: `continuation ${fmt(contBytes)} <= data ${fmt(fetchBytes)}` }
    : { choice: "fetch", why: `data ${fmt(fetchBytes)} < continuation ${fmt(contBytes)}` };
}

// ---------------------------------------------------------------- server tier ----
// Owns the data resource api.fetchData(k) -> k rows. Serves two endpoints: `rpc` runs ONE
// resource and ships its result back (the fetch path); `resume` runs a migrated
// continuation to completion here (the migrate path).
const ownsServer = (tier) => tier === "server";
const makeData = (k) => Array.from({ length: k }, (_, i) => ({ id: i, v: "data-" + i }));
const apiExec = (req) => { if (req.name === "api.fetchData") return makeData(req.args[0]); throw new Error("no resource " + req.name); };

const wss = new WebSocketServer({ port: 0 });
await new Promise((r) => wss.on("listening", r));
const PORT = wss.address().port;
const serverReady = new Promise((resolve) => {
  wss.on("connection", (ws) => {
    const peer = makePeer(wsPort(ws));
    peer.on("rpc", (m) => {                                   // FETCH: compute one resource, report result + its real size
      const result = apiExec(m.request);
      return { obj: { type: "rpcResult", result, bytes: Buffer.byteLength(JSON.stringify(result)) } };
    });
    peer.on("resume", (payload, bin) => {                     // MIGRATE: run the migrated continuation here to completion
      try {
        const { stack, request } = decodeWireBinary(bin);
        const r = pumpLocal(stack, ownsServer, apiExec, request);  // `request` = the api.fetchData we suspended on; run it here
        if (r.done) return { obj: { type: "done", value: r.value } };
        return { obj: { type: "suspend" }, bin: encodeWireBinary(r.stack, r.request, {}) };
      } catch (e) { return { obj: { type: "error", message: String((e && e.message) || e) } }; }
    });
    resolve();
  });
});

// --------------------------------------------------------------- browser tier ----
// The entry/driver. Builds a working set, hits api.fetchData (a server resource), and at
// that boundary decides migrate-vs-fetch from real bytes, then executes the choice.
const ownsBrowser = () => false;                              // this app's only resource is the server's
const browserExec = () => { throw new Error("browser owns no resource in this app"); };
const ws = new WebSocket(`ws://localhost:${PORT}`);
const peer = makePeer(wsPort(ws));
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
await serverReady;

// Drive Survey(workSize, dataKey) on the browser. `mode` ("cold"|"informed") and `profile`
// (site -> sampled fetch bytes, locked in once) feed the §6 decision. `site` names the call
// path so the locked profile is consulted per path (§6: "typical result size per call path").
// Returns the result plus what was decided and how many bytes really crossed the socket.
async function runSurvey(workSize, dataKey, { mode, profile, site }) {
  let res = pumpLocal([{ fn: "Survey", pc: 0, args: [workSize, dataKey] }], ownsBrowser, browserExec);
  let report = null, crossed = 0;
  while (!res.done) {
    const req = res.request;
    const contBytes = encodeWireBinary(res.stack, req, {}).length;  // ship-the-continuation cost (full working set, real binary bytes)
    const fetchBytes = profile.has(site) ? profile.get(site) : Infinity;
    const d = decide(contBytes, fetchBytes, mode);
    report = { choice: d.choice, why: d.why, contBytes, fetchBytes, cold: decide(contBytes, fetchBytes, "cold").choice };
    if (d.choice === "migrate") {
      let wire = encodeWireBinary(res.stack, req, {});              // the continuation crosses (binary frame)
      crossed += wire.length;
      let { obj: reply, bin } = await peer.request({ type: "resume" }, wire);
      while (reply.type === "suspend") {                            // (Survey never bounces back, but keep the loop correct)
        const got = decodeWireBinary(bin);
        const r2 = pumpLocal(got.stack, ownsBrowser, browserExec, got.request);
        if (r2.done) { reply = { type: "done", value: r2.value }; break; }
        wire = encodeWireBinary(r2.stack, r2.request, {}); crossed += wire.length;
        ({ obj: reply, bin } = await peer.request({ type: "resume" }, wire));
      }
      if (reply.type === "error") throw new Error("server: " + reply.message);
      return { value: reply.value, report, crossed };
    } else {
      const { obj } = await peer.request({ type: "rpc", request: { name: req.name, args: req.args } });  // only the data crosses
      if (obj.type === "error") throw new Error("server: " + obj.message);
      crossed += obj.bytes;
      res.stack[res.stack.length - 1].ret = obj.result;            // inject the fetched data; finish locally (cont stayed home)
      res = pumpLocal(res.stack, ownsBrowser, browserExec);
    }
  }
  return { value: res.value, report, crossed };
}

// One-time PROFILING (§6 "sampling, not always-on"): sample each call path's data size once
// over the socket and lock it in. Production runs then decide with zero further sampling.
async function sample(name, args) {
  const { obj } = await peer.request({ type: "rpc", request: { name, args } });
  return obj.bytes;
}

console.log("LIVE §6 migrate-vs-fetch over a real websocket — the decision steers what crosses\n");

const profile = new Map();
let sampleBytes = 0;
// Two call paths: "page" pulls a big result, "fact" pulls a tiny one. Sample each once.
const pageBytes = await sample("api.fetchData", [4000]); sampleBytes += pageBytes; profile.set("page", pageBytes);
const factBytes = await sample("api.fetchData", [1]);    sampleBytes += factBytes; profile.set("fact", factBytes);

// --- Regime 1: SMALL continuation, BIG data -> migrate (the §5 "stack < heap" case) -----
const r1 = await runSurvey(2, 4000, { mode: "informed", profile, site: "page" });
console.log("Regime 1: tiny working set, large data (build 2 rows, then need a 4000-row page)");
console.log(`  migrate=${fmt(r1.report.contBytes)}  fetch=${fmt(r1.report.fetchBytes)}  -> cold ${r1.report.cold.toUpperCase()}, informed ${r1.report.choice.toUpperCase()} (${r1.report.why})`);
check("regime 1 computed the right answer", r1.value && r1.value.work === 2 && r1.value.data === 4000);
check("regime 1 chose MIGRATE (continuation cheaper than the data)", r1.report.choice === "migrate");
check("regime 1 actually shipped the continuation over the socket", r1.crossed === r1.report.contBytes);

// --- Regime 2: BIG continuation, SMALL data -> the FLIP: cold migrates, informed fetches -
const r2 = await runSurvey(4000, 1, { mode: "informed", profile, site: "fact" });
console.log("\nRegime 2: large working set, one small fact (build 4000 rows, then need 1 row)");
console.log(`  migrate=${fmt(r2.report.contBytes)}  fetch=${fmt(r2.report.fetchBytes)}  -> cold ${r2.report.cold.toUpperCase()}, informed ${r2.report.choice.toUpperCase()} (${r2.report.why})`);
check("regime 2 computed the right answer", r2.value && r2.value.work === 4000 && r2.value.data === 1);
check("regime 2's COLD rule would have migrated (the naive baseline)", r2.report.cold === "migrate");
check("regime 2's INFORMED rule FLIPS to fetch (data cheaper than the continuation)", r2.report.choice === "fetch");
check(`regime 2 kept the big continuation home: only ${fmt(r2.crossed)} crossed, not the ${fmt(r2.report.contBytes)} continuation`,
  r2.crossed < r2.report.contBytes / 10);

ws.close(); wss.close();

console.log(`\nProfiling cost ${fmt(sampleBytes)} once (locked in). Then: regime 1 shipped the ${fmt(r1.crossed)} continuation;`);
console.log(`regime 2 fetched ${fmt(r2.crossed)} and stayed put — a ${(r2.report.contBytes / r2.crossed).toFixed(0)}x saving the cold rule would have missed.`);
console.log(pass
  ? "PASS — §6 live: the driver priced migrate vs fetch from real bytes and steered the socket accordingly"
  : "FAIL");
process.exit(pass ? 0 : 1);

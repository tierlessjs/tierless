// LIVE §5 handle heap over a real websocket. The server holds a big dataset; when the
// continuation migrates to the browser to commit a small summary, the dataset stays home
// as a §5 handle — only the summary crosses the socket. When the browser then derefs the
// handle (it needs a row's detail), the dataset is fetched back over the SAME socket,
// single-writer coherent. Headless (the "browser" tier is a ws peer; no Chromium needed
// for the heap point), but the socket and the serialize/deserialize boundary are real.
//
// Run:  node src/heap-live.mjs
import { createRequire } from "node:module";
import { wsPort, makePeer } from "tierless/transport";
import { encodeGraph, decodeGraph } from "tierless/graph";
import { initialStack } from "tierless/runtime";
import { makeTier } from "tierless/heap";
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";   // the binary continuation wire crosses the socket
import { PROGRAMS } from "./heap-app.gen.mjs";
import { makeCheck } from "../lib/check.mts";

const { WebSocketServer, WebSocket } = createRequire(import.meta.url)("ws");
const fmt = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");
const THRESH = 8192;
const { check, ok } = makeCheck();

// a local pump variant: heap-live frames the wire itself (§5 excision + deref-over-socket),
// so drive it with the identical pump logic (push sub-frames, run owned resources, stop at
// a foreign one). The wire/heap/transport are the real ones.
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

// ---- the dataset that lives on the server ----
const body = "markdown body. ".repeat(40);
const ROWS = Array.from({ length: 1500 }, (_, i) => ({ id: i, title: "Article " + i, score: i % 100, body }));
const expectedTotal = ROWS.reduce((s, r) => s + r.score, 0);

const serverTier = makeTier("server");
const browserTier = makeTier("browser");
const ownsServer = (tier) => tier === "server";
const ownsBrowser = (tier) => tier === "browser";
const apiExec = (req) => { if (req.name === "api.getRows") return ROWS; throw new Error("no resource " + req.name); };

const net = { resumeBytes: 0, fetchBytes: 0, fetches: 0 };

// ---------------------------------------------------------------- server tier ----
const wss = new WebSocketServer({ port: 0 });
await new Promise((r) => wss.on("listening", r));
const PORT = wss.address().port;
const serverDone = new Promise((resolve, reject) => {
  wss.on("connection", async (ws) => {
    const peer = makePeer(wsPort(ws));
    // serve fetch{id}: ship the master object from this tier's heap, identity/cycle-safe, with its version
    peer.on("fetch", (req) => ({ obj: { type: "fetchResult", version: serverTier.heap.version(req.id), graph: encodeGraph([serverTier.heapGet(req.id)]) } }));
    try {
      let res = await pumpLocal(initialStack("Report"), ownsServer, apiExec);   // render starts here, runs to commit
      while (!res.done) {
        const wire = encodeWireBinary(res.stack, res.request, { tier: serverTier, threshold: THRESH });  // excise big locals into serverTier.heap
        net.resumeBytes += wire.length;
        const { obj: reply, bin } = await peer.request({ type: "resume" }, wire);   // continuation rides the binary frame
        if (reply.type === "error") throw new Error("browser: " + reply.message);
        if (reply.type === "done") { res = { done: true, value: reply.value }; break; }
        const { stack, request } = decodeWireBinary(bin);
        res = await pumpLocal(stack, ownsServer, apiExec, request);
      }
      resolve(res.value);
    } catch (e) { reject(e); }
  });
});

// --------------------------------------------------------------- browser tier ----
// commit returns a scripted event; deref fetches the handle from its owner over the socket.
const ws = new WebSocket(`ws://localhost:${PORT}`);
const peer = makePeer(wsPort(ws));
const cache = new Map();   // id -> { version, copy }  (single-writer, version-keyed)
let committed = null;

async function fetchHandle(h) {
  const c = cache.get(h.id);
  // (a real reader would cheaply consult the owner's version first; here every deref fetches, then caches)
  const { obj } = await peer.request({ type: "fetch", id: h.id });
  net.fetches++; net.fetchBytes += JSON.stringify(obj.graph).length;
  if (c && c.version === obj.version) return c.copy;
  const copy = decodeGraph(obj.graph)[0];
  cache.set(h.id, { version: obj.version, copy });
  return copy;
}
const domCommit = (req) => { committed = req.args[0]; return { want: 2 }; };  // the "user" asks for row 2's detail

async function pumpBrowser(stack, incoming) {
  let res = await pumpLocal(stack, ownsBrowser, domCommit, incoming);
  while (!res.done) {
    if (res.request.name === "deref") {
      const h = res.request.args[0];
      const val = h.owner === browserTier.id ? browserTier.heapGet(h.id) : await fetchHandle(h);  // local? else fetch over the socket
      res.stack[res.stack.length - 1].ret = val;
      res = await pumpLocal(res.stack, ownsBrowser, domCommit);
    } else return res;   // a server resource: hand the continuation back
  }
  return res;
}
peer.on("resume", async (payload, bin) => {
  try {
    const { stack, request } = decodeWireBinary(bin);
    const res = await pumpBrowser(stack, request);
    if (res.done) return { obj: { type: "done", value: res.value } };
    return { obj: { type: "suspend" }, bin: encodeWireBinary(res.stack, res.request, { tier: browserTier, threshold: THRESH }) };
  } catch (e) { return { obj: { type: "error", message: String((e && e.message) || e) } }; }
});
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });

// ----------------------------------------------------------------------- run ----
const value = await serverDone;
const inlineBytes = JSON.stringify(encodeGraph([ROWS])).length;   // what shipping the dataset would have cost
ws.close(); wss.close();

console.log("LIVE §5 handle heap over a real websocket — big dataset stays server-side, fetched on deref\n");
check("commit migrated to the browser carrying a §5 handle, not the dataset", net.resumeBytes > 0);
check("the dataset did NOT cross on the commit (the resume wire is tiny)", net.resumeBytes < inlineBytes / 50, `(resume ${fmt(net.resumeBytes)} vs dataset ${fmt(inlineBytes)})`);
check("the browser committed the small summary (count + total)", committed && committed.count === 1500 && committed.total === expectedTotal);
check("the browser's deref fetched the dataset back over the SAME socket", net.fetches === 1 && net.fetchBytes > inlineBytes / 2);
check(`the fetched dataset gave the right detail (got ${JSON.stringify(value)})`, value === "Article 2");

console.log(`\nWire: commit ${fmt(net.resumeBytes)} (handle) + deref ${fmt(net.fetchBytes)} (fetched once) ` +
  `vs ${fmt(inlineBytes)} if the dataset always travelled.`);
console.log(ok()
  ? "PASS — over a real socket: the dataset stayed on the server, crossing only when the browser derefed it"
  : "FAIL");
process.exit(ok() ? 0 : 1);

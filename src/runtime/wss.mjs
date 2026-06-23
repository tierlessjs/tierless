// Stackmix — WebSocket transport: migrate a live continuation between a browser
// tier and a server tier over a single ws connection, and fetch §5 handles on
// demand across that same socket. This file is browser-safe: it has no Node
// `Buffer` or stream dependency (the frame codec uses TextEncoder/Uint8Array),
// and the only WebSocket reference is the injectable `globalThis.WebSocket` the
// browser owns. The Node server binder that needs the `ws` package lives in
// wss-server.mjs, so importing `#stackmix` in a browser never pulls in `ws`.
//
// Protocol — one discrete message per ws frame, length-prefixed JSON + optional
// binary so it matches the stdio frame layout:
//   request  { kind:"request", id, payload }
//   reply    { kind:"reply",   id, payload }
// payloads:
//   resume   { type:"resume", wire }   -> { type:"done", value } | { type:"suspend", wire } | { type:"error" }
//   fetch    { type:"fetch",  id }     -> { type:"fetchResult" } + the object's graph as the binary attachment
// Either side may issue either request; correlation ids let a fetch nest inside
// an in-flight resume (e.g. the server dereferencing a browser-owned handle).

import {
  Suspend, Miss, serializeContinuation, deserializeContinuation, initialFrames,
} from "./core.mjs";
import { encodeGraph, decodeGraph } from "./heap.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const EMPTY = new Uint8Array(0);

// One protocol message -> one binary ws frame: [u32 jsonLen][u32 binLen][json][bin].
export function encodeMessage(obj, bin = EMPTY) {
  const json = te.encode(JSON.stringify(obj));
  const b = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
  const out = new Uint8Array(8 + json.length + b.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, json.length); dv.setUint32(4, b.length);          // big-endian, like frame.mjs
  out.set(json, 8); if (b.length) out.set(b, 8 + json.length);
  return out;
}

export function decodeMessage(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data); // ArrayBuffer (browser) or Buffer/Uint8Array (ws)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const jsonLen = dv.getUint32(0), binLen = dv.getUint32(4);
  const obj = JSON.parse(td.decode(u8.subarray(8, 8 + jsonLen)));
  const bin = binLen ? u8.subarray(8 + jsonLen, 8 + jsonLen + binLen) : null;
  return { obj, bin };
}

// Adapt a WebSocket-like object (a browser `WebSocket` or a `ws` socket) to a
// small duplex port, normalizing the two event APIs (`.on` vs `addEventListener`)
// and the binary payload types.
export function wsPort(ws) {
  ws.binaryType = "arraybuffer";
  const on = (event, fn) => (typeof ws.on === "function" ? ws.on(event, fn) : ws.addEventListener(event, fn));
  return {
    send(obj, bin) { ws.send(encodeMessage(obj, bin)); },
    onMessage(cb) { on("message", (ev) => { const data = ev && ev.data !== undefined ? ev.data : ev; const { obj, bin } = decodeMessage(data); cb(obj, bin); }); },
    onClose(cb) { on("close", () => cb()); },
    close() { ws.close(); },
  };
}

// RPC correlation over a port: request() awaits a matching reply; inbound
// requests are dispatched to type handlers. A handler returns { obj, bin? }.
export function makePeer(port) {
  let nextId = 1;
  const pending = new Map();   // id -> resolve({ obj, bin })
  const handlers = new Map();  // type -> (payload, bin) => { obj, bin? } | Promise<...>
  port.onMessage((m, bin) => {
    if (m.kind === "reply") { const r = pending.get(m.id); if (r) { pending.delete(m.id); r({ obj: m.payload, bin }); } return; }
    const h = handlers.get(m.payload && m.payload.type);
    Promise.resolve(h ? h(m.payload, bin) : { obj: { type: "error", message: "no handler for " + (m.payload && m.payload.type) } })
      .then((res) => port.send({ kind: "reply", id: m.id, payload: res.obj }, res.bin))
      .catch((e) => port.send({ kind: "reply", id: m.id, payload: { type: "error", message: String((e && e.message) || e) } }));
  });
  return {
    request(payload, bin) { const id = nextId++; return new Promise((res) => { pending.set(id, res); port.send({ kind: "request", id, payload }, bin); }); },
    on(type, handler) { handlers.set(type, handler); },
    close() { port.close(); },
  };
}

// A deref host for cross-socket fetch: local handles resolve from this tier's
// heap, already-fetched ones from `cache`, anything else returns a Miss that the
// run loop turns into a fetch over the peer. The cache is exposed so the loop can
// populate it after a fetch.
export function makeWssHost(tier) {
  const cache = new Map();
  return {
    cache,
    deref(h) {
      if (h.owner === tier.id) return tier.heapGet(h.id);
      if (cache.has(h.id)) return cache.get(h.id);
      return new Miss(h);   // the interpreter turns a Miss into a fetch suspension
    },
  };
}

// Run frames on `tier` until the program finishes or hits a resource this tier
// lacks. A deref-miss is resolved inline by fetching the object from the peer
// (its owner) and re-running — the deref ops are re-runnable by construction.
// Returns { done:true, value } or { migrate:true, cont } for the caller to ship.
async function runLocal(rt, tier, host, peer, frames, pending) {
  while (true) {
    try {
      if (pending) { frames[frames.length - 1].stack.push(tier.resources[pending.name](pending.args)); pending = null; }
      const res = rt.run(tier, frames, host);
      return { done: true, value: res.value };
    } catch (e) {
      if (!(e instanceof Suspend)) throw e;
      if (e.pending && e.pending.fetch) {                       // deref-miss -> fetch from the owner over the socket
        const handle = e.pending.fetch;
        const { bin } = await peer.request({ type: "fetch", id: handle.id });
        host.cache.set(handle.id, decodeGraph(JSON.parse(td.decode(bin)))[0]);
        frames = e.frames; pending = null; continue;            // re-run; the deref now hits cache
      }
      return { migrate: true, cont: { frames: e.frames, pending: e.pending } };
    }
  }
}

// Drive a program from this (browser) tier: run locally, and whenever a resource
// forces a move, ship the continuation to the server and resume its reply. Big
// data never travels — it stays a §5 handle, fetched only if actually touched.
// `onMigrate(dir, wire)` (optional) observes each crossing for reporting/tracing:
// dir is "out" (this tier -> peer) or "back" (peer -> this tier), wire the
// serialized continuation. It does not affect control flow.
export async function drive(rt, tier, peer, { entry, args = [], host = makeWssHost(tier), onMigrate } = {}) {
  let frames = initialFrames(entry, args), pending = null;
  while (true) {
    const r = await runLocal(rt, tier, host, peer, frames, pending);
    if (r.done) return r.value;
    const wire = serializeContinuation(r.cont, tier);
    if (onMigrate) onMigrate("out", wire);
    const { obj } = await peer.request({ type: "resume", wire });
    if (obj.type === "done") return obj.value;
    if (obj.type === "error") throw new Error("server: " + obj.message);
    if (obj.type !== "suspend") throw new Error("unexpected reply " + obj.type);
    if (onMigrate) onMigrate("back", obj.wire);
    const got = deserializeContinuation(obj.wire);
    frames = got.frames; pending = got.pending;
  }
}

// Serve a (server) tier on a peer: answer `resume` by running the migrated
// continuation here — replying `done`, or `suspend` when a client-only resource
// forces it back — and answer `fetch` by shipping the owned object on demand.
export function serve(rt, tier, peer, { host = makeWssHost(tier) } = {}) {
  peer.on("fetch", (req) => ({ obj: { type: "fetchResult" }, bin: te.encode(JSON.stringify(encodeGraph([tier.heapGet(req.id)]))) }));
  peer.on("resume", async (req) => {
    try {
      const got = deserializeContinuation(req.wire);
      const r = await runLocal(rt, tier, host, peer, got.frames, got.pending);
      if (r.done) return { obj: { type: "done", value: r.value } };
      return { obj: { type: "suspend", wire: serializeContinuation(r.cont, tier) } };
    } catch (e) {
      return { obj: { type: "error", message: String((e && e.message) || e) } };
    }
  });
  return peer;
}

// Browser entry: open a ws connection to the server and run `entry` from this
// tier over it. `WebSocketImpl` defaults to the browser's global WebSocket; the
// Node test injects the `ws` client so CI exercises this exact path.
export function connectWss(url, { rt, tier, entry, args = [], host, onMigrate, WebSocketImpl = globalThis.WebSocket }) {
  const ws = new WebSocketImpl(url);
  const peer = makePeer(wsPort(ws));
  const on = (event, fn) => (typeof ws.on === "function" ? ws.on(event, fn) : ws.addEventListener(event, fn));
  const ready = ws.readyState === 1 ? Promise.resolve() : new Promise((res, rej) => {
    on("open", () => res());
    on("error", (e) => rej(e && e.message ? new Error(e.message) : new Error("ws connection error")));
  });
  return {
    peer,
    async run() { await ready; return drive(rt, tier, peer, { entry, args, host, onMigrate }); },
    close() { peer.close(); },
  };
}

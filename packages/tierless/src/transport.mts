// Tierless — WebSocket transport. Migrate a live continuation between the browser tier
// and the server tier over one ws connection, and fetch §5 handles on demand across that
// same socket. Browser-safe: no Node Buffer or stream dependency (the frame codec uses
// TextEncoder/Uint8Array), and the only WebSocket reference is the injectable
// globalThis.WebSocket the browser owns.
//
// Protocol — one discrete message per ws frame, length-prefixed JSON + optional binary:
//   request  { kind:"request", id, payload }
//   reply    { kind:"reply",   id, payload }
// Either side may issue either request; correlation ids let a fetch nest inside an
// in-flight resume (e.g. the server dereferencing a browser-owned handle).

import type { Peer } from "./types.mjs";

export type { Peer } from "./types.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const EMPTY = new Uint8Array(0);

// One protocol message -> one binary ws frame: [u32 jsonLen][u32 binLen][json][bin].
export function encodeMessage(obj: object, bin: Uint8Array | ArrayBufferLike = EMPTY): Uint8Array {
  const json = te.encode(JSON.stringify(obj));
  const b = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
  const out = new Uint8Array(8 + json.length + b.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, json.length); dv.setUint32(4, b.length);          // big-endian, like frame.mjs
  out.set(json, 8); if (b.length) out.set(b, 8 + json.length);
  return out;
}

export function decodeMessage(data: ArrayBuffer | Uint8Array): { obj: any; bin: Uint8Array | null } {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data); // ArrayBuffer (browser) or Buffer/Uint8Array (ws)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const jsonLen = dv.getUint32(0), binLen = dv.getUint32(4);
  const obj = JSON.parse(td.decode(u8.subarray(8, 8 + jsonLen)));
  const bin = binLen ? u8.subarray(8 + jsonLen, 8 + jsonLen + binLen) : null;
  return { obj, bin };
}

// Normalize the two WebSocket event APIs (Node `ws`'s .on vs the browser's addEventListener) —
// shared by wsPort below and by callers (e.g. browser.mjs's connect()) that need an event the
// port interface doesn't expose, like "open"/"error" on the raw socket. `ws` is deliberately
// untyped: it is either a browser WebSocket or a Node `ws` socket, and nothing here needs more
// than the two methods duck-typed below.
export function onEvent(ws: any, event: string, fn: (...args: any[]) => void): unknown {
  return typeof ws.on === "function" ? ws.on(event, fn) : ws.addEventListener(event, fn);
}

export interface Port {
  send(obj: object, bin?: Uint8Array): void;
  onMessage(cb: (obj: any, bin: Uint8Array | null) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}
// Adapt a WebSocket-like object (a browser WebSocket or a `ws` socket) to a small duplex
// port, normalizing the two event APIs and binary payload types.
export function wsPort(ws: any): Port {
  ws.binaryType = "arraybuffer";
  const on = (event: string, fn: (...args: any[]) => void): unknown => onEvent(ws, event, fn);
  return {
    send(obj: object, bin?: Uint8Array): void { ws.send(encodeMessage(obj, bin)); },
    onMessage(cb: (obj: any, bin: Uint8Array | null) => void): void {
      on("message", (ev: any) => {
        const data = ev && ev.data !== undefined ? ev.data : ev;
        let msg;
        try { msg = decodeMessage(data); }                              // a truncated/garbage frame throws in the decoder…
        catch { try { ws.close(1003, "malformed frame"); } catch { /* already gone */ } return; }  // …drop the peer, never the host
        cb(msg.obj, msg.bin);
      });
    },
    onClose(cb: () => void): void { on("close", () => cb()); },
    close(): void { ws.close(); },
  };
}

// RPC correlation over a port: request() awaits a matching reply; inbound requests are
// dispatched to type handlers. A handler returns { obj, bin? }.
export function makePeer(port: Port): Peer {
  let nextId = 1;
  const pending = new Map<number, (value: { obj: any; bin: Uint8Array | null }) => void>();   // id -> resolve({ obj, bin })
  const handlers = new Map<string, (payload: any, bin: Uint8Array | null) => any>();          // type -> (payload, bin) => { obj, bin? } | Promise<...>
  port.onMessage((m: any, bin) => {
    if (!m || typeof m !== "object") return;                        // well-framed but non-object payload: ignore, don't throw
    if (m.kind === "reply") { const r = pending.get(m.id); if (r) { pending.delete(m.id); r({ obj: m.payload, bin }); } return; }
    const h = handlers.get(m.payload && m.payload.type);
    Promise.resolve(h ? h(m.payload, bin) : { obj: { type: "error", message: "no handler for " + (m.payload && m.payload.type) } })
      .then((res: any) => port.send({ kind: "reply", id: m.id, payload: res.obj }, res.bin))
      .catch((e: any) => port.send({ kind: "reply", id: m.id, payload: { type: "error", message: String((e && e.message) || e) } }));
  });
  return {
    request(payload: object, bin?: Uint8Array): Promise<{ obj: any; bin: Uint8Array | null }> { const id = nextId++; return new Promise((res) => { pending.set(id, res); port.send({ kind: "request", id, payload }, bin); }); },
    on(type: string, handler: (payload: any, bin: Uint8Array | null) => any): void { handlers.set(type, handler); },
    close(): void { port.close(); },
  };
}

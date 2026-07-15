// Tierless — WebSocket transport. Migrate a live continuation between the browser tier
// and the server tier over one ws connection, and fetch §5 handles on demand across that
// same socket. Browser-safe: no Node Buffer or stream dependency (the frame codec uses
// TextEncoder/Uint8Array), and it never constructs a socket — it adapts a WebSocket-like object
// handed to it (a browser WebSocket or a Node `ws`), so the actual `new WebSocket` lives in
// browser.mts, not here.
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

// A WebTransport (HTTP/3 / QUIC) bidirectional stream is a WHATWG byte duplex, not a message
// transport — but tierless's own frame ([u32 jsonLen][u32 binLen][json][bin], encodeMessage)
// is self-delimiting, so we length-frame straight over the stream: no RFC 6455, no ws upgrade.
// Browser-safe (ReadableStream/WritableStream only), symmetric on both tiers: the browser
// passes a `WebTransport.createBidirectionalStream()` result; the server passes an incoming
// bidi stream from its H3 library (pluggable — stable Node has no H3). Why WebTransport at all:
// like ws-over-H2 it shares one connection (the QUIC connection), so no separate handshake,
// PLUS 0-RTT session resumption and no head-of-line blocking. The forward-looking transport.
// Structural stream types (not the DOM/web-stream globals) so this stays lib-agnostic: any
// object matching the WHATWG duplex shape works — a browser WebTransport stream, a Node
// web stream, an H3 library's stream.
interface ByteReader { read(): Promise<{ value?: Uint8Array; done: boolean }> }
interface ByteWriter { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }
export function wtPort(stream: { readable: { getReader(): ByteReader }; writable: { getWriter(): ByteWriter } }): Port {
  const writer = stream.writable.getWriter();
  // held on an object so the async read loop below sees reassignments (a plain `let` gets
  // narrowed to its initial null inside the closure and reads as `never`).
  const cbs: { msg: ((obj: any, bin: Uint8Array | null) => void) | null; close: (() => void) | null } = { msg: null, close: null };
  (async () => {
    const reader = stream.readable.getReader();
    let buf = new Uint8Array(0);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) { const next = new Uint8Array(buf.length + value.length); next.set(buf); next.set(value, buf.length); buf = next; }
        for (;;) {                                                  // drain every whole frame the buffer now holds
          if (buf.length < 8) break;
          const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          const total = 8 + dv.getUint32(0) + dv.getUint32(4);
          if (buf.length < total) break;
          const frame = buf.subarray(0, total); buf = buf.subarray(total);
          if (cbs.msg) { let m; try { m = decodeMessage(frame); } catch { continue; } cbs.msg(m.obj, m.bin); }
        }
      }
    } catch { /* stream aborted — fall through to close */ }
    cbs.close?.();
  })();
  return {
    send(obj: object, bin?: Uint8Array): void { writer.write(encodeMessage(obj, bin)).catch(() => { /* closed */ }); },
    onMessage(cb: (obj: any, bin: Uint8Array | null) => void): void { cbs.msg = cb; },
    onClose(cb: () => void): void { cbs.close = cb; },
    close(): void { writer.close().catch(() => { /* already closed */ }); },
  };
}

// RPC correlation over a port: request() awaits a matching reply; inbound requests are
// dispatched to type handlers. A handler returns { obj, bin? }. When the port closes,
// every in-flight request REJECTS — a dropped socket settles the awaiting session (its
// error unwinds, cleanup like the §5 heap release runs) instead of hanging it forever.
export function makePeer(port: Port): Peer {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { res: (value: { obj: any; bin: Uint8Array | null }) => void; rej: (err: Error) => void }>();   // id -> settle({ obj, bin }) | reject
  const handlers = new Map<string, (payload: any, bin: Uint8Array | null) => any>();          // type -> (payload, bin) => { obj, bin? } | Promise<...>
  port.onMessage((m: any, bin) => {
    if (!m || typeof m !== "object") return;                        // well-framed but non-object payload: ignore, don't throw
    if (m.kind === "reply") { const r = pending.get(m.id); if (r) { pending.delete(m.id); r.res({ obj: m.payload, bin }); } return; }
    const h = handlers.get(m.payload && m.payload.type);
    Promise.resolve(h ? h(m.payload, bin) : { obj: { type: "error", message: "no handler for " + (m.payload && m.payload.type) } })
      .then((res: any) => port.send({ kind: "reply", id: m.id, payload: res.obj }, res.bin))
      .catch((e: any) => port.send({ kind: "reply", id: m.id, payload: { type: "error", message: String((e && e.message) || e) } }));
  });
  port.onClose(() => {
    closed = true;
    const waiting = [...pending.values()];
    pending.clear();
    for (const p of waiting) p.rej(new Error("tierless: connection closed with the request in flight"));
  });
  return {
    request(payload: object, bin?: Uint8Array): Promise<{ obj: any; bin: Uint8Array | null }> {
      if (closed) return Promise.reject(new Error("tierless: connection closed"));
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        try { port.send({ kind: "request", id, payload }, bin); }
        catch (e) { pending.delete(id); rej(e as Error); }          // a send on a dying socket must reject, not strand the entry
      });
    },
    on(type: string, handler: (payload: any, bin: Uint8Array | null) => any): void { handlers.set(type, handler); },
    close(): void { port.close(); },
  };
}

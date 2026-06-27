// Browser-only transport for the live React-tiers demo.
//
// These four functions — encodeMessage / decodeMessage / wsPort / makePeer — are the
// same as src/transport.mjs (the Node side). This browser copy is served to the tab so the
// page's module graph stays small and browser-safe (no Node-only imports).
//
// Protocol — one discrete message per ws frame, length-prefixed JSON + optional
// binary: [u32 jsonLen][u32 binLen][json][bin].
//   request  { kind:"request", id, payload }
//   reply    { kind:"reply",   id, payload }
//   resume   { type:"resume", wire } -> { type:"done", value } | { type:"suspend", wire } | { type:"error" }

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

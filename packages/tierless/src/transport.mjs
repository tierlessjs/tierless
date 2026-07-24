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
const te = new TextEncoder();
const td = new TextDecoder();
const EMPTY = new Uint8Array(0);
// One protocol message -> one binary ws frame: [u32 jsonLen][u32 binLen][json][bin].
export function encodeMessage(obj, bin = EMPTY) {
    const json = te.encode(JSON.stringify(obj));
    const b = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
    const out = new Uint8Array(8 + json.length + b.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, json.length);
    dv.setUint32(4, b.length); // big-endian, like frame.mjs
    out.set(json, 8);
    if (b.length)
        out.set(b, 8 + json.length);
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
// Normalize the two WebSocket event APIs (Node `ws`'s .on vs the browser's addEventListener) —
// shared by wsPort below and by callers (e.g. browser.mjs's connect()) that need an event the
// port interface doesn't expose, like "open"/"error" on the raw socket. `ws` is deliberately
// untyped: it is either a browser WebSocket or a Node `ws` socket, and nothing here needs more
// than the two methods duck-typed below.
export function onEvent(ws, event, fn) {
    return typeof ws.on === "function" ? ws.on(event, fn) : ws.addEventListener(event, fn);
}
// Adapt a WebSocket-like object (a browser WebSocket or a `ws` socket) to a small duplex
// port, normalizing the two event APIs and binary payload types.
export function wsPort(ws) {
    ws.binaryType = "arraybuffer";
    const on = (event, fn) => onEvent(ws, event, fn);
    return {
        send(obj, bin) { ws.send(encodeMessage(obj, bin)); },
        onMessage(cb) {
            on("message", (ev) => {
                const data = ev && ev.data !== undefined ? ev.data : ev;
                const g = globalThis;
                const trace = !!g.__TIERLESS_EXEC_LOG__ && typeof performance !== "undefined";
                const t0 = trace ? performance.now() : 0;
                let msg;
                try {
                    msg = decodeMessage(data);
                } // a truncated/garbage frame throws in the decoder…
                catch {
                    try {
                        ws.close(1003, "malformed frame");
                    }
                    catch { /* already gone */ }
                    return;
                } // …drop the peer, never the host
                const t1 = trace ? performance.now() : 0;
                cb(msg.obj, msg.bin);
                if (trace) {
                    const t2 = performance.now();
                    const log = (g.__tierlessWirePhases ||= []);
                    log.push({ t: t0, gap: g.__tierlessLastFrameEnd !== undefined ? t0 - g.__tierlessLastFrameEnd : 0, dec: t1 - t0, dlv: t2 - t1, bytes: data.byteLength ?? data.length ?? 0, k: msg.obj?.kind, ty: msg.obj?.payload?.type });
                    if (log.length > 1000)
                        log.splice(0, 500);
                    g.__tierlessLastFrameEnd = t2;
                }
            });
        },
        onClose(cb) { on("close", () => cb()); },
        close() { ws.close(); },
    };
}
export function wtPort(stream) {
    const writer = stream.writable.getWriter();
    // held on an object so the async read loop below sees reassignments (a plain `let` gets
    // narrowed to its initial null inside the closure and reads as `never`).
    const cbs = { msg: null, close: null };
    (async () => {
        const reader = stream.readable.getReader();
        let buf = new Uint8Array(0);
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                if (value && value.length) {
                    const next = new Uint8Array(buf.length + value.length);
                    next.set(buf);
                    next.set(value, buf.length);
                    buf = next;
                }
                for (;;) { // drain every whole frame the buffer now holds
                    if (buf.length < 8)
                        break;
                    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
                    const total = 8 + dv.getUint32(0) + dv.getUint32(4);
                    if (buf.length < total)
                        break;
                    const frame = buf.subarray(0, total);
                    buf = buf.subarray(total);
                    if (cbs.msg) {
                        let m;
                        try {
                            m = decodeMessage(frame);
                        }
                        catch {
                            continue;
                        }
                        cbs.msg(m.obj, m.bin);
                    }
                }
            }
        }
        catch { /* stream aborted — fall through to close */ }
        cbs.close?.();
    })();
    return {
        send(obj, bin) { writer.write(encodeMessage(obj, bin)).catch(() => { }); },
        onMessage(cb) { cbs.msg = cb; },
        onClose(cb) { cbs.close = cb; },
        close() { writer.close().catch(() => { }); },
    };
}
// RPC correlation over a port: request() awaits a matching reply; inbound requests are
// dispatched to type handlers. A handler returns { obj, bin? }. When the port closes,
// every in-flight request REJECTS — a dropped socket settles the awaiting session (its
// error unwinds, cleanup like the §5 heap release runs) instead of hanging it forever.
export function makePeer(port) {
    let nextId = 1;
    let closed = false;
    const pending = new Map(); // id -> settle({ obj, bin }) | reject
    const handlers = new Map(); // type -> (payload, bin) => { obj, bin? } | Promise<...>
    port.onMessage((m, bin) => {
        if (!m || typeof m !== "object")
            return; // well-framed but non-object payload: ignore, don't throw
        if (m.kind === "reply") {
            const r = pending.get(m.id);
            if (r) {
                pending.delete(m.id);
                r.res({ obj: m.payload, bin });
            }
            return;
        }
        const h = handlers.get(m.payload && m.payload.type);
        Promise.resolve(h ? h(m.payload, bin) : { obj: { type: "error", message: "no handler for " + (m.payload && m.payload.type) } })
            .then((res) => port.send({ kind: "reply", id: m.id, payload: res.obj }, res.bin))
            .catch((e) => port.send({ kind: "reply", id: m.id, payload: { type: "error", message: String((e && e.message) || e) } }));
    });
    port.onClose(() => {
        closed = true;
        const waiting = [...pending.values()];
        pending.clear();
        for (const p of waiting)
            p.rej(new Error("tierless: connection closed with the request in flight"));
    });
    return {
        request(payload, bin) {
            if (closed)
                return Promise.reject(new Error("tierless: connection closed"));
            const id = nextId++;
            return new Promise((res, rej) => {
                pending.set(id, { res, rej });
                try {
                    port.send({ kind: "request", id, payload }, bin);
                }
                catch (e) {
                    pending.delete(id);
                    rej(e);
                } // a send on a dying socket must reject, not strand the entry
            });
        },
        on(type, handler) { handlers.set(type, handler); },
        close() { port.close(); },
    };
}

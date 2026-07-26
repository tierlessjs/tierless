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
// One protocol message -> one binary ws frame: [u32 magic|version][u32 jsonLen][u32 binLen][json][bin].
// PROTOCOL VERSION, carried on every frame. There is exactly ONE wire protocol at a
// time: no capability negotiation, no compatibility branches, no client that gets a
// quietly different behavior. A peer built against a different version fails the frame
// check immediately and says so — the same posture the binary codec takes with its own
// magic (wire-binary.mts SMW2), for the same reason: a version-skewed peer that keeps
// talking corrupts data instead of stopping.
//
// BUMP THIS whenever the meaning of a frame changes (reply shape, field semantics,
// slot usage). Skew is a deployment error to surface loudly, not a case to support:
// rebuild the client bundle against the gateway it talks to.
//   v1  base { kind, id, payload } + optional binary slot
//   v2  exec replies may carry the response body in the binary slot (RawJsonBody)
export const PROTOCOL_VERSION = 2;
const MAGIC = 0x544c5700 | PROTOCOL_VERSION; // "TLW" + version byte
/** magic+version, jsonLen, binLen — every reader of the raw frame uses this. */
export const HEADER_BYTES = 12;
export function encodeMessage(obj, bin = EMPTY) {
    const json = te.encode(JSON.stringify(obj));
    const b = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
    const out = new Uint8Array(HEADER_BYTES + json.length + b.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, MAGIC); // version first: a skewed peer stops here
    dv.setUint32(4, json.length);
    dv.setUint32(8, b.length); // big-endian, like frame.mjs
    out.set(json, HEADER_BYTES);
    if (b.length)
        out.set(b, HEADER_BYTES + json.length);
    return out;
}
export function decodeMessage(data) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data); // ArrayBuffer (browser) or Buffer/Uint8Array (ws)
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const magic = dv.getUint32(0);
    if (magic !== MAGIC) {
        // named explicitly: "malformed frame" would send whoever hits this hunting a codec
        // bug, when the actual fault is a stale bundle talking to a newer gateway
        const peer = (magic & 0xffffff00) === 0x544c5700 ? String(magic & 0xff) : "pre-versioned or not tierless";
        throw new RangeError(`tierless: wire protocol mismatch — peer speaks v${peer}, this build speaks v${PROTOCOL_VERSION}; rebuild the client against this gateway`);
    }
    const jsonLen = dv.getUint32(4), binLen = dv.getUint32(8);
    const obj = JSON.parse(td.decode(u8.subarray(HEADER_BYTES, HEADER_BYTES + jsonLen)));
    const bin = binLen ? u8.subarray(HEADER_BYTES + jsonLen, HEADER_BYTES + jsonLen + binLen) : null;
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
/** A response body that is ALREADY valid JSON text. A gateway's restResources hands it
 *  over UNPARSED when the caller signalled it can take raw text (`ResourceRequest.raw`,
 *  set only by handleExec — the fetch arm, whose reply goes straight out); handleExec
 *  then ships the text in the frame's BINARY slot, so the reply's JSON header never
 *  re-serializes it either. That removes a full parse AND a full stringify of the body
 *  on the gateway — measured 83 ms + 122 ms on an 8.9 MB reply — for bytes the gateway
 *  never looks at. The receiving edge parses once, exactly as it already did when the
 *  body travelled inside the header.
 *
 *  Deliberately NOT used on the migrate arm or the hello preboot: there the envelope
 *  becomes continuation state or rides a JSON message, and a marker object would
 *  serialize as data instead of the body. The `raw` hint keeps those paths on the
 *  parsed path by simply not asking. Trade: malformed upstream JSON now surfaces at
 *  the receiving edge rather than in the gateway. */
export class RawJsonBody {
    text;
    constructor(text) {
        this.text = text;
    }
}
/** The original JSON text of a body that crossed in the binary slot, hung off the
 *  reassembled envelope under a symbol key: invisible to app code, ignored by
 *  JSON.stringify, and free — the receiving edge already holds it. It exists so a cache
 *  can persist the envelope WITHOUT re-serializing a body it was just handed as bytes,
 *  which is what let the envelope store become a cheap, synchronous write instead of a
 *  deferred one that lost races to page navigation (adapt-cache.mts). */
export const RAW_TEXT = Symbol("tierless.rawText");
/** Marks a ResourceRequest as a WIRE-LAYER request another layer will re-present: the
 *  exec log (pushExecLog) skips it, and the presenting layer logs the app-visible
 *  crossing itself. Exists because harness waits consume log entries EXACTLY ONCE
 *  (playwright.mts firstCrossing advances a cursor), so an entry that is wrong when
 *  pushed cannot be fixed up later — a revalidating 304 logged at the wire layer was
 *  judged by status-checking waits before the cache wrap could replace it with the 200
 *  the app actually received. The wrong entry must never be pushed at all. */
export const SKIP_EXEC_LOG = Symbol("tierless.skipExecLog");
/** THE exec-log entry writer — the one owner of the entry shape (browser.mts logs the
 *  plain session path through it; adapt-cache logs re-presented conditional crossings).
 *  The log is the harness-waits contract (tierless/playwright): entries must show what
 *  STOCK fetch would have shown the page, which is why a marked wire request is skipped
 *  rather than logged as-is. */
export function pushExecLog(req, status, body, hasBody, headers) {
    const g = globalThis;
    if (!g.__TIERLESS_EXEC_LOG__ || req[SKIP_EXEC_LOG])
        return;
    const log = (g.__tierlessExecLog ||= []);
    // reqBody too: harness waits shaped as `resp.request().postDataJSON()` need the
    // request side of the crossing — and both sides' headers, so a facade over an entry
    // answers header reads truthfully instead of not at all
    const reqHeaders = req.args?.[2]?.headers;
    log.push({ t: Date.now(), name: req.name, url: String(req.args?.[0] ?? ""), status, ...(headers ? { headers } : {}), ...(req.args?.[1] !== undefined ? { reqBody: req.args[1] } : {}), ...(reqHeaders ? { reqHeaders } : {}), ...(hasBody ? { body } : {}) });
    if (log.length > 500)
        log.splice(0, log.length - 500);
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
                } // a truncated/garbage frame — or a version-skewed peer — throws in the decoder…
                catch (e) { // …drop the peer, never the host. The reason is SURFACED, not swallowed:
                    const why = String(e?.message || "malformed frame"); // a protocol mismatch must name itself, or it reads as a codec bug
                    try {
                        console.error("[tierless] closing session: " + why);
                    }
                    catch { /* no console */ }
                    try {
                        ws.close(1003, why.slice(0, 120));
                    }
                    catch { /* already gone */ }
                    return;
                }
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
                    if (buf.length < HEADER_BYTES)
                        break; // magic+version, jsonLen, binLen
                    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
                    const total = HEADER_BYTES + dv.getUint32(4) + dv.getUint32(8);
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

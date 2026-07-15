// Tierless — WebSocket-over-HTTP/2 transport (RFC 8441 "Extended CONNECT"), server side.
// Node-only (node:http2); kept OUT of the browser-safe transport.mjs.
//
// Why this exists: a plain websocket is a SEPARATE connection the page never warmed, so its
// TCP + upgrade handshake (~2 RTT) lands fresh on the boot path. ws-over-H2 rides the page's
// EXISTING HTTP/2 connection as a new stream — no new handshake. The BROWSER negotiates this
// transparently (`new WebSocket()` over an H2 origin that advertised SETTINGS_ENABLE_CONNECT_
// PROTOCOL becomes an Extended CONNECT stream), so the client is UNCHANGED. Only the server
// must accept the CONNECT stream and speak RFC 6455 framing over it — which is what this file
// does: a self-contained RFC 6455 codec (no external ws dependency; `ws` locks its lib
// subpaths) adapting an http2 CONNECT stream to the same `Port` the plain-ws path yields.
//
// permessage-deflate is DECLINED on this path for now (the CONNECT response omits
// sec-websocket-extensions), so frames are uncompressed: this path wins the handshake, not yet
// the deflate byte win — wiring zlib into the codec (rsv1) is the follow-on to match plain ws.
import { encodeMessage, decodeMessage } from "./transport.mjs";
/** True for an inbound http2 stream that is a ws-over-H2 handshake (Extended CONNECT). The
 *  server advertises `enableConnectProtocol`; a conforming client (every modern browser)
 *  opens `:method CONNECT, :protocol websocket`. Everything else is an ordinary H2 request. */
export function isWebSocketConnect(headers) {
    return headers[":method"] === "CONNECT" && headers[":protocol"] === "websocket";
}
// ---- RFC 6455 frame codec (binary messages; masking; fragmentation; ping/close) ----------
const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;
/** Encode one server->client message as a single unmasked binary frame (server frames are
 *  never masked, RFC 6455 §5.1). Length is 7-bit, 16-bit (126), or 64-bit (127). */
function encodeFrame(payload, opcode = OP_BIN) {
    const n = payload.length;
    const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
    const out = Buffer.allocUnsafe(head + n);
    out[0] = 0x80 | opcode; // FIN + opcode
    if (n < 126)
        out[1] = n;
    else if (n < 65536) {
        out[1] = 126;
        out.writeUInt16BE(n, 2);
    }
    else {
        out[1] = 127;
        out.writeUInt32BE(0, 2);
        out.writeUInt32BE(n, 6);
    } // messages never exceed 4 GiB here
    Buffer.from(payload.buffer, payload.byteOffset, n).copy(out, head);
    return out;
}
/** Streaming RFC 6455 parser: feed it socket chunks, get whole messages. Handles the 7/16/64
 *  length forms, client masking (required for client->server frames), continuation-frame
 *  fragmentation, and the control opcodes (ping -> pong, close). */
function makeParser(onMessage, onPing, onClose) {
    let buf = Buffer.alloc(0);
    let fragOp = -1;
    const frags = [];
    return (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
            if (buf.length < 2)
                return;
            const fin = (buf[0] & 0x80) !== 0;
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) {
                if (buf.length < 4)
                    return;
                len = buf.readUInt16BE(2);
                off = 4;
            }
            else if (len === 127) {
                if (buf.length < 10)
                    return;
                len = Number(buf.readBigUInt64BE(2));
                off = 10;
            }
            const maskOff = off;
            if (masked)
                off += 4;
            if (buf.length < off + len)
                return; // frame not fully arrived yet
            let payload = buf.subarray(off, off + len);
            if (masked) {
                const m = buf.subarray(maskOff, maskOff + 4);
                const u = Buffer.from(payload);
                for (let i = 0; i < u.length; i++)
                    u[i] ^= m[i & 3];
                payload = u;
            }
            buf = buf.subarray(off + len);
            if (opcode === OP_PING) {
                onPing(Uint8Array.from(payload));
                continue;
            }
            if (opcode === OP_PONG)
                continue;
            if (opcode === OP_CLOSE) {
                onClose();
                return;
            }
            if (opcode === OP_BIN || opcode === OP_TEXT) {
                fragOp = fin ? -1 : opcode;
                if (fin)
                    onMessage(Uint8Array.from(payload));
                else
                    frags.push(Uint8Array.from(payload));
            }
            else if (opcode === OP_CONT) {
                frags.push(Uint8Array.from(payload));
                if (fin) {
                    const whole = Buffer.concat(frags);
                    frags.length = 0;
                    fragOp = -1;
                    onMessage(Uint8Array.from(whole));
                }
            }
        }
    };
}
/** Adapt an accepted ws-over-H2 stream to a tierless Port. Call AFTER `stream.respond({
 *  ':status': 200 })` (Extended CONNECT has no 101). The tierless message codec rides INSIDE
 *  each binary ws frame, exactly as it does over a plain websocket — only the byte pipe under
 *  the frames is an H2 stream instead of a TCP socket. */
export function h2Port(stream) {
    let onMsg = null;
    const feed = makeParser((data) => { if (!onMsg)
        return; let m; try {
        m = decodeMessage(data);
    }
    catch {
        try {
            stream.close();
        }
        catch { /* gone */ }
        return;
    } onMsg(m.obj, m.bin); }, (p) => { try {
        stream.write(encodeFrame(p, OP_PONG));
    }
    catch { /* gone */ } }, () => { try {
        stream.close();
    }
    catch { /* gone */ } });
    stream.on("data", (c) => { try {
        feed(c);
    }
    catch {
        try {
            stream.close();
        }
        catch { /* gone */ }
    } });
    return {
        send(obj, bin) { try {
            stream.write(encodeFrame(encodeMessage(obj, bin)));
        }
        catch { /* gone */ } },
        onMessage(cb) { onMsg = cb; },
        onClose(cb) { stream.on("close", cb); },
        close() { try {
            stream.close();
        }
        catch { /* already gone */ } },
    };
}

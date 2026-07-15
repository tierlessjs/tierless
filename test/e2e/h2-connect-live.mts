// LIVE WebSocket-over-HTTP/2 (RFC 8441 Extended CONNECT) — a full tierless round trip over a
// ws that rides an H2 stream, no separate handshake. Proves the server side end to end:
//   - an http2 secure server advertising enableConnectProtocol accepts :protocol=websocket,
//   - attachTierlessH2 adapts the CONNECT stream to a Port (self-contained RFC 6455 codec),
//   - a client speaking RFC 6455 (masked) over the same stream drives makePeer + execOver and
//     gets the value back — the exact exchange the plain-ws path performs, one origin, one
//     connection, zero extra handshake.
// (The browser does the client half natively; here a Node client stands in so the proof needs
//  no browser and runs in the headless suite.)
//
// Run:  node test/e2e/h2-connect-live.mts
import http2 from "node:http2";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { attachTierlessH2 } from "tierless/server";
import { makePeer, encodeMessage, decodeMessage } from "tierless/transport";
import { execOver } from "tierless";
import { makeCheck } from "../lib/check.mts";

const { check, ok } = makeCheck();

// self-signed cert for the H2 TLS server (browsers need TLS for H2; here Node client too)
const dir = mkdtempSync(join(tmpdir(), "tl-h2-"));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 1 -subj /CN=localhost`, { stdio: "ignore" });

// ---- server: H2 with Extended CONNECT + the tierless host answering over ws-over-H2 --------
const server = http2.createSecureServer({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`), allowHTTP1: true, settings: { enableConnectProtocol: true } });
let sawConnect = false;
server.on("stream", () => { sawConnect = true; });   // observational; attachTierlessH2 also listens
attachTierlessH2(server, {
  bundle: { PROGRAMS: {}, __unwind: () => false } as never,
  session: () => ({ exec: async (req: any) => (req.name === "api.ping" ? { status: 200, body: "pong-over-h2" } : (() => { throw new Error("no " + req.name); })()) }),
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

// ---- client: Extended CONNECT, then RFC 6455 (masked) framing over the H2 stream ----------
const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
await new Promise<void>((r, j) => { client.on("connect", () => r()); client.on("error", j); });
// A CONNECT with :protocol is only issuable/acceptable once the server's SETTINGS advertised
// enableConnectProtocol (RFC 8441) — so a 200 response IS the proof it was advertised. (Node's
// client-side remoteSettings.enableConnectProtocol under-reports it, so we assert the outcome.)
const stream = client.request({ ":method": "CONNECT", ":protocol": "websocket", ":authority": `127.0.0.1:${port}`, ":path": "/__tierless" });
const status = await new Promise<number>((r) => stream.on("response", (h) => r(Number(h[":status"]))));
check("the Extended CONNECT was accepted (200) — enableConnectProtocol advertised, ws coalesced onto the H2 conn", status === 200, status);

// client-side RFC 6455 codec (client frames MUST be masked; server frames arrive unmasked)
const clientFrame = (payload: Uint8Array): Buffer => {
  const n = payload.length, head = n < 126 ? 2 : n < 65536 ? 4 : 10, out = Buffer.allocUnsafe(head + 4 + n);
  out[0] = 0x82;                                                   // FIN + binary
  if (n < 126) out[1] = 0x80 | n; else if (n < 65536) { out[1] = 0x80 | 126; out.writeUInt16BE(n, 2); } else { out[1] = 0x80 | 127; out.writeUInt32BE(0, 2); out.writeUInt32BE(n, 6); }
  const m = randomBytes(4); m.copy(out, head);
  for (let i = 0; i < n; i++) out[head + 4 + i] = payload[i] ^ m[i & 3];
  return out;
};
const port_: import("tierless/transport").Port = {
  send: (obj, bin) => { stream.write(clientFrame(encodeMessage(obj, bin))); },
  onMessage: (cb) => {
    let b: Buffer = Buffer.alloc(0);
    stream.on("data", (c: Buffer) => {
      b = Buffer.concat([b, c]);
      for (;;) {
        if (b.length < 2) return;
        let len = b[1] & 0x7f, off = 2;
        if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
        if (b.length < off + len) return;                          // server frames are unmasked
        const payload = b.subarray(off, off + len); b = b.subarray(off + len);
        const m = decodeMessage(payload); cb(m.obj, m.bin);
      }
    });
  },
  onClose: (cb) => { stream.on("close", cb); },
  close: () => stream.close(),
};
const peer = makePeer(port_);

const value = await execOver(peer, { op: "resource", tier: "server", name: "api.ping", args: [] } as never);
check("a tierless exec round-tripped over ws-over-H2 (Extended CONNECT stream)", (value as { body?: string })?.body === "pong-over-h2", value);
check("the server saw the Extended CONNECT stream (no separate ws handshake — one H2 conn)", sawConnect);

client.close(); server.close(); rmSync(dir, { recursive: true, force: true });
console.log(ok()
  ? "PASS — a websocket rode an HTTP/2 Extended CONNECT stream (RFC 8441) and carried a full tierless exec, server-side codec and all, with no separate ws handshake"
  : "FAIL");
process.exit(ok() ? 0 : 1);

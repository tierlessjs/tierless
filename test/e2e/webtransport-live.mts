// LIVE WebTransport adapter — a full tierless round trip over a WHATWG byte duplex, the shape
// a WebTransport bidirectional stream presents on both tiers. Proves wtPort end to end without
// an H3 server (stable Node has none): two TransformStreams form an in-memory bidi pipe (the
// exact { readable, writable } contract of WebTransport.createBidirectionalStream), a tierless
// host answers on one end, and execOver on the other gets the value back — length-framed over
// raw bytes, no ws upgrade, no RFC 6455. The real H3 server is the pluggable part; this is the
// framework-owned adapter that turns its streams into a tierless Port.
//
// Run:  node test/e2e/webtransport-live.mts
import { makePeer, wtPort } from "tierless/transport";
import { makeHost, execOver } from "tierless";
import { makeCheck } from "../lib/check.mts";

const { check, ok } = makeCheck();

// an in-memory bidirectional pipe == a mock WebTransport bidi stream on each side
const c2s = new TransformStream<Uint8Array, Uint8Array>();   // client -> server
const s2c = new TransformStream<Uint8Array, Uint8Array>();   // server -> client
const clientStream = { readable: s2c.readable, writable: c2s.writable };
const serverStream = { readable: c2s.readable, writable: s2c.writable };

// server tier: a host answering one resource over the WebTransport stream
const serverPeer = makePeer(wtPort(serverStream));
makeHost({
  bundle: { PROGRAMS: {}, __unwind: () => false } as never,
  tier: "server",
  exec: async (req: any) => (req.name === "api.ping" ? { status: 200, body: "pong-over-wt" } : (() => { throw new Error("no " + req.name); })()),
}).answer(serverPeer);

// client tier: drive an exec across the same stream
const clientPeer = makePeer(wtPort(clientStream));
const value = await execOver(clientPeer, { op: "resource", tier: "server", name: "api.ping", args: [] } as never);
check("a tierless exec round-tripped over a WebTransport bidi stream (length-framed, no ws upgrade)", (value as { body?: string })?.body === "pong-over-wt", value);

// a second exec proves the frame parser handles back-to-back messages on the byte stream
const again = await execOver(clientPeer, { op: "resource", tier: "server", name: "api.ping", args: [] } as never);
check("a second exec on the same stream also round-trips (frame boundaries hold)", (again as { body?: string })?.body === "pong-over-wt");

console.log(ok()
  ? "PASS — the WebTransport adapter length-frames tierless messages over a WHATWG byte duplex and carries full execs, no ws upgrade or RFC 6455 involved"
  : "FAIL");
process.exit(ok() ? 0 : 1);

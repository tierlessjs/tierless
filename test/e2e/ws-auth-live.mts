// LIVE websocket credential handshake — the browser cannot set headers on an upgrade, so
// the shim offers the token as a "bearer.<base64url>" subprotocol next to the plain one.
// This drives a REAL handshake both ways and checks the two security properties:
//   • the gateway reads the token via bearerFromUpgrade (no ?token= in any URL, so
//     reverse-proxy access logs never see a credential), and
//   • the server echoes ONLY the plain protocol — the bearer never reflects into the
//     response headers.
// A protocol-less client (a port's fixture socket) must keep connecting unchanged.
//
// Run:  node test/e2e/ws-auth-live.mts
import { createServer } from "node:http";
import { attachTierless, bearerFromUpgrade } from "tierless/server";
import { makeCheck } from "../lib/check.mts";

const { check, ok } = makeCheck();
const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const seen: (string | undefined)[] = [];
const server = createServer();
attachTierless(server, {
  bundle: { PROGRAMS: {}, __unwind: () => false } as never,
  session: async (req) => { seen.push(bearerFromUpgrade(req)); return { exec: async () => null }; },
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;

const open = (protocols?: string[]): Promise<WebSocket> => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:${port}/__tierless`, protocols);
  ws.onopen = () => resolve(ws);
  ws.onerror = () => reject(new Error("handshake failed"));
});

// the shim's shape: plain protocol + bearer, token with base64-significant chars
const token = "s3cret+tok/en==";
const authed = await open(["tierless", "bearer." + b64url(token)]);
check("the echoed protocol is the plain one, not the bearer", authed.protocol === "tierless");
const bare = await open();                     // a fixture socket with no protocols at all
check("a protocol-less client still connects", bare.readyState === WebSocket.OPEN);
await new Promise((r) => setTimeout(r, 50));   // session() is async on connection
check("the gateway read the token from the subprotocol", seen[0] === token);
check("no bearer offered reads as no token, not a crash", seen.length === 2 && seen[1] === undefined);

authed.close(); bare.close(); server.close();
console.log(ok()
  ? "PASS — the session token rides a bearer subprotocol — read by the gateway, absent from URLs, never echoed — and protocol-less clients connect unchanged"
  : "FAIL");
process.exit(ok() ? 0 : 1);

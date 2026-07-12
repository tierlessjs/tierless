// The Strapi session gateway — standalone (the admin is served by the Strapi server
// itself; there is no separate frontend server to ride). Deployment posture unchanged:
// a thin gateway colocated with the backend; browser↔gateway is the one real-latency
// hop, gateway↔backend is localhost. Authority travels with each request (their
// getFetchClient attached the Authorization bearer browser-side before the adapter);
// the gateway holds no credentials.
//
//   node ports/strapi/gateway.mts     (:8180, ws at /__tierless; TIERLESS_WIRE_TRUTH=1
//                                      also serves TCP-true byte counters at /__tierless/wire)
import { createServer } from "node:http";
import { attachTierless, makeWireStats } from "../../packages/tierless/src/server.mjs";
import { restResources } from "../../packages/tierless/src/adapt.mjs";

const PORT = Number(process.env.TIERLESS_GATEWAY_PORT || 8180);
const API = process.env.TIERLESS_API_URL || "http://127.0.0.1:8000";

const wire = process.env.TIERLESS_WIRE_TRUTH ? makeWireStats() : undefined;
const server = createServer((req, res) => {
  if (wire && req.url === "/__tierless/wire") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(wire.read())); return; }
  res.statusCode = 200; res.end("tierless gateway");   // the suite's readiness wait
});

// websockets don't do CORS: loopback binding alone doesn't stop a hostile page the
// developer happens to visit from connecting to localhost and reaching the backend
// through this unauthenticated exec bridge — only sockets opened by OUR page origins
// get a session (:8000 direct, :28000 the wire-truth counting proxy, :18000 the RTT relay)
const ALLOWED_ORIGINS = new Set((process.env.TIERLESS_ALLOWED_ORIGINS ||
  "http://localhost:8000,http://127.0.0.1:8000,http://localhost:28000,http://127.0.0.1:28000,http://localhost:18000,http://127.0.0.1:18000").split(","));

// exec-only: no compiled machines (the adapter path crosses per request — patch 0003);
// compiled surfaces resolve from a manifest when they land, same as vikunja's plugin
const EXEC_ONLY = { PROGRAMS: {}, __unwind: () => false };
attachTierless(server, {
  bundle: () => EXEC_ONLY as never,
  wire,
  session: (req) => {
    const origin = String(req.headers.origin || "");
    if (!ALLOWED_ORIGINS.has(origin)) throw new Error("tierless gateway: origin not allowed: " + JSON.stringify(origin));
    return { exec: restResources(API, { envelopeErrors: true }) };
  },
});

// loopback only: this is an unauthenticated exec gateway to the localhost backend —
// on all interfaces any reachable page could use it to bypass CORS
server.listen(PORT, "127.0.0.1", () => console.log(`tierless gateway 127.0.0.1:${PORT} -> ${API}${wire ? " (wire truth on)" : ""}`));

// The NocoDB session gateway — standalone, because the frontend is served by Nuxt's
// nitro output server (no vite preview to ride, unlike ports/vikunja). Deployment
// posture unchanged: a thin gateway colocated with the backend; browser↔gateway is the
// one real-latency hop, gateway↔backend is localhost. Authority travels with each
// request (their interceptor chain attached xc-auth browser-side before the adapter);
// the gateway holds no credentials.
//
//   node ports/nocodb/gateway.mts     (:8180, ws at /__tierless; TIERLESS_WIRE_TRUTH=1
//                                      also serves TCP-true byte counters at /__tierless/wire)
import { createServer } from "node:http";
import { attachTierless, makeWireStats } from "../../packages/tierless/src/server.mjs";
import { restResources } from "../../packages/tierless/src/adapt.mjs";

const PORT = Number(process.env.TIERLESS_GATEWAY_PORT || 8180);
const API = process.env.TIERLESS_API_URL || "http://127.0.0.1:8080";

const wire = process.env.TIERLESS_WIRE_TRUTH ? makeWireStats() : undefined;
const server = createServer((req, res) => {
  if (wire && req.url === "/__tierless/wire") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(wire.read())); return; }
  res.statusCode = 200; res.end("tierless gateway");   // the boot health wait
});

// websockets don't do CORS: loopback binding alone doesn't stop a hostile page the
// developer happens to visit from connecting to localhost and reaching the backend
// through this unauthenticated exec bridge — only sockets opened by OUR page origins
// (plain + shaped-relay ports) get a session
const ALLOWED_ORIGINS = new Set((process.env.TIERLESS_ALLOWED_ORIGINS ||
  "http://localhost:3000,http://127.0.0.1:3000,http://localhost:13000,http://127.0.0.1:13000").split(","));

// exec-only: no machines yet (the adapter path crosses per request — patch 0003);
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

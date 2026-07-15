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
import { cookieAuthority } from "../../packages/tierless/src/session-auth.mjs";

const PORT = Number(process.env.TIERLESS_GATEWAY_PORT || 8180);
const API = process.env.TIERLESS_API_URL || "http://127.0.0.1:8000";

// ws origin gate AND the CORS gate for reseal/claim (those endpoints trade
// credentials): only OUR page origins — :8000 direct, :28000 the wire-truth counting
// proxy, :18000 the RTT relay. websockets don't do CORS, so loopback binding alone
// doesn't stop a hostile page from reaching the backend through this exec bridge.
const ALLOWED_ORIGINS = (process.env.TIERLESS_ALLOWED_ORIGINS ||
  ["8000", "28000", "18000"].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(",")
).split(",");

// Sealed cookie authority (packages/tierless/src/session-auth.mts, port patch 0006):
// Strapi's auth flows set/clear the httpOnly refresh cookie, so those crossings ride
// with a sealed jar blob; the gateway decrypts per request, forwards Set-Cookie as an
// in-band rotation + claim ticket, and stores no credentials — a restart self-heals
// (pages reseal from the jar).
const authority = cookieAuthority({ backendUrl: API, allowedOrigins: ALLOWED_ORIGINS });
const wire = process.env.TIERLESS_WIRE_TRUTH ? makeWireStats() : undefined;
const server = createServer((req, res) => {
  if (wire && req.url === "/__tierless/wire") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(wire.read())); return; }
  if (authority.handleHttp(req, res)) return;
  res.statusCode = 200; res.end("tierless gateway");   // the suite's readiness wait
});

const ALLOWED = new Set(ALLOWED_ORIGINS);
// exec-only: no compiled machines (the adapter path crosses per request — patch 0003);
// compiled surfaces resolve from a manifest when they land, same as vikunja's plugin
const EXEC_ONLY = { PROGRAMS: {}, __unwind: () => false };
attachTierless(server, {
  bundle: () => EXEC_ONLY as never,
  wire,
  session: (req) => {
    const origin = String(req.headers.origin || "");
    if (!ALLOWED.has(origin)) throw new Error("tierless gateway: origin not allowed: " + JSON.stringify(origin));
    return { exec: authority.exec };
  },
});

// loopback only: this is an unauthenticated exec gateway to the localhost backend —
// on all interfaces any reachable page could use it to bypass CORS
server.listen(PORT, "127.0.0.1", () => console.log(`tierless gateway 127.0.0.1:${PORT} -> ${API}${wire ? " (wire truth on)" : ""}`));

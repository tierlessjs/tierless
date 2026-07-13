// The n8n session gateway — standalone (the app serves itself from :5680; the session
// ws and the sealed-authority endpoints ride :5780). Deployment posture: a thin gateway
// colocated with the backend; browser↔gateway is the one real-latency hop,
// gateway↔backend is localhost. n8n authenticates with an httpOnly cookie, so authority
// rides each crossing as a sealed blob (packages/tierless/src/session-auth.mts —
// ROADMAP "gateway-mediated cookie authority, sealed"); the gateway stores no
// credentials and a restart self-heals (pages reseal from the jar).
//
//   node ports/n8n/gateway.mts     (:5780, ws at /__tierless, reseal/claim under
//                                   /__tierless/*; TIERLESS_WIRE_TRUTH=1 also serves
//                                   TCP-true byte counters at /__tierless/wire)
import { createServer } from "node:http";
import { attachTierless, makeWireStats } from "../../packages/tierless/src/server.mjs";
import { cookieAuthority } from "../../packages/tierless/src/session-auth.mjs";

const PORT = Number(process.env.TIERLESS_GATEWAY_PORT || 5780);
const API = process.env.TIERLESS_API_URL || "http://127.0.0.1:5680";

// ws origin gate AND the CORS gate for reseal/claim (those endpoints trade
// credentials): only OUR page origins — plain and shaped-relay ports (suite.mts:
// RTT pages ride :15680, wire-truth pages :25680)
const ALLOWED_ORIGINS = (process.env.TIERLESS_ALLOWED_ORIGINS ||
  ["5680", "15680", "25680"].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(",")
).split(",");

const authority = cookieAuthority({ backendUrl: API, allowedOrigins: ALLOWED_ORIGINS });
const wire = process.env.TIERLESS_WIRE_TRUTH ? makeWireStats() : undefined;

const server = createServer((req, res) => {
  if (wire && req.url === "/__tierless/wire") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(wire.read())); return; }
  if (authority.handleHttp(req, res)) return;
  res.statusCode = 200; res.end("tierless gateway");   // the boot health wait
});

const ALLOWED = new Set(ALLOWED_ORIGINS);
// exec-only: no machines yet (the adapter path crosses per request — patch 0005);
// compiled surfaces resolve from a manifest when they land, same as vikunja's plugin
const EXEC_ONLY = { PROGRAMS: {}, __unwind: () => false };
attachTierless(server, {
  bundle: () => EXEC_ONLY as never,
  wire,
  session: (req) => {
    // websockets don't do CORS: only sockets opened by OUR page origins get a session
    const origin = String(req.headers.origin || "");
    if (!ALLOWED.has(origin)) throw new Error("tierless gateway: origin not allowed: " + JSON.stringify(origin));
    return { exec: authority.exec };
  },
});

// loopback only: an exec gateway to the localhost backend must not be reachable off-host
server.listen(PORT, "127.0.0.1", () => console.log(`tierless gateway 127.0.0.1:${PORT} -> ${API}${wire ? " (wire truth on)" : ""}`));

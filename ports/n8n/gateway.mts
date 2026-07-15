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
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { attachTierless, makeWireStats } from "../../packages/tierless/src/server.mjs";
import { cookieAuthority } from "../../packages/tierless/src/session-auth.mjs";
import type { Exec, ResourceRequest } from "../../packages/tierless/src/types.mjs";

const PORT = Number(process.env.TIERLESS_GATEWAY_PORT || 5780);
const API = process.env.TIERLESS_API_URL || "http://127.0.0.1:5680";

// BOOT LATENCY FIXES (docs/migrate-arm boot; ports/n8n/README "Network wait"), each an
// env toggle so a measured run isolates its contribution without an editor rebuild:
//   TIERLESS_HELLO_AUTH=0  suppress the upgrade-sealed blob -> the browser falls back to the
//                          HTTP reseal round trip (the pre-fix "port-as-is" arm).
//   TIERLESS_PREBOOT=1     pre-fetch the boot GETs at the upgrade and push them in the hello;
//                          the first crossings JOIN them (needs a manifest, below).
//   TIERLESS_PREBOOT_FILE  newline-delimited GET paths to pre-fetch (the frozen manifest).
//   TIERLESS_LOG_GETS=<f>  profiling: append each distinct 2xx api.get path to <f> — run one
//                          boot to capture the manifest, then freeze it as PREBOOT_FILE.
const HELLO_AUTH = process.env.TIERLESS_HELLO_AUTH !== "0";
const PREBOOT_FILE = process.env.TIERLESS_PREBOOT_FILE;
const PREBOOT_PATHS = PREBOOT_FILE && existsSync(PREBOOT_FILE)
  ? readFileSync(PREBOOT_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
  : [];
const PREBOOT_ON = process.env.TIERLESS_PREBOOT === "1" && PREBOOT_PATHS.length > 0;
const LOG_GETS = process.env.TIERLESS_LOG_GETS;

// ws origin gate AND the CORS gate for reseal/claim (those endpoints trade
// credentials): only OUR page origins — plain and shaped-relay ports (suite.mts:
// RTT pages ride :15680, wire-truth pages :25680)
const ALLOWED_ORIGINS = (process.env.TIERLESS_ALLOWED_ORIGINS ||
  ["5680", "15680", "25680"].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(",")
).split(",");

const authority = cookieAuthority({ backendUrl: API, allowedOrigins: ALLOWED_ORIGINS, prebootPaths: PREBOOT_PATHS });
const wire = process.env.TIERLESS_WIRE_TRUTH ? makeWireStats() : undefined;

// profiling: record each distinct 2xx GET path so a boot capture becomes the preboot
// manifest. Wraps the exec only when TIERLESS_LOG_GETS is set — zero cost otherwise.
const seenGets = new Set<string>();
const execFor = (): Exec => {
  if (!LOG_GETS) return authority.exec;
  return async (req) => {
    const v = await authority.exec(req);
    const r = req as ResourceRequest;
    const status = (v as { status?: number } | null)?.status ?? 0;
    if (r.name === "api.get" && status >= 200 && status < 400) {
      const p = String((r.args ?? [])[0] ?? "");
      if (p && !seenGets.has(p)) { seenGets.add(p); try { appendFileSync(LOG_GETS, p + "\n"); } catch { /* best effort */ } }
    }
    return v;
  };
};

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
  session: async (req) => {
    // websockets don't do CORS: only sockets opened by OUR page origins get a session
    const origin = String(req.headers.origin || "");
    if (!ALLOWED.has(origin)) throw new Error("tierless gateway: origin not allowed: " + JSON.stringify(origin));
    // fold the reseal into the upgrade (HELLO_AUTH) and pre-fetch the boot GETs (PREBOOT_ON),
    // both from THIS upgrade's cookie — delivered in the hello before any crossing.
    const cookie = String(req.headers.cookie || "");
    const hello = await authority.hello(cookie, { auth: HELLO_AUTH, preboot: PREBOOT_ON });
    return { exec: execFor(), hello };
  },
});

// loopback only: an exec gateway to the localhost backend must not be reachable off-host
server.listen(PORT, "127.0.0.1", () => console.log(`tierless gateway 127.0.0.1:${PORT} -> ${API}  auth=${HELLO_AUTH} preboot=${PREBOOT_ON ? PREBOOT_PATHS.length + " paths" : "off"}${LOG_GETS ? " (logging GETs)" : ""}${wire ? " (wire truth on)" : ""}`));

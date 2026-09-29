// One measured arm of the Keycloak admin-console suite (docs/corpus.md run protocol):
// boot the variant (the injected distribution plus the session gateway), run THEIR
// Playwright suite through the generated config wrapper, tear down.
//
//   node ports/keycloak/suite.mts --baseline   -> ports/work/keycloak-baseline/measure.jsonl
//   node ports/keycloak/suite.mts              -> ports/work/keycloak/measure.jsonl
//   TIERLESS_SPEC="test/clients/main.spec.ts" — spec filter
//
// Their config declares chromium AND firefox projects and no webServer (boot.mts owns
// the stack either way); measured arms run chromium only, as every other port does.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delayProxy, makeLink, type WireCounter } from "../latency-proxy.mts";
import { httpLogProxy } from "../http-log-proxy.mts";
import { writeSuiteConfig } from "../pw-wrapper.mts";
import { assertFreshBuild } from "../assert-fresh.mts";
import { wsIoTap } from "tierless/playwright";

const VARIANT = process.argv.includes("--baseline") ? "keycloak-baseline" : "keycloak";
const TRUTH = !!process.env.TIERLESS_WIRE_TRUTH;
const RTT = Number(process.env.TIERLESS_RTT_MS || 0);
const BUDGET = !!process.env.TIERLESS_WIRE_BUDGET;
if (TRUTH && RTT) { console.error("pick one: TIERLESS_WIRE_TRUTH (bytes) or TIERLESS_RTT_MS (time)"); process.exit(2); }
if (BUDGET && !TRUTH) { console.error("TIERLESS_WIRE_BUDGET composes with TIERLESS_WIRE_TRUTH=1 — set both"); process.exit(2); }
const WORK = fileURLToPath(new URL(`../work/${VARIANT}/`, import.meta.url));
const SRC = path.join(WORK, "src/js/apps/admin-ui/");
const OUT = path.join(WORK, `measure${TRUTH ? "-truth" : ""}${RTT ? `-rtt${RTT}` : ""}${process.env.TIERLESS_BPS ? `-bps${process.env.TIERLESS_BPS}` : ""}.jsonl`);

// RUN PROTOCOL (docs/corpus.md): TIERLESS_PROFILE_RUN=1 is a PROFILING run — the browser
// traces every compiled method run to trace.jsonl; TIERLESS_PROFILE=<profile.json> is a
// frozen COMPARISON run on that locked profile (built by ports/build-profile.mts). Keycloak
// serves its own console HTML, so the endpoints live here and the page learns them from
// localStorage keys the Playwright wrapper preloads (TIERLESS_LOCAL_STORAGE).
const PROFILE_RUN = !!process.env.TIERLESS_PROFILE_RUN;
const PROFILE = process.env.TIERLESS_PROFILE || "";
if (PROFILE_RUN && PROFILE) { console.error("pick one: TIERLESS_PROFILE_RUN (profiling) or TIERLESS_PROFILE (comparison)"); process.exit(2); }
const TRACE_OUT = path.join(WORK, "trace.jsonl");
if (PROFILE_RUN || PROFILE) {
  if (VARIANT !== "keycloak") { console.error("the profile protocol is for the ported arm"); process.exit(2); }
  if (PROFILE_RUN) rmSync(TRACE_OUT, { force: true });
  const profileJson = PROFILE ? readFileSync(PROFILE, "utf8") : "";
  createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "POST" && req.url === "/trace") {
      let body = "";
      req.on("data", (c) => { body += String(c); });
      req.on("end", () => { appendFileSync(TRACE_OUT, body.endsWith("\n") || !body ? body : body + "\n"); res.end(); });
    } else if (req.method === "GET" && req.url === "/profile" && profileJson) {
      res.setHeader("content-type", "application/json"); res.end(profileJson);
    } else { res.statusCode = 404; res.end(); }
  }).listen(14993, "127.0.0.1").unref();
  process.env.TIERLESS_LOCAL_STORAGE = JSON.stringify(PROFILE_RUN
    ? { tierlessTraceUrl: "http://127.0.0.1:14993/trace" }
    : { tierlessProfileUrl: "http://127.0.0.1:14993/profile" });
  console.log(PROFILE_RUN ? `profiling run: traces -> ${TRACE_OUT}` : `comparison run: locked profile ${PROFILE}`);
}

// per-test I/O wait (tierless/playwright installIoWait, test patch 0005 on both arms): the
// page's in-flight intervals, unioned per test by the measure reporter into ioWaitMs.
// The profile/trace server above is harness, not app.
process.env.TIERLESS_IO_FILE = path.join(WORK, "io.txt");
process.env.TIERLESS_IO_IGNORE = "http://127.0.0.1:14993/";
rmSync(process.env.TIERLESS_IO_FILE, { force: true });

let pageUrl = "http://localhost:8080";
const wireUrls: string[] = [];
// TIERLESS_WIRE_BUDGET: per-path HTTP attribution + the gateway's per-path session log.
// Without it a run yields only suite TOTALS, which cannot separate bundles a real session
// downloads once from the API traffic a transport actually carries (docs/corpus.md,
// ports/report-marginal.mts). Chained INSIDE the counting relay so the TCP total still
// covers everything the page sent.
if (BUDGET) {
  const httpLog = path.join(WORK, "wire-http.jsonl");
  const sessLog = path.join(WORK, "wire-session.jsonl");
  rmSync(httpLog, { force: true });
  rmSync(sessLog, { force: true });
  httpLogProxy(38080, 8080, httpLog).unref();
  process.env.TIERLESS_WIRE_LOG = sessLog;
  console.log("wire budget: per-path HTTP log behind the relay, session log via TIERLESS_WIRE_LOG");
}
if (TRUTH) {
  // browser-facing origin through a counting relay; the gateway counts its own ws bytes
  const app: WireCounter = { toServer: 0, toClient: 0 };
  delayProxy(28080, BUDGET ? 38080 : 8080, 0, app).unref();
  createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ apiOut: app.toServer, apiIn: app.toClient })); }).listen(14992, "127.0.0.1").unref();
  pageUrl = "http://localhost:28080";
  // the page derives ws as page-port+100 = 28180 (the autoSession convention): a plain ws
  // passthrough lands it on the real gateway, whose own counter stays the session-byte
  // source of truth.
  delayProxy(28180, 8180, 0).unref();
  wireUrls.push("http://127.0.0.1:14992", "http://localhost:8180/__tierless/wire");
  console.log("wire truth: app origin via counting relay :28080 -> :8080, counters :14992, ws bytes :8180/__tierless/wire");
}
// TIERLESS_BPS=<bits/s>: one modeled access link, shared by the page relay and the
// session relay (every connection of both arms queues on it, as on a user's line)
const BPS = Number(process.env.TIERLESS_BPS || 0);
if (BPS && !RTT) { console.error("TIERLESS_BPS shapes the RTT relays: set TIERLESS_RTT_MS too"); process.exit(2); }
if (RTT) {
  const link = BPS ? makeLink(BPS) : undefined;
  delayProxy(18080, 8080, RTT / 2, undefined, link).unref();
  delayProxy(18180, 8180, RTT / 2, undefined, link, wsIoTap).unref();   // the session socket: crossings timed here
  pageUrl = "http://localhost:18080";
  process.env.TIERLESS_WS_URL = "ws://localhost:18180/__tierless";
  console.log(`RTT injection: ${RTT} ms via 18080->8080, 18180->8180`);
}

rmSync(OUT, { force: true });
// A PORTED ARM MUST NOT RUN A STALE BUNDLE (ports/assert-fresh.mts). The console bundle
// embedded tierless at BUILD time, so a framework edit without a rebuild would measure the
// old framework silently. Baseline arms carry no tierless in the bundle, so it is
// ported-only. The jar is what Keycloak actually serves, so check the tree that was
// injected INTO it — setup.sh injects immediately after building.
if (VARIANT === "keycloak") assertFreshBuild(path.join(SRC, "target/classes/theme/keycloak.v2/admin/resources"), "bash ports/keycloak/setup.sh  (rebuilds the console and re-injects the jar)");
const { bootKeycloak } = await import("./boot.mts");
// pageUrl, not the backend: the server's issuer must match the origin the BROWSER used,
// or the ported arm's session crossings arrive with a token minted for the relay host and
// are rejected 401 (boot.mts, `frontend`).
const app = await bootKeycloak({ frontend: pageUrl });
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { app.close(); process.exit(1); });

const CONFIG = writeSuiteConfig({ suiteDir: SRC, outFile: path.join(WORK, "pw/tierless.config.ts") });
const suite = spawn("npx", ["playwright", "test", "--config", CONFIG, "--workers=1", "--project=chromium",
  ...(RTT >= 50 ? ["--timeout=180000"] : []),
  ...(process.env.TIERLESS_SPEC || "").split(/\s+/).filter(Boolean)], {
  cwd: SRC,
  stdio: "inherit",
  env: {
    ...process.env,
    // their playwright (1.60) pins chromium 1223; this box exports /opt/pw-browsers,
    // which holds 1194
    PLAYWRIGHT_BROWSERS_PATH: process.env.TIERLESS_PW_BROWSERS || path.join(process.env.HOME || "", "pw-browsers"),
    // the suite's own origin constant (test patch 0002, both arms). The node-side
    // AdminClient keeps its hardcoded :8080, so seeding never crosses the relay.
    TIERLESS_BASE_URL: pageUrl,
    TIERLESS_MEASURE_OUT: OUT,
    ...(process.env.TIERLESS_WS_URL ? { TIERLESS_WS_URL: process.env.TIERLESS_WS_URL } : {}),
    ...(wireUrls.length ? { TIERLESS_WIRE_URLS: wireUrls.join(",") } : {}),
  },
});
const code = await new Promise<number>((resolve) => {
  suite.on("error", (err) => { console.error("suite spawn failed:", err.message); resolve(1); });
  suite.on("exit", (c) => resolve(c ?? 1));
});
app.close();
console.log(`\nmeasured arm (${VARIANT}): ${path.relative(process.cwd(), OUT)}`);
process.exitCode = code;

// One measured arm of the n8n suite (docs/corpus.md run protocol): boot the variant,
// run THEIR Playwright e2e project with the measure reporter on, tear down. One
// command per arm, so no by-hand step can diverge:
//
//   node ports/n8n/suite.mts --baseline    -> ports/work/n8n-baseline/measure.jsonl
//   node ports/n8n/suite.mts               -> ports/work/n8n/measure.jsonl
//   TIERLESS_SPEC="tests/e2e/workflows ..." node ports/n8n/suite.mts   (subset iteration)
//
// n8n is a SINGLE origin (:5680 serves the editor statics AND /rest). The browser is
// pointed at a relay origin via N8N_EDITOR_URL while node-side seeding (their
// api-helper request contexts) keeps hitting N8N_BASE_URL directly — the vikunja
// split, same shape: only what the PAGE puts on the wire is shaped/counted.
//
// TIERLESS_RTT_MS=<n>: real injected round-trip latency (TCP delay relays; CDP can't
// shape websockets) on the browser-facing origins — app and session gateway.
// TIERLESS_WIRE_TRUTH=1: TCP-true byte accounting via a counting relay; counters are
// read per test by the reporter at :14990. NOTE: one origin means asset bytes (JS
// bundles, fonts) flow through the same relay — identical in both arms, but the
// suite-wide totals include them; the report states this provenance.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { delayProxy, type WireCounter } from "../latency-proxy.mts";

const VARIANT = process.argv.includes("--baseline") ? "n8n-baseline" : "n8n";
const TRUTH = !!process.env.TIERLESS_WIRE_TRUTH;
const RTT = Number(process.env.TIERLESS_RTT_MS || 0);
if (TRUTH && RTT) { console.error("pick one: TIERLESS_WIRE_TRUTH (bytes) or TIERLESS_RTT_MS (time) — a counting relay inflates request-heavy tests"); process.exit(2); }
const SRC = fileURLToPath(new URL(`../work/${VARIANT}/src/`, import.meta.url));
const OUT = fileURLToPath(new URL(`../work/${VARIANT}/measure${TRUTH ? "-truth" : ""}${RTT ? `-rtt${RTT}` : ""}.jsonl`, import.meta.url));

let editorUrl = "";                          // browser-facing origin; empty = direct
const wireUrls: string[] = [];
if (TRUTH) {
  const app: WireCounter = { toServer: 0, toClient: 0 };
  delayProxy(25680, 5680, 0, app).unref();
  delayProxy(25780, 5780, 0).unref();   // ws passthrough (page port+100 rule); the gateway counts its own TCP-true bytes
  // api* keys: report.mts sums wireApiIn/Out + wireWsIn/Out as the byte total (the
  // "app" origin serves both api and assets here — single origin — but the field name
  // is what the report keys on). Assets are identical in both arms and wash out.
  createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ apiOut: app.toServer, apiIn: app.toClient })); }).listen(14990, "127.0.0.1").unref();
  editorUrl = "http://127.0.0.1:25680";
  wireUrls.push("http://127.0.0.1:14990", "http://127.0.0.1:5780/__tierless/wire");
  console.log("wire truth: browser origin via counting relay :25680, counters :14990, ws bytes at :5780/__tierless/wire");
}
if (RTT) {
  delayProxy(15680, 5680, RTT / 2).unref();
  delayProxy(15780, 5780, RTT / 2).unref();   // the page derives ws/gateway as page-port+100, so the relayed origin lands here
  editorUrl = "http://127.0.0.1:15680";
  console.log(`RTT injection: ${RTT} ms via 15680->5680, 15780->5780`);
}

rmSync(OUT, { force: true });
const { bootN8n } = await import("./boot.mts");
const app = await bootN8n();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { app.close(); process.exit(1); });
// --workers=1: per-test wire attribution needs one test generating traffic at a time
// (their local default is cpu/2); applied identically to both arms.
// Heavier shaping needs headroom over their 60 s per-test timeout — both arms get it.
const suite = spawn("corepack", ["pnpm", "exec", "playwright", "test", "--project=e2e", "--workers=1", ...(RTT >= 50 ? ["--timeout=120000"] : []), ...(process.env.TIERLESS_SPEC || "").split(/\s+/).filter(Boolean)], {
  cwd: path.join(SRC, "packages/testing/playwright"),
  stdio: "inherit",
  env: {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    // "localhost", not 127.0.0.1: n8n's auth cookie is Secure by default, and
    // Playwright's NODE-side cookie jar honors the Secure flag over plain http for a
    // literal IP while special-casing the name localhost — with an IP here every
    // authenticated api-helper call 401s while browser flows (which treat both as
    // secure contexts) pass. Their own scripts say localhost for the same reason.
    N8N_BASE_URL: "http://localhost:5680",                       // node-side seeding: direct, uncounted
    ...(editorUrl ? { N8N_EDITOR_URL: editorUrl } : {}),          // the page's origin: shaped/counted
    RESET_E2E_DB: "true",
    PLAYWRIGHT_SKIP_WEBSERVER: "true",                            // boot.mts owns the process
    PLAYWRIGHT_BROWSERS_PATH: path.join(process.env.HOME || "", "pw-browsers"),
    TIERLESS_MEASURE_OUT: OUT,
    ...(wireUrls.length ? { TIERLESS_WIRE_URLS: wireUrls.join(",") } : {}),
  },
});
const code = await new Promise<number>((resolve) => {
  suite.on("error", (err) => { console.error("suite spawn failed:", err.message); resolve(1); });
  suite.on("exit", (c) => resolve(c ?? 1));
});
app.close();
console.log(`\nmeasured arm (${VARIANT}): ${path.relative(process.cwd(), OUT)}`);
process.exitCode = code;   // nonzero = some tests failed; every attempt is in the JSONL regardless — callers tolerating failures say `|| true`

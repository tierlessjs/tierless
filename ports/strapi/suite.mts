// One measured arm of the Strapi e2e suite (docs/corpus.md run protocol): boot the
// session gateway, run THEIR runner (tests/scripts/run-e2e-tests.js — it generates the
// sqlite test app, yalc-links the monorepo packages, boots `develop --no-watch-admin`
// per domain and runs Playwright with their workers=1 config), tear down. One command
// per arm, so no by-hand step can diverge:
//
//   node ports/strapi/suite.mts --baseline    -> ports/work/strapi-baseline/measure.jsonl
//   node ports/strapi/suite.mts               -> ports/work/strapi/measure.jsonl
//   TIERLESS_DOMAINS="admin settings" TIERLESS_SPEC="login.spec.ts" ...   (subset iteration)
//
// TIERLESS_WIRE_TRUTH=1: byte accounting. Strapi serves admin assets AND the API on ONE
// origin (unlike vikunja/nocodb, whose stock deployments split them), so the browser
// rides an HTTP-MESSAGE counting proxy (:28000 -> :8000) that classifies per response:
// a JSON content-type is API traffic, everything else (HTML/JS/CSS/media) is assets.
// Counted bytes are serialized request+response messages (start line + headers + body
// as transmitted) — message-true, not TCP-true; chunk framing (~a few bytes/response)
// is the only wire cost it misses, identically on both arms. Session ws bytes ARE
// TCP-true, counted inside the gateway (deflate included) at :8180/__tierless/wire.
// Node-side test seeding (DTS reset per test) talks to :8000 directly and is never
// counted. TIERLESS_RTT_MS: real RTT on both browser-facing hops via raw TCP relays.
import { spawn } from "node:child_process";
import { openSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delayProxy } from "../latency-proxy.mts";

const VARIANT = process.argv.includes("--baseline") ? "strapi-baseline" : "strapi";
const TRUTH = !!process.env.TIERLESS_WIRE_TRUTH;
const RTT = Number(process.env.TIERLESS_RTT_MS || 0);
const GZIP = !!process.env.STRAPI_TIERLESS_GZIP;   // env-gated stock compression (test patch) — the apples-to-apples arm
if (TRUTH && RTT) { console.error("pick one: TIERLESS_WIRE_TRUTH (bytes) or TIERLESS_RTT_MS (time) — a counting proxy inflates request-heavy tests"); process.exit(2); }
const WORK = fileURLToPath(new URL(`../work/${VARIANT}/`, import.meta.url));
const SRC = path.join(WORK, "src/");
const OUT = path.join(WORK, `measure${TRUTH ? "-truth" : ""}${RTT ? `-rtt${RTT}` : ""}${GZIP ? "-gzip" : ""}.jsonl`);
const API = 8000;        // their runner: test-app-0 gets 8000 + index; -c 1 pins index 0
const GATEWAY = 8180;

const serving = (url: string): Promise<boolean> => fetch(url).then(() => true, () => false);
async function waitFor(url: string, ms: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + url);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// HTTP-message counting proxy: forwards to the app port, counts request/response bytes
// (start line + raw headers + body as transmitted) into api* when the RESPONSE is JSON
// (their API always is; documents/scripts/styles/media never are), asset* otherwise.
function countingProxy(listen: number, target: number, c: { apiOut: number; apiIn: number; assetOut: number; assetIn: number }): http.Server {
  const rawLen = (raw: string[]): number => { let n = 0; for (let i = 0; i < raw.length; i += 2) n += raw[i].length + raw[i + 1].length + 4; return n; };
  const srv = http.createServer((req, res) => {
    let reqBytes = Buffer.byteLength(`${req.method} ${req.url} HTTP/1.1\r\n`) + rawLen(req.rawHeaders) + 2;
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => { chunks.push(d); reqBytes += d.length; });
    req.on("end", () => {
      const up = http.request({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers: req.headers }, (ur) => {
        const isApi = String(ur.headers["content-type"] || "").includes("json");
        let resBytes = Buffer.byteLength(`HTTP/1.1 ${ur.statusCode}\r\n`) + rawLen(ur.rawHeaders) + 2;
        res.writeHead(ur.statusCode || 502, ur.headers);
        ur.on("data", (d: Buffer) => { resBytes += d.length; res.write(d); });
        ur.on("end", () => {
          res.end();
          if (isApi) { c.apiOut += reqBytes; c.apiIn += resBytes; }
          else { c.assetOut += reqBytes; c.assetIn += resBytes; }
        });
        ur.on("error", () => res.destroy());
      });
      up.on("error", () => { res.statusCode = 502; res.end(); });
      for (const d of chunks) up.write(d);
      up.end();
    });
    req.on("error", () => { /* browser gave up mid-request; upstream never starts */ });
  });
  srv.listen(listen, "127.0.0.1");
  return srv;
}

const env: Record<string, string | undefined> = {
  ...process.env,
  STRAPI_E2E_EDITION: "ce",                    // their CE lane — no license in this recipe
  TIERLESS_MEASURE_OUT: OUT,
};

const wireUrls: string[] = [];
if (TRUTH) {
  const counters = { apiOut: 0, apiIn: 0, assetOut: 0, assetIn: 0 };
  countingProxy(28000, API, counters).unref();
  http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(counters)); }).listen(14991, "127.0.0.1").unref();
  env.TIERLESS_BASE_URL = "http://127.0.0.1:28000";
  wireUrls.push("http://127.0.0.1:14991", `http://127.0.0.1:${GATEWAY}/__tierless/wire`);
  console.log("wire truth: browser via counting proxy :28000, counters :14991, ws bytes at :8180/__tierless/wire");
}

if (RTT) {
  // real round-trip latency on every browser-facing hop (websocket included — CDP
  // throttling can't shape ws): the app origin (assets + API, one origin on this app)
  // and the session gateway. The gateway->backend hop stays undelayed localhost.
  delayProxy(18000, API, RTT / 2).unref();
  delayProxy(18180, GATEWAY, RTT / 2).unref();
  env.TIERLESS_BASE_URL = "http://127.0.0.1:18000";
  env.TIERLESS_WS_URL = "ws://127.0.0.1:18180/__tierless";
  console.log(`RTT injection: ${RTT} ms via 18000->8000, 18180->8180`);
}
if (wireUrls.length) env.TIERLESS_WIRE_URLS = wireUrls.join(",");

// refuse ports that are already up: a stale stack would otherwise serve the run and
// every measurement would silently test old code
for (const port of [API, GATEWAY]) {
  if (await serving(`http://127.0.0.1:${port}`)) { console.error(`:${port} is already serving — a stale stack owns the port; kill it before running`); process.exit(1); }
}

rmSync(OUT, { force: true });
// the session gateway (both variants — env symmetry; the baseline build never connects).
// A detached process GROUP so teardown takes any children with it.
const glog = openSync(path.join(WORK, "gateway.log"), "w");
const gateway = spawn(process.execPath, [fileURLToPath(new URL("./gateway.mts", import.meta.url))], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", glog, glog], detached: true });
const closeGateway = (): void => { try { process.kill(-gateway.pid!, "SIGTERM"); } catch { gateway.kill(); } };
process.on("exit", closeGateway);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { closeGateway(); process.exit(1); });
await waitFor(`http://127.0.0.1:${GATEWAY}`, 30_000);

// THEIR runner, one test app at a time (-c 1) and ONE DOMAIN PER INVOCATION: their
// runner's domain loop aborts on a domain whose playwright run exits nonzero (any
// failing test), which would silently drop every later domain from a measured arm —
// invoking it per domain makes each domain's outcome independent, exactly the rows a
// comparison needs. Each domain's playwright webServer boots `develop
// --no-watch-admin` (vite-builds the admin from the yalc-linked packages) and tears it
// down — their CI's own lifecycle. chromium only (their docs' local-iteration lane).
// Heavier shaping needs headroom over their 90 s per-test timeout; both arms equally.
const domains = (process.env.TIERLESS_DOMAINS || "").split(/\s+/).filter(Boolean).length
  ? (process.env.TIERLESS_DOMAINS || "").split(/\s+/).filter(Boolean)
  : readdirSync(path.join(SRC, "tests/e2e/tests")).sort();
const specs = (process.env.TIERLESS_SPEC || "").split(/\s+/).filter(Boolean);
if (RTT >= 50) env.PLAYWRIGHT_TIMEOUT = "180000";
let failures = 0;
for (let i = 0; i < domains.length; i++) {
  // -f on the FIRST domain only: yalc's push→app propagation is unreliable for
  // packages the app's installations registry missed (observed for @strapi/admin), so
  // the arm starts from a regenerated app linked to the store the run just published;
  // later domains reuse it (no builds happen mid-arm), their runner's own flow.
  const args = ["tests/scripts/run-e2e-tests.js", "-c", "1", ...(i === 0 ? ["-f"] : []),
    "--domains", domains[i], "--", ...specs, "--project=chromium"];
  console.log(`\n[suite] domain ${domains[i]} (${i + 1}/${domains.length})`);
  const suite = spawn(process.execPath, args, { cwd: SRC, stdio: "inherit", env: env as NodeJS.ProcessEnv });
  const code = await new Promise<number>((resolve) => {
    suite.on("error", (err) => { console.error("suite spawn failed:", err.message); resolve(1); });
    suite.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) failures++;
}
closeGateway();
console.log(`\nmeasured arm (${VARIANT}): ${path.relative(process.cwd(), OUT)}${failures ? ` (${failures} domain(s) had failing tests)` : ""}`);
process.exitCode = failures ? 1 : 0;   // nonzero = some tests failed; every attempt is in the JSONL regardless — callers tolerating failures say `|| true`

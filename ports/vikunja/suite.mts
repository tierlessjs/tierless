// One measured arm of the suite benchmark (docs/corpus.md, run protocol): ensure the
// dist has their CI's TESTING flag, boot the variant, run the FULL Playwright suite
// with the measure fixture on, tear down. One command per arm, so no by-hand step can
// diverge between them:
//
//   node ports/vikunja/suite.mts --baseline     -> ports/work/vikunja-baseline/measure.jsonl
//   node ports/vikunja/suite.mts                -> ports/work/vikunja/measure.jsonl
//   node ports/report.mts ports/work/vikunja-baseline/measure.jsonl ports/work/vikunja/measure.jsonl
//
// TIERLESS_RTT_MS=80 injects REAL round-trip latency via a TCP delay relay in front of
// both origins (ports/latency-proxy.mts) — websocket included, which CDP throttling
// can't do. The gateway->backend hop stays undelayed localhost, as deployed. Output
// goes to measure-rtt<N>.jsonl; per-test durationMs is then elapsed time under that
// RTT (bandwidth unshaped), not a model.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { bootVikunja, TESTING_TOKEN } from "./boot.mts";
import { delayProxy, type WireCounter } from "../latency-proxy.mts";

const VARIANT = process.argv.includes("--baseline") ? "vikunja-baseline" : "vikunja";
const TRUTH = !!process.env.TIERLESS_WIRE_TRUTH;
const RTT = Number(process.env.TIERLESS_RTT_MS || 0);
// Run protocol (docs/corpus.md): TIERLESS_PROFILE_RUN=1 makes this a PROFILING run
// (browser traces every method run to the gateway, appended to trace.jsonl); setting
// TIERLESS_PROFILE=<profile.json> makes it a frozen COMPARISON run (the locked profile
// drives §6 migrate). Both wire the page via an injected global, like window.TESTING.
const PROFILE_RUN = !!process.env.TIERLESS_PROFILE_RUN;
const PROFILE = process.env.TIERLESS_PROFILE || "";
if (PROFILE_RUN && PROFILE) { console.error("pick one: TIERLESS_PROFILE_RUN (profiling) or TIERLESS_PROFILE (comparison)"); process.exit(2); }
const TRACE_OUT = fileURLToPath(new URL(`../work/${VARIANT}/trace.jsonl`, import.meta.url));
const BPS = Number(process.env.TIERLESS_BPS || 0);   // model link bandwidth (bits/s) on the shaped relays; 0 = unshaped
const SRC = fileURLToPath(new URL(`../work/${VARIANT}/src/`, import.meta.url));
const OUT = fileURLToPath(new URL(`../work/${VARIANT}/measure${RTT ? `-rtt${RTT}` : ""}${BPS ? `-bps${BPS}` : ""}.jsonl`, import.meta.url));

// their CI injects window.TESTING=true into the BUILT index.html (test.yml, "Inject
// testing flag"); the app gates test-only behavior on it and a dozen specs fail on any
// build without it — stock included.
const idx = path.join(SRC, "frontend/dist/index.html");
let html = readFileSync(idx, "utf8");
if (!html.includes("window.TESTING")) html = html.replace("<head>", "<head><script>window.TESTING=true;</script>");
// run-mode flag: strip any previous run's, then inject this run's (idempotent per mode)
html = html.replace(/<script data-tierless-run>[^<]*<\/script>/, "");
if (PROFILE_RUN) html = html.replace("<head>", "<head><script data-tierless-run>window.__TIERLESS_TRACE__=\"/__tierless/trace\";</script>");
if (PROFILE) html = html.replace("<head>", "<head><script data-tierless-run>window.__TIERLESS_PROFILE__=\"/__tierless/profile\";</script>");
writeFileSync(idx, html);

rmSync(OUT, { force: true });
if (PROFILE_RUN) { rmSync(TRACE_OUT, { force: true }); process.env.TIERLESS_TRACE_OUT = TRACE_OUT; }   // the preview inherits these
const app = await bootVikunja();
if (TRUTH) {
  // TCP-true byte accounting: the BROWSER's API traffic goes through a counting relay
  // (per-test deltas read by the fixture at :14990); node-side seeding/login stays on
  // the direct :3456 and is never counted. Session ws bytes are counted INSIDE the
  // gateway (TCP-level, deflate included) at /__tierless/wire. Assets bypass both.
  const api: WireCounter = { toServer: 0, toClient: 0 };
  delayProxy(23456, 3456, 0, api).unref();
  createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(api)); }).listen(14990, "127.0.0.1").unref();
  console.log("wire truth: browser api via counting relay :23456, counters :14990, ws bytes at /__tierless/wire");
}
if (RTT) {
  delayProxy(14173, 4173, RTT / 2, undefined, BPS || undefined).unref();   // frontend origin (SPA + tierless ws)
  delayProxy(13456, 3456, RTT / 2, undefined, BPS || undefined).unref();   // API origin (XHR + CORS preflights)
  console.log(`RTT injection: ${RTT} ms via 127.0.0.1:14173 -> 4173, 127.0.0.1:13456 -> 3456${BPS ? ` at ${BPS / 1e6} Mbps` : ""}`);
}
// spawn, NOT execFileSync: the delay relays run in THIS process, and a synchronous
// child would block the event loop — the proxies would bind but never accept, and
// every shaped connection dies ECONNREFUSED.
const suite = spawn("corepack", ["pnpm", "exec", "playwright", "test", "--reporter=line", ...(RTT ? ["--timeout=90000"] : []), ...(process.env.TIERLESS_SPEC ? [process.env.TIERLESS_SPEC] : [])], {
  cwd: path.join(SRC, "frontend"),
  stdio: "inherit",
  env: {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: "1",
    // their playwright.config honors this; needed where the pinned @playwright/test
    // version doesn't match the locally installed browsers
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || existsSync("/opt/pw-browsers/chromium")
      ? { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/opt/pw-browsers/chromium" } : {}),
    TEST_SECRET: TESTING_TOKEN,
    VIKUNJA_SERVICE_TESTINGTOKEN: TESTING_TOKEN,
    TIERLESS_MEASURE_OUT: OUT,
    ...(RTT ? { BASE_URL: "http://127.0.0.1:14173", API_URL: "http://127.0.0.1:13456/api/v1" } : {}),
    ...(TRUTH ? { TIERLESS_BROWSER_API_URL: "http://127.0.0.1:23456/api/v1" } : {}),   // browser data path through the counter; seeding stays direct
  },
});
await new Promise<void>((resolve) => suite.on("exit", () => resolve()));   // nonzero = some tests failed; every attempt is in the JSONL regardless
app.close();
console.log(`\nmeasured arm (${VARIANT}): ${path.relative(process.cwd(), OUT)}`);

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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootVikunja, TESTING_TOKEN } from "./boot.mts";
import { delayProxy } from "../latency-proxy.mts";

const VARIANT = process.argv.includes("--baseline") ? "vikunja-baseline" : "vikunja";
const RTT = Number(process.env.TIERLESS_RTT_MS || 0);
const SRC = fileURLToPath(new URL(`../work/${VARIANT}/src/`, import.meta.url));
const OUT = fileURLToPath(new URL(`../work/${VARIANT}/measure${RTT ? `-rtt${RTT}` : ""}.jsonl`, import.meta.url));

// their CI injects window.TESTING=true into the BUILT index.html (test.yml, "Inject
// testing flag"); the app gates test-only behavior on it and a dozen specs fail on any
// build without it — stock included.
const idx = path.join(SRC, "frontend/dist/index.html");
const html = readFileSync(idx, "utf8");
if (!html.includes("window.TESTING")) writeFileSync(idx, html.replace("<head>", "<head><script>window.TESTING=true;</script>"));

rmSync(OUT, { force: true });
const app = await bootVikunja();
if (RTT) {
  delayProxy(14173, 4173, RTT / 2).unref();   // frontend origin (SPA + tierless ws)
  delayProxy(13456, 3456, RTT / 2).unref();   // API origin (XHR + CORS preflights)
  console.log(`RTT injection: ${RTT} ms via 127.0.0.1:14173 -> 4173, 127.0.0.1:13456 -> 3456`);
}
try {
  // the shaped run gets a raised per-test timeout (both arms equally): the stock arm's
  // request-heavy tests spend up to ~10 s of pure injected RTT
  execFileSync("corepack", ["pnpm", "exec", "playwright", "test", "--reporter=line", ...(RTT ? ["--timeout=90000"] : [])], {
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
    },
  });
} catch { /* nonzero exit = some tests failed; every attempt is in the JSONL regardless */ }
app.close();
console.log(`\nmeasured arm (${VARIANT}): ${path.relative(process.cwd(), OUT)}`);

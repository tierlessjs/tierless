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
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delayProxy, type WireCounter } from "../latency-proxy.mts";
import { httpLogProxy } from "../http-log-proxy.mts";
import { writeSuiteConfig } from "../pw-wrapper.mts";
import { assertFreshBuild } from "../assert-fresh.mts";

const VARIANT = process.argv.includes("--baseline") ? "keycloak-baseline" : "keycloak";
const TRUTH = !!process.env.TIERLESS_WIRE_TRUTH;
const RTT = Number(process.env.TIERLESS_RTT_MS || 0);
const BUDGET = !!process.env.TIERLESS_WIRE_BUDGET;
if (TRUTH && RTT) { console.error("pick one: TIERLESS_WIRE_TRUTH (bytes) or TIERLESS_RTT_MS (time)"); process.exit(2); }
if (BUDGET && !TRUTH) { console.error("TIERLESS_WIRE_BUDGET composes with TIERLESS_WIRE_TRUTH=1 — set both"); process.exit(2); }
const WORK = fileURLToPath(new URL(`../work/${VARIANT}/`, import.meta.url));
const SRC = path.join(WORK, "src/js/apps/admin-ui/");
const OUT = path.join(WORK, `measure${TRUTH ? "-truth" : ""}${RTT ? `-rtt${RTT}` : ""}.jsonl`);

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
if (RTT) {
  delayProxy(18080, 8080, RTT / 2).unref();
  delayProxy(18180, 8180, RTT / 2).unref();
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
const app = await bootKeycloak();
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

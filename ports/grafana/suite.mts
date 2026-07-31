// One measured arm of the Grafana suite (docs/corpus.md run protocol): boot the
// variant (their e2e start-server + the session gateway), run THEIR Playwright suite
// through the generated config wrapper (ports/pw-wrapper.mts — transport waits +
// measure reporter, tree pristine), tear down.
//
//   node ports/grafana/suite.mts --baseline    -> ports/work/grafana-baseline/measure.jsonl
//   node ports/grafana/suite.mts               -> ports/work/grafana/measure.jsonl
//   TIERLESS_PROJECTS="panels various" — their config's project subset (default below)
//   TIERLESS_SPEC="..." — spec filter within the projects
//
// GRAFANA_URL is always set, so their config never spawns its own webServer — boot.mts
// owns the stack. Datasource projects needing services we don't run (mysql, mssql,
// cloudwatch, ...) are excluded by the default project list; excluded identically in
// both arms.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delayProxy, type WireCounter } from "../latency-proxy.mts";
import { httpLogProxy } from "../http-log-proxy.mts";
import { createServer } from "node:http";
import { writeSuiteConfig } from "../pw-wrapper.mts";
import { assertFreshBuild } from "../assert-fresh.mts";

const VARIANT = process.argv.includes("--baseline") ? "grafana-baseline" : "grafana";
const TRUTH = !!process.env.TIERLESS_WIRE_TRUTH;
const RTT = Number(process.env.TIERLESS_RTT_MS || 0);
const BUDGET = !!process.env.TIERLESS_WIRE_BUDGET;
if (TRUTH && RTT) { console.error("pick one: TIERLESS_WIRE_TRUTH (bytes) or TIERLESS_RTT_MS (time)"); process.exit(2); }
const SRC = fileURLToPath(new URL(`../work/${VARIANT}/src/`, import.meta.url));
const OUT = fileURLToPath(new URL(`../work/${VARIANT}/measure${TRUTH ? "-truth" : ""}${RTT ? `-rtt${RTT}` : ""}.jsonl`, import.meta.url));

// THE FIXED WORKLOAD RULE (docs/corpus.md: chosen before measurement): every project
// in their config EXCEPT the external-datasource ones (mysql, mssql, cloudwatch,
// azuremonitor, cloudmonitoring, graphite, influxdb, opentsdb, jaeger, postgres,
// loki, cloud-plugins — services this box does not run; they'd fail identically in
// both arms). Setup projects (authenticate, cujs-setup/teardown) ride along as
// Playwright dependencies of the ones that need them.
const PROJECTS = (process.env.TIERLESS_PROJECTS ||
  "admin viewer extensions-test-app grafana-e2etest-datasource canvas unauthenticated various panels smoke dashboards alerting dashboard-new-layouts dashboard-cujs grafana-e2etest-panel"
).split(/\s+/).filter(Boolean);

let pageUrl = "http://localhost:3001";
const wireUrls: string[] = [];
// TIERLESS_WIRE_BUDGET: per-path HTTP attribution + the gateway's per-path session log.
// Without it a run yields only suite TOTALS, which cannot separate bundles a real
// session downloads once from the API traffic a transport actually carries — the
// distinction that turned n8n's -0.6% headline into a -66% many-small result
// (docs/corpus.md, ports/report-marginal.mts). Chained INSIDE the counting relay so
// the TCP total still covers everything the page sent.
if (BUDGET && !TRUTH) { console.error("TIERLESS_WIRE_BUDGET composes with TIERLESS_WIRE_TRUTH=1 — set both"); process.exit(2); }
if (BUDGET) {
  const httpLog = fileURLToPath(new URL(`../work/${VARIANT}/wire-http.jsonl`, import.meta.url));
  const sessLog = fileURLToPath(new URL(`../work/${VARIANT}/wire-session.jsonl`, import.meta.url));
  rmSync(httpLog, { force: true });
  rmSync(sessLog, { force: true });
  httpLogProxy(33001, 3001, httpLog).unref();
  process.env.TIERLESS_WIRE_LOG = sessLog;
  console.log("wire budget: per-path HTTP log behind the relay, session log via TIERLESS_WIRE_LOG");
}
if (TRUTH) {
  // browser-facing origin through a counting relay; the gateway counts its own ws bytes
  const app: WireCounter = { toServer: 0, toClient: 0 };
  delayProxy(23001, BUDGET ? 33001 : 3001, 0, app).unref();
  createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ apiOut: app.toServer, apiIn: app.toClient })); }).listen(14992, "127.0.0.1").unref();
  pageUrl = "http://127.0.0.1:23001";
  // the page now derives ws as page-port+100 = 23101 (the autoSession convention):
  // a plain ws passthrough lands it on the real gateway, whose own counter stays the
  // session-byte source of truth. Without this the ported arm has NO session at all
  // (found as 47/56 truth-arm failures while floors were clean).
  delayProxy(23101, 3101, 0).unref();
  wireUrls.push("http://127.0.0.1:14992", "http://127.0.0.1:3101/__tierless/wire");
  console.log("wire truth: app origin via counting relay :23001 -> :3001, counters :14992, ws bytes :3101/__tierless/wire");
}
if (RTT) {
  delayProxy(13001, 3001, RTT / 2).unref();
  delayProxy(13101, 3101, RTT / 2).unref();
  pageUrl = "http://127.0.0.1:13001";
  process.env.TIERLESS_WS_URL = "ws://127.0.0.1:13101/__tierless";
  console.log(`RTT injection: ${RTT} ms via 13001->3001, 13101->3101`);
}

rmSync(OUT, { force: true });
// A PORTED ARM MUST NOT RUN A STALE BUNDLE (ports/assert-fresh.mts). The app bundle
// embedded tierless at BUILD time, so a framework edit without a rebuild would measure
// the old framework silently — it has cost a voided ablation and two debugging sessions.
// Baseline arms carry no tierless in the app bundle, so the check is ported-only.
if (VARIANT === "grafana") assertFreshBuild(path.join(SRC, "public/build"), "corepack yarn build  (in " + SRC + ")");
const { bootGrafana } = await import("./boot.mts");
const app = await bootGrafana();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { app.close(); process.exit(1); });

const CONFIG = writeSuiteConfig({ suiteDir: SRC, outFile: fileURLToPath(new URL(`../work/${VARIANT}/pw/tierless.config.ts`, import.meta.url)) });
const suite = spawn("corepack", ["yarn", "playwright", "test", "--config", CONFIG, "--workers=1",
  "--project=authenticate", ...PROJECTS.map((p) => `--project=${p}`),
  ...(RTT >= 50 ? ["--timeout=120000"] : []),
  ...(process.env.TIERLESS_SPEC || "").split(/\s+/).filter(Boolean)], {
  cwd: SRC,
  stdio: "inherit",
  env: {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    // this box has LANG unset + LC_CTYPE=POSIX; Chromium maps that to the INVALID
    // Intl tag "en-US@posix" and grafana's bootstrap throws before rendering anything
    // (RangeError in NumberFormat -> "failed to load its application files"). Their CI
    // runs C.UTF-8. Both arms get the same normalization.
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
    GRAFANA_URL: pageUrl,                               // their config: no webServer when set
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
process.exitCode = code;

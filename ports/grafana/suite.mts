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
import { createServer } from "node:http";
import { writeSuiteConfig } from "../pw-wrapper.mts";

const VARIANT = process.argv.includes("--baseline") ? "grafana-baseline" : "grafana";
const TRUTH = !!process.env.TIERLESS_WIRE_TRUTH;
const RTT = Number(process.env.TIERLESS_RTT_MS || 0);
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
if (TRUTH) {
  // browser-facing origin through a counting relay; the gateway counts its own ws bytes
  const app: WireCounter = { toServer: 0, toClient: 0 };
  delayProxy(23001, 3001, 0, app).unref();
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

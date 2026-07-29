// One measured arm of the InvenTree suite (docs/corpus.md run protocol): boot the
// variant (their invoke dev.server + worker, plus the session gateway), run THEIR
// Playwright suite through the generated config wrapper (ports/pw-wrapper.mts —
// transport waits + measure reporter, tree pristine), tear down.
//
//   node ports/inventree/suite.mts --baseline   -> ports/work/inventree-baseline/measure.jsonl
//   node ports/inventree/suite.mts              -> ports/work/inventree/measure.jsonl
//   TIERLESS_SPEC="tests/pui_forms.spec.ts" — spec filter
//
// The wrapper drops their `webServer` array: boot.mts owns the stack, so the arms do not
// each pay for a vite dev server they never talk to. PLAYWRIGHT_BASE_URL points at
// Django's own origin, which is their firefox lane's mode — the built frontend, not the
// dev server.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delayProxy, type WireCounter } from "../latency-proxy.mts";
import { httpLogProxy } from "../http-log-proxy.mts";
import { writeSuiteConfig } from "../pw-wrapper.mts";

const VARIANT = process.argv.includes("--baseline") ? "inventree-baseline" : "inventree";
const TRUTH = !!process.env.TIERLESS_WIRE_TRUTH;
const RTT = Number(process.env.TIERLESS_RTT_MS || 0);
const BUDGET = !!process.env.TIERLESS_WIRE_BUDGET;
if (TRUTH && RTT) { console.error("pick one: TIERLESS_WIRE_TRUTH (bytes) or TIERLESS_RTT_MS (time)"); process.exit(2); }
if (BUDGET && !TRUTH) { console.error("TIERLESS_WIRE_BUDGET composes with TIERLESS_WIRE_TRUTH=1 — set both"); process.exit(2); }
const WORK = fileURLToPath(new URL(`../work/${VARIANT}/`, import.meta.url));
const SRC = path.join(WORK, "src/src/frontend/");
const OUT = path.join(WORK, `measure${TRUTH ? "-truth" : ""}${RTT ? `-rtt${RTT}` : ""}.jsonl`);

let pageUrl = "http://127.0.0.1:8000";
const wireUrls: string[] = [];
// TIERLESS_WIRE_BUDGET: per-path HTTP attribution + the gateway's per-path session log.
// Without it a run yields only suite TOTALS, which cannot separate bundles a real
// session downloads once from the API traffic a transport actually carries — the
// distinction that turned n8n's -0.6% headline into a -51% many-small result
// (docs/corpus.md, ports/report-marginal.mts). Chained INSIDE the counting relay so the
// TCP total still covers everything the page sent.
if (BUDGET) {
  const httpLog = path.join(WORK, "wire-http.jsonl");
  const sessLog = path.join(WORK, "wire-session.jsonl");
  rmSync(httpLog, { force: true });
  rmSync(sessLog, { force: true });
  httpLogProxy(38000, 8000, httpLog).unref();
  process.env.TIERLESS_WIRE_LOG = sessLog;
  console.log("wire budget: per-path HTTP log behind the relay, session log via TIERLESS_WIRE_LOG");
}
if (TRUTH) {
  // browser-facing origin through a counting relay; the gateway counts its own ws bytes
  const app: WireCounter = { toServer: 0, toClient: 0 };
  delayProxy(28000, BUDGET ? 38000 : 8000, 0, app).unref();
  createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ apiOut: app.toServer, apiIn: app.toClient })); }).listen(14992, "127.0.0.1").unref();
  pageUrl = "http://127.0.0.1:28000";
  // the page derives ws as page-port+100 = 28100 (the autoSession convention): a plain
  // ws passthrough lands it on the real gateway, whose own counter stays the session-byte
  // source of truth.
  delayProxy(28100, 8100, 0).unref();
  wireUrls.push("http://127.0.0.1:14992", "http://127.0.0.1:8100/__tierless/wire");
  console.log("wire truth: app origin via counting relay :28000 -> :8000, counters :14992, ws bytes :8100/__tierless/wire");
}
if (RTT) {
  delayProxy(18000, 8000, RTT / 2).unref();
  delayProxy(18100, 8100, RTT / 2).unref();
  pageUrl = "http://127.0.0.1:18000";
  process.env.TIERLESS_WS_URL = "ws://127.0.0.1:18100/__tierless";
  console.log(`RTT injection: ${RTT} ms via 18000->8000, 18100->8100`);
}

rmSync(OUT, { force: true });
const { bootInvenTree, invenTreeEnv } = await import("./boot.mts");
const app = await bootInvenTree();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { app.close(); process.exit(1); });

const CONFIG = writeSuiteConfig({ suiteDir: SRC, outFile: path.join(WORK, "pw/tierless.config.ts"), overrides: { webServer: null } });
const suite = spawn("npx", ["playwright", "test", "--config", CONFIG, "--workers=1", "--project=chromium",
  ...(RTT >= 50 ? ["--timeout=180000"] : []),
  ...(process.env.TIERLESS_SPEC || "").split(/\s+/).filter(Boolean)], {
  cwd: SRC,
  stdio: "inherit",
  env: {
    ...invenTreeEnv(),
    CI: "1",                                            // their config: forbidOnly + retries=1, as in their lane
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || "/root/pw-browsers",
    PLAYWRIGHT_BASE_URL: pageUrl,
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

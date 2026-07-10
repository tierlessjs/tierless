// One measured arm of the NocoDB suite (docs/corpus.md run protocol): boot the
// variant, run THEIR Playwright suite (sqlite lane, their workers=1 config) with the
// measure reporter on, tear down. One command per arm, so no by-hand step can diverge:
//
//   node ports/nocodb/suite.mts --baseline    -> ports/work/nocodb-baseline/measure.jsonl
//   node ports/nocodb/suite.mts               -> ports/work/nocodb/measure.jsonl
//   TIERLESS_SPEC="tests/db/general ..." node ports/nocodb/suite.mts   (subset iteration)
//
// TIERLESS_WIRE_TRUTH=1: TCP-true byte accounting. The BROWSER's API traffic goes
// through a counting relay (:28080 -> :8080; per-test deltas read by the reporter at
// :14991) — node-side test seeding hardcodes :8080 in their setup and is never counted.
// Session ws bytes are counted INSIDE the gateway (TCP-level, deflate included) at
// :8180/__tierless/wire. Assets (:3000) bypass both. RTT shaping arrives next.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { delayProxy, type WireCounter } from "../latency-proxy.mts";

const VARIANT = process.argv.includes("--baseline") ? "nocodb-baseline" : "nocodb";
const TRUTH = !!process.env.TIERLESS_WIRE_TRUTH;
const RTT = Number(process.env.TIERLESS_RTT_MS || 0);
const GZIP = !!process.env.NC_TIERLESS_GZIP;   // env-gated stock compression (patch 0005) — the apples-to-apples arm
if (TRUTH && RTT) { console.error("pick one: TIERLESS_WIRE_TRUTH (bytes) or TIERLESS_RTT_MS (time) — a counting relay inflates request-heavy tests"); process.exit(2); }
const SRC = fileURLToPath(new URL(`../work/${VARIANT}/src/`, import.meta.url));
const OUT = fileURLToPath(new URL(`../work/${VARIANT}/measure${TRUTH ? "-truth" : ""}${RTT ? `-rtt${RTT}` : ""}${GZIP ? "-gzip" : ""}.jsonl`, import.meta.url));

const wireUrls: string[] = [];
if (TRUTH) {
  const api: WireCounter = { toServer: 0, toClient: 0 };
  delayProxy(28080, 8080, 0, api).unref();
  createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ apiOut: api.toServer, apiIn: api.toClient })); }).listen(14991, "127.0.0.1").unref();
  process.env.TIERLESS_BROWSER_API_URL = "http://127.0.0.1:28080";   // boot passes it to the frontend serve
  wireUrls.push("http://127.0.0.1:14991", "http://127.0.0.1:8180/__tierless/wire");
  console.log("wire truth: browser api via counting relay :28080, counters :14991, ws bytes at :8180/__tierless/wire");
}

if (RTT) {
  // real round-trip latency on every browser-facing hop (websocket included — CDP
  // throttling can't shape ws): frontend origin, API origin, session gateway. The
  // gateway->backend hop stays undelayed localhost, as deployed.
  delayProxy(13000, 3000, RTT / 2).unref();
  delayProxy(18080, 8080, RTT / 2).unref();
  delayProxy(18180, 8180, RTT / 2).unref();
  process.env.TIERLESS_BROWSER_API_URL = "http://127.0.0.1:18080";
  process.env.TIERLESS_WS_URL = "ws://127.0.0.1:18180/__tierless";
  process.env.BASE_URL = "http://127.0.0.1:13000";
  console.log(`RTT injection: ${RTT} ms via 13000->3000, 18080->8080, 18180->8180`);
}

rmSync(OUT, { force: true });
const { bootNocodb } = await import("./boot.mts");   // after TIERLESS_BROWSER_API_URL is set
const app = await bootNocodb();
// a killed suite must still tear the stack down: the app processes are DETACHED groups
// (boot.mts), so without this a stray kill leaves rspack/nodemon watchers respawning
// servers that own the ports forever
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { app.close(); process.exit(1); });
// --workers=1 pins THEIR CI sqlite-lane concurrency (their config sets it only under
// CI=true, which flips retries/forbidOnly too — the explicit flag takes just the part
// that matters: one shared sqlite backend cannot serve 4 racing browser contexts)
const suite = spawn("corepack", ["pnpm", "exec", "playwright", "test", "--workers=1", ...(process.env.TIERLESS_SPEC || "").split(/\s+/).filter(Boolean)], {
  cwd: path.join(SRC, "tests/playwright"),
  stdio: "inherit",
  env: {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    E2E_DB_TYPE: "sqlite",
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

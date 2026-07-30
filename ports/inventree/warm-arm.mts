// THE WARM-CACHE ARM — the configuration the suite arms cannot produce, and the one the
// routing question turns on (docs/corpus.md "Reading a byte number").
//
// Every suite arm gives each test a FRESH Playwright context, so the browser's HTTP cache
// is cold every time. That systematically flatters the socket for any response a real
// browser would have cached: InvenTree's /api/icons/ is `public, max-age=86400` and
// byte-identical, and both arms re-fetch it once per test only because of the harness.
// A real user pays for it once a day.
//
// This measures the opposite regime: ONE context, one login, the same routes walked round
// after round. Round 1 is the cold cost both arms already pay. Rounds 2+ are the honest
// question — with a warm browser cache, does the session still win?
//
// It is NOT the suite. A suite cannot run this way: their tests each pick a per-user
// storageState and mutate records, so sharing one context would cross-contaminate them.
// This is a fixed navigation workload, identical in both arms, and it answers one question.
//
//   node ports/inventree/warm-arm.mts [--baseline] [--rounds 4]
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delayProxy, type WireCounter } from "../latency-proxy.mts";
import { httpLogProxy } from "../http-log-proxy.mts";
import { readJsonl } from "../read-jsonl.mts";

const { chromium } = createRequire(process.env.PLAYWRIGHT_REQUIRE || "/opt/node22/lib/node_modules/")("playwright");
const BASELINE = process.argv.includes("--baseline");
const VARIANT = BASELINE ? "inventree-baseline" : "inventree";
const ROUNDS = Number(process.argv[process.argv.indexOf("--rounds") + 1]) || 4;
const WORK = fileURLToPath(new URL(`../work/${VARIANT}/`, import.meta.url));
const OUT = fileURLToPath(new URL("./results/warm/", import.meta.url));
const httpLog = path.join(WORK, "warm-http.jsonl");

// the same instrumentation chain the truth arm uses, so the two are comparable:
// page origin -> counting relay :28000 -> per-path HTTP log :38000 -> Django :8000
rmSync(httpLog, { force: true });
httpLogProxy(38000, 8000, httpLog).unref();
const app: WireCounter = { toServer: 0, toClient: 0 };
delayProxy(28000, 38000, 0, app).unref();
delayProxy(28100, 8100, 0).unref();                          // the page derives ws as page-port + 100
createServer((_q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify(app)); }).listen(14992, "127.0.0.1").unref();
const PAGE = "http://127.0.0.1:28000";

// the gateway serves TCP-true ws counters at /__tierless/wire only when it is told to;
// set before the dynamic import so the spawned gateway inherits it
process.env.TIERLESS_WIRE_TRUTH = "1";
const { bootInvenTree } = await import("./boot.mts");
const stack = await bootInvenTree();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stack.close(); process.exit(1); });

// the fixed workload: the app's main list routes, the traffic a table app actually makes
const ROUTES = ["/web/home", "/web/part/category/index/parts", "/web/stock/location/index/stock-items", "/web/manufacturing/index/buildorders", "/web/purchasing/index/purchaseorders", "/web/sales/index/salesorders"];

const sessionBytes = async (): Promise<number> => {
  try { const r = await fetch("http://127.0.0.1:8100/__tierless/wire"); const j = await r.json() as { wsIn?: number; wsOut?: number }; return (j.wsIn ?? 0) + (j.wsOut ?? 0); }
  catch { return 0; }
};

const browser = await chromium.launch();
// ONE context for the whole run — this is the entire point. Its HTTP cache warms as the
// rounds go, exactly as a returning user's does.
const ctx = await browser.newContext();
const page = await ctx.newPage();

page.on("console", (m: { type(): string; text(): string }) => { if (m.type() === "error") console.log("  [page error]", m.text().slice(0, 160)); });
await page.goto(PAGE + "/web/login", { waitUntil: "domcontentloaded" });
await page.getByRole("textbox", { name: "login-username" }).fill("admin");
await page.getByRole("textbox", { name: "login-password" }).fill("inventree");
await page.waitForTimeout(200);                              // their own login helper does the same
await page.getByRole("button", { name: "Log in" }).click();
try {
  await page.getByRole("link", { name: "Dashboard" }).waitFor({ timeout: 60_000 });
} catch (err) {
  // a measurement tool that dies on "timeout" and nothing else costs a boot cycle to debug
  console.error("login did not complete. url=" + page.url() + "\n  body: " + (await page.locator("body").innerText()).slice(0, 400).replace(/\s+/g, " "));
  throw err;
}

const marks: Array<{ round: number; t: number; session: number }> = [];
for (let round = 1; round <= ROUNDS; round++) {
  marks.push({ round, t: Date.now(), session: await sessionBytes() });
  for (const route of ROUTES) {
    const before = await sessionBytes();
    await page.goto(PAGE + route, { waitUntil: "domcontentloaded" });
    // NOT networkidle on its own. A hard load lands on /web/logged-in, whose session check
    // is DEBOUNCED 300 ms — so networkidle (500 ms of quiet) fires before the app has
    // issued a single request. The first cut of this waited on it, read a page still
    // showing "Checking if you are already logged in", and navigated away: six routes, zero
    // rows, ~1 KB of traffic per round on BOTH arms, reported as though it were an answer.
    await page.waitForURL((u: URL | string) => !String(u).includes("/logged-in"), { timeout: 60_000 });
    await page.getByRole("button", { name: "navigation-menu" }).waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => { /* a busy app may never idle; the route is up */ });
    // PER-ROUTE ACCOUNTING, because a route that silently renders nothing still produces a
    // number: the first cut of this walked six routes that never loaded their tables and
    // reported 10 KB of session traffic per round as if that were the answer.
    const cells = await page.locator("table tbody tr, .mantine-Table-tr").count().catch(() => 0);
    if (process.env.WARM_DEBUG) console.log("    url=" + page.url() + "\n    body: " + (await page.locator("body").innerText()).slice(0, 200).replace(/\s+/g, " "));
    console.log(`  ${route.padEnd(46)} rows≈${String(cells).padStart(4)}  session +${(((await sessionBytes()) - before) / 1e3).toFixed(1)} KB`);
  }
  console.log(`round ${round} done`);
}
marks.push({ round: ROUNDS + 1, t: Date.now(), session: await sessionBytes() });
await browser.close();
stack.close();

// attribute HTTP bytes to rounds by timestamp, and session bytes by counter delta
const rows = await readJsonl(httpLog) as Array<{ ts: number; path: string; respBytes?: number; reqBytes?: number; status?: number }>;
const perRound = marks.slice(0, -1).map((m, i) => {
  const end = marks[i + 1];
  const inRound = rows.filter((r) => r.ts >= m.t && r.ts < end.t);
  return {
    round: m.round,
    httpBytes: inRound.reduce((a, r) => a + (r.respBytes ?? 0) + (r.reqBytes ?? 0), 0),
    httpRequests: inRound.length,
    from304: inRound.filter((r) => r.status === 304).length,
    sessionBytes: end.session - m.session,
  };
});
mkdirSync(OUT, { recursive: true });
const outFile = path.join(OUT, (BASELINE ? "baseline" : "ported") + (process.env.TIERLESS_WARM_LABEL ? "-" + process.env.TIERLESS_WARM_LABEL : "") + ".json");
writeFileSync(outFile, JSON.stringify({ variant: VARIANT, rounds: ROUNDS, routes: ROUTES, perRound }, null, 2) + "\n");

console.log(`\n${VARIANT}${process.env.TIERLESS_WARM_LABEL ? " [" + process.env.TIERLESS_WARM_LABEL + "]" : ""} — one context, ${ROUNDS} rounds of ${ROUTES.length} routes` + (process.env.TIERLESS_BROWSE_OVER ? `, browse advisory over ${process.env.TIERLESS_BROWSE_OVER} B` : ""));
console.log("round   http bytes   requests   304s   session bytes   total");
for (const r of perRound) {
  console.log(`  ${String(r.round).padEnd(4)}${String((r.httpBytes / 1e6).toFixed(2) + " MB").padStart(11)}${String(r.httpRequests).padStart(11)}${String(r.from304).padStart(7)}${String((r.sessionBytes / 1e6).toFixed(2) + " MB").padStart(16)}${String(((r.httpBytes + r.sessionBytes) / 1e6).toFixed(2) + " MB").padStart(9)}`);
}
console.log(`\nwrote ${path.relative(process.cwd(), outFile)}`);
console.log("Round 1 is the cold cost both arms already pay; rounds 2+ are the warm-cache question.");

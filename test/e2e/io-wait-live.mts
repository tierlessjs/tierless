// LIVE proof of installIoWait (tierless/playwright): a real Chromium page's I/O wait is
// the UNION of its in-flight intervals — HTTP fetch/XHR by browser timing, session
// crossings by request/reply frames — and nothing else. Each scenario runs in its own
// time window, and the reporter's own unionMs reads the recorded intervals over it:
//
//   two sequential 150 ms fetches  -> ~300 ms      (waits add)
//   two parallel 200 ms fetches    -> ~200 ms      (overlap counts once)
//   300 ms of page CPU, no I/O     -> ~0 ms        (busy is not waiting)
//   one 200 ms session crossing    -> ~200 ms      (the socket, not only HTTP)
//   a 200 ms fetch to an ignored harness URL -> 0 ms
//   the socket's opening counts, from creation to its first frame
//
// Run:  node test/e2e/io-wait-live.mts        (needs Playwright Chromium)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { attachTierless, WS_PATH } from "tierless/server";
import { restResources } from "tierless/adapt";
import { installIoWait, unionMs } from "tierless/playwright";
import { makeCheck } from "../lib/check.mts";

const { chromium } = createRequire(process.env.PLAYWRIGHT_REQUIRE || "/opt/node22/lib/node_modules/")("playwright");
const { check, ok } = makeCheck();

const IO = path.join(mkdtempSync(path.join(tmpdir(), "tierless-io-")), "io.txt");
process.env.TIERLESS_IO_FILE = IO;

// /slow?ms=N answers after N ms — on the backend (crossings) and the page origin (fetch)
const slow = (req: IncomingMessage, res: ServerResponse): boolean => {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname !== "/slow") return false;
  setTimeout(() => { res.setHeader("content-type", "application/json"); res.end("{\"ok\":true}"); }, Number(u.searchParams.get("ms")));
  return true;
};
const backend = createServer((req, res) => { if (!slow(req, res)) { res.statusCode = 404; res.end(); } });
await new Promise<void>((r) => backend.listen(0, r));
const backendUrl = "http://127.0.0.1:" + (backend.address() as { port: number }).port;

const gwHttp = createServer((_req, res) => { res.end("gw"); });
attachTierless(gwHttp, {
  bundle: { PROGRAMS: {}, __unwind: () => false } as never,
  session: () => ({ exec: restResources(backendUrl, { envelopeErrors: true }) }),
});
await new Promise<void>((r) => gwHttp.listen(0, r));
const gwWs = `ws://127.0.0.1:${(gwHttp.address() as { port: number }).port}${WS_PATH}`;

const PKG = fileURLToPath(new URL("../../packages/tierless/src/", import.meta.url));
const html = `<!doctype html><html><body><script type="module">
  import { configureTierless, sessionExec } from "/pkg/browser.mjs";
  configureTierless({ url: "${gwWs}" });
  const exec = sessionExec();
  window.cross = (ms) => exec({ op: "resource", tier: "server", name: "api.get", args: ["/slow?ms=" + ms] }).then((e) => e && e.status);
  window.f = (url) => fetch(url).then((r) => r.json());
  window.busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms); };
</script></body></html>`;
const pages = createServer((req, res) => {
  if (slow(req, res)) return;
  const p = (req.url ?? "").split("?")[0];
  if (p.startsWith("/pkg/") && !p.includes("..")) {
    try { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(PKG + p.slice(5))); }
    catch { res.statusCode = 404; res.end(); }
  } else { res.setHeader("content-type", "text/html"); res.end(html); }
});
await new Promise<void>((r) => pages.listen(0, r));
const pageUrl = "http://127.0.0.1:" + (pages.address() as { port: number }).port;
// a harness endpoint on another origin (like the suite's profile server)
const harness = createServer((req, res) => { res.setHeader("access-control-allow-origin", "*"); if (!slow(req, res)) { res.statusCode = 404; res.end(); } });
await new Promise<void>((r) => harness.listen(0, r));
const harnessUrl = "http://127.0.0.1:" + (harness.address() as { port: number }).port;
process.env.TIERLESS_IO_IGNORE = harnessUrl + "/";

const intervals = (): Array<[number, number]> => readFileSync(IO, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ").map(Number) as [number, number]);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100));   // let Playwright's events land
const measure = async (script: string): Promise<number> => {
  await settle();
  const t0 = Date.now();
  await page.evaluate(script);
  const t1 = Date.now();
  await settle();
  return unionMs(intervals(), t0, t1);
};
const near = (got: number, want: number): boolean => got >= want - 5 && got <= want + 60;

const browser = await chromium.launch();
const context = await browser.newContext();
installIoWait(context);
const page = await context.newPage();
await page.goto(pageUrl + "/");

// the socket opens on the first crossing: its opening is waited on too
const t0 = Date.now();
await page.evaluate("window.cross(0)");
await settle();
const opening = unionMs(intervals(), t0, Date.now());
check("the session socket's opening and first crossing count as I/O", opening > 0, opening + " ms");

const seq = await measure("(async () => { await f('/slow?ms=150'); await f('/slow?ms=150'); })()");
check("two sequential 150 ms fetches read ~300 ms", near(seq, 300), seq + " ms");
// distinct URLs: Chromium's cache lock serializes identical concurrent GETs (really sequential)
const par = await measure("Promise.all([f('/slow?ms=200&n=1'), f('/slow?ms=200&n=2')])");
check("two parallel 200 ms fetches read ~200 ms (the union, not the sum)", near(par, 200), par + " ms");
const cpu = await measure("busy(300)");
check("300 ms of page CPU with no I/O reads ~0 ms", cpu <= 5, cpu + " ms");
const crossing = await measure("cross(200)");
check("a 200 ms session crossing reads ~200 ms", near(crossing, 200), crossing + " ms");
const ignored = await measure(`f('${harnessUrl}/slow?ms=200')`);
check("a fetch to a TIERLESS_IO_IGNORE prefix is not counted", ignored === 0, ignored + " ms");

await browser.close();
for (const s of [backend, gwHttp, pages, harness]) s.close();
console.log(`\n${ok() ? "PASS" : "FAIL"} — I/O wait: the union of a page's in-flight fetches and crossings, not its CPU`);
process.exit(ok() ? 0 : 1);

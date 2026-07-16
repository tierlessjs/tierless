// LIVE proof of tierless/playwright — the generic transport-agnostic wait, replacing
// the per-port waitFor* rewrite patches (docs/corpus.md "test accommodations"):
//
//   A real Chromium page routes its REST calls over a real tierless session socket to a
//   gateway (attachTierless + restResources against a mock backend) — no HTTP response
//   ever fires in the browser for them. installTransportWaits() patches the page IN
//   PLACE, and UNMODIFIED upstream-style waits — predicate, glob, and RegExp forms of
//   page.waitForResponse / page.waitForRequest, then .json() / .ok() /
//   .request().postDataJSON() on the result — all resolve from the crossings.
//
//   Honesty checks: a 404 crossing does NOT satisfy an ok() predicate (waits are never
//   weakened); a predicate reading beyond what a crossing carries (frame()) never
//   false-matches — it warns once and the wait times out with Playwright's own
//   TimeoutError; real HTTP passes through untouched (the stock arm reduces to the
//   original wait exactly); a wait armed before a navigation still catches the next
//   document's crossings.
//
// Run:  node test/e2e/pw-waits-live.mts        (needs Playwright Chromium)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { attachTierless, WS_PATH } from "tierless/server";
import { restResources } from "tierless/adapt";
import { installTransportWaits, globToRegexPattern, resolveSuitePlaywright, patchPlaywrightPages } from "tierless/playwright";
import { makeCheck } from "../lib/check.mts";

// playwright: loaded via createRequire (no @types/playwright wired into this tsconfig) — chromium, browser, page are all any
const { chromium } = createRequire(process.env.PLAYWRIGHT_REQUIRE || "/opt/node22/lib/node_modules/")("playwright");
const { check, ok } = makeCheck();

// ---- mock backend: the gateway's localhost target ---------------------------------------
const ITEMS = [{ id: 1, title: "first" }, { id: 2, title: "second" }];
const backend = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  let body = "";
  req.on("data", (c: Buffer) => (body += c));
  req.on("end", () => {
    if (path === "/api/items" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.setHeader("x-total-count", String(ITEMS.length));
      res.end(JSON.stringify(ITEMS));
    } else if (path === "/api/items" && req.method === "POST") {
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ created: JSON.parse(body || "null") }));
    } else if (path === "/api/after-nav") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ nav: true }));
    } else {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
});
await new Promise<void>((r) => backend.listen(0, r));
const backendUrl = "http://127.0.0.1:" + (backend.address() as { port: number }).port;

// ---- gateway: the session socket the page's requests cross ------------------------------
const gwHttp = createServer((_req, res) => { res.statusCode = 200; res.end("gw"); });
attachTierless(gwHttp, {
  bundle: { PROGRAMS: {}, __unwind: () => false } as never,   // exec-only, like the port gateways
  session: () => ({ exec: restResources(backendUrl, { envelopeErrors: true }) }),
});
await new Promise<void>((r) => gwHttp.listen(0, r));
const gwWs = `ws://127.0.0.1:${(gwHttp.address() as { port: number }).port}${WS_PATH}`;

// ---- page server: an app whose I/O bottom is sessionExec(), served as native ESM ---------
// (the tierless browser runtime's module graph is Node-free, so the page imports the real
// packages/tierless/src/browser.mjs directly — same runtime the ports bundle)
const PKG = fileURLToPath(new URL("../../packages/tierless/src/", import.meta.url));
const pageHtml = (onload: string) => `<!doctype html><html><body><h1>pw-waits-live</h1>
<script type="module">
  import { configureTierless, sessionExec } from "/pkg/browser.mjs";
  configureTierless({ url: "${gwWs}" });
  const exec = sessionExec();
  window.cross = (method, path, body, headers) => exec({ op: "resource", tier: "server",
    name: "api." + method, args: [path, body, headers ? { headers } : undefined] })
    .then((env) => ({ settled: true, status: env && env.status }), (err) => ({ settled: false, err: String(err) }));
  ${onload}
</script></body></html>`;
const pages = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (path.startsWith("/pkg/") && !path.includes("..")) {
    try { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(PKG + path.slice(5))); }
    catch { res.statusCode = 404; res.end(); }
  } else if (path === "/") { res.setHeader("content-type", "text/html"); res.end(pageHtml("")); }
  else if (path === "/second") { res.setHeader("content-type", "text/html"); res.end(pageHtml("window.cross('get', '/api/after-nav');")); }
  else if (path === "/direct.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ direct: true })); }
  else if (path === "/stock") { res.setHeader("content-type", "text/html"); res.end("<!doctype html><html><body>stock</body></html>"); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise<void>((r) => pages.listen(0, r));
const pageUrl = "http://127.0.0.1:" + (pages.address() as { port: number }).port;

// ---- drive it ----------------------------------------------------------------------------
const browser = await chromium.launch();
const warnings: string[] = [];
const context = await browser.newContext();
await installTransportWaits(context, { warn: (m: string) => warnings.push(m) });   // context-level: covers every page it creates
const page = await context.newPage();
await page.goto(pageUrl + "/");

// wait until the session socket is up (first crossing settles), so later waits are pure
const first = await page.evaluate("window.cross('get', '/api/items?boot=1')");
check("the page's requests cross the session socket (no HTTP fired for them)", (first as { settled: boolean; status: number }).settled && (first as { status: number }).status === 200, JSON.stringify(first));

// 1. predicate form, verbatim upstream shape — url + method + ok, then .json()/headers
{
  const wait = page.waitForResponse((res: { url(): string; ok(): boolean; request(): { method(): string } }) =>
    res.url().includes("/api/items") && res.request().method() === "GET" && res.ok());
  await page.evaluate("window.cross('get', '/api/items?x=1')");
  const res = await wait;
  check("predicate wait resolved from a crossing", !!res.__tierlessCrossing);
  check("facade url is absolute on the page origin", res.url() === pageUrl + "/api/items?x=1", res.url());
  check("facade status/ok", res.status() === 200 && res.ok() === true);
  check("facade .json() returns the backend payload", JSON.stringify(await res.json()) === JSON.stringify(ITEMS));
  check("facade carries real response headers", res.headers()["x-total-count"] === "2", JSON.stringify(res.headers()));
}

// 2. glob form (Playwright's own string semantics) and RegExp form
{
  const wGlob = page.waitForResponse("**/api/items*");
  const wRe = page.waitForResponse(/\/api\/items\?x=2/);
  await page.evaluate("window.cross('get', '/api/items?x=2')");
  const [g, r] = await Promise.all([wGlob, wRe]);
  check("glob wait resolved from a crossing", !!g.__tierlessCrossing && g.url().endsWith("/api/items?x=2"));
  check("RegExp wait resolved from a crossing", !!r.__tierlessCrossing && r.status() === 200);
}

// 3. request-side wait: waitForRequest(...).postDataJSON() — the payload-capture shape
{
  const wait = page.waitForRequest((req: { url(): string; method(): string }) => req.url().includes("/api/items") && req.method() === "POST");
  await page.evaluate("window.cross('post', '/api/items', { title: 'new one' }, { 'x-from-test': 'yes' })");
  const req = await wait;
  check("request wait resolved from a crossing", !!req.__tierlessCrossing);
  check("request facade .postDataJSON() is the sent payload", (req.postDataJSON() as { title: string }).title === "new one");
  check("request facade carries the request headers", req.headers()["x-from-test"] === "yes", JSON.stringify(req.headers()));
  check("request facade .response() reaches the reply", (await (await req.response()).json()).created.title === "new one");
}

// 4. waits are never weakened: a 404 crossing must NOT satisfy an ok() predicate
{
  const wait = page.waitForResponse((res: { url(): string; ok(): boolean }) => res.url().includes("/api/") && res.ok());
  await page.evaluate("window.cross('get', '/api/nope')");   // -> 404 envelope
  const pending = await Promise.race([wait.then(() => "matched"), new Promise((r) => setTimeout(() => r("pending"), 400))]);
  check("a 404 crossing did not satisfy the ok() predicate", pending === "pending", String(pending));
  await page.evaluate("window.cross('get', '/api/items?x=3')");
  check("the later 200 crossing satisfied it", (await wait).status() === 200);
}

// 5. real HTTP passes through untouched (and wins for requests that stay on the wire)
{
  const wait = page.waitForResponse((res: { url(): string }) => res.url().includes("/direct.json"));
  await page.evaluate("fetch('/direct.json')");
  const res = await wait;
  check("a real HTTP response resolves as the REAL Playwright Response", !res.__tierlessCrossing && typeof res.finished === "function" && (await res.json()).direct === true);
}

// 6. a wait armed BEFORE a navigation catches the NEXT document's crossings
{
  const wait = page.waitForResponse((res: { url(): string }) => res.url().includes("/api/after-nav"));
  await page.goto(pageUrl + "/second");                      // its onload fires the crossing
  check("wait armed pre-navigation resolved from the new document's crossing", (await wait).status() === 200);
}

// 7. facades never fabricate: a predicate reading frame() warns once and cannot match a
//    crossing — the wait times out with Playwright's OWN TimeoutError (untouched clock)
{
  const wait = page.waitForResponse((res: { url(): string; frame(): unknown }) => res.url().includes("/api/items") && res.frame() !== null, { timeout: 700 });
  await page.evaluate("window.cross('get', '/api/items?x=4')");
  const outcome = await wait.then(() => "matched", (e: Error) => e.constructor.name + ":" + e.name);
  check("the frame() predicate was not satisfied by the crossing (TimeoutError, Playwright's own)", String(outcome).includes("TimeoutError"), String(outcome));
  check("the unsupported read warned once, naming the member", warnings.length === 1 && warnings[0].includes("frame()"), JSON.stringify(warnings));
}

// 8. the stock arm: a page that never crosses — every wait reduces to the original exactly
{
  const stock = await context.newPage();                     // same context-level install: both arms get the accommodation
  await stock.goto(pageUrl + "/stock");
  const wGlob = stock.waitForResponse("**/direct.json");
  const wPred = stock.waitForResponse((res: { url(): string; ok(): boolean }) => res.url().includes("/direct.json") && res.ok());
  await stock.evaluate("fetch('/direct.json')");
  const [g, p] = await Promise.all([wGlob, wPred]);
  check("stock arm: glob and predicate waits pass through to real Playwright Responses", !g.__tierlessCrossing && !p.__tierlessCrossing && (await g.json()).direct === true);
}

// 9. differential: our glob compiler IS Playwright's — token-for-token against the
//    installed playwright-core (current semantics: `?`/`[`/`]` literal, `**` = `(.*)`)
{
  const outerRequire = createRequire(process.env.PLAYWRIGHT_REQUIRE || "/opt/node22/lib/node_modules/");
  const pwDir = outerRequire.resolve("playwright").replace(/\/index\.js$/, "");
  // absolute file path: playwright-core's exports map doesn't expose its internals
  const candidates = [pwDir + "/node_modules/playwright-core", pwDir.replace(/\/playwright$/, "/playwright-core")]
    .map((d) => d + "/lib/utils/isomorphic/urlMatch.js");
  const found = candidates.find((p) => { try { readFileSync(p); return true; } catch { return false; } });
  if (!found) throw new Error("playwright-core urlMatch.js not found under " + pwDir);
  const theirs = outerRequire(found).globToRegexPattern as (glob: string) => string;
  const GLOBS = ["**/rest/workflows", "**/rest/workflows/**", "**/api/v1/projects*", "a**b", "a*b",
    "**/x?y", "**/{one,two}/end", "**/[ab]", "**/z\\*z", "http://h:1/exact", "**/a.b+c(d)|e^f$g"];
  const diverged = GLOBS.filter((g) => globToRegexPattern(g) !== theirs(g));
  check("glob compiler matches installed playwright-core token-for-token (" + GLOBS.length + " patterns)", diverged.length === 0, JSON.stringify(diverged));
}

// 10. zero-touch delivery: patch the suite's Page CLASS (what a generated --config
//     wrapper does) — a page that never saw installTransportWaits gets everything:
//     lazy wiring on its first wait, pre-arm crossings excluded, contexts seeded
{
  // the playwright package dir — resolveSuitePlaywright digs playwright-core out of the
  // SAME install driving this test, so the patched class is the class of our pages
  const pwDir = createRequire(process.env.PLAYWRIGHT_REQUIRE || "/opt/node22/lib/node_modules/").resolve("playwright").replace(/\/index\.js$/, "");
  patchPlaywrightPages(resolveSuitePlaywright(pwDir), { warn: (m: string) => warnings.push(m), initScript: "localStorage.setItem('tierlessSeeded', 'yes')" });
  const ctx = await browser.newContext();                    // NO install call anywhere
  const page2 = await ctx.newPage();
  await page2.goto(pageUrl + "/");
  const before = await page2.evaluate("window.cross('get', '/api/items?pre=1')");   // settles BEFORE any wait exists
  check("zero-touch: a crossing can settle before the page is even wired", (before as { settled: boolean }).settled === true);
  const wait = page2.waitForResponse((res: { url(): string; ok(): boolean }) => res.url().includes("/api/items") && res.ok());
  const pending = await Promise.race([wait.then(() => "matched"), new Promise((r) => setTimeout(() => r("pending"), 400))]);
  check("zero-touch: the pre-arm crossing does NOT satisfy a later wait (drained history is filtered by arm time)", pending === "pending", String(pending));
  await page2.evaluate("window.cross('get', '/api/items?post=1')");
  const res = await wait;
  check("zero-touch: an untouched page's unmodified wait resolves from the post-arm crossing", !!res.__tierlessCrossing && res.url().endsWith("/api/items?post=1"), res.url());
  check("zero-touch: initScript seeded the context before its first page", (await page2.evaluate("localStorage.getItem('tierlessSeeded')")) === "yes");
  // route recording at the class level: page- and context-level route() patterns land
  // on the force-browser seam (adapt-auto's page global) with no recorder call anywhere
  await page2.route("**/api/proto-mocked*", (route: { fulfill(o: unknown): Promise<void> }) => route.fulfill({ status: 200, body: "{}" }));
  await ctx.route(/\/api\/ctx-mocked/, (route: { fulfill(o: unknown): Promise<void> }) => route.fulfill({ status: 200, body: "{}" }));
  const seam = await page2.evaluate("JSON.stringify(window.__tierlessForceBrowser || [])") as string;
  check("zero-touch: route() patterns auto-register on the force-browser seam", seam.includes("proto-mocked") && seam.includes("ctx-mocked"), seam);
  await ctx.close();
}

await browser.close();
gwHttp.close(); backend.close(); pages.close();
console.log(ok()
  ? "PASS — installTransportWaits made UNMODIFIED upstream waits transport-agnostic: predicate/glob/RegExp waitForResponse and waitForRequest all resolved from real session crossings with truthful facades, never weakened a predicate, never fabricated an answer, and reduced to the original waits exactly on the stock arm"
  : "FAIL");
process.exit(ok() ? 0 : 1);

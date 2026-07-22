// LIVE proof of the one-call port surface — autoSession (tierless/adapt-auto) +
// fetchAdapter (tierless/adapt-fetch) + the `tierless gateway` CLI, wired exactly as a
// corpus port would be:
//
//   A real Chromium page calls autoSession() and routes its REST through the session
//   socket to a CLI-spawned gateway (exec against a mock backend the browser cannot
//   reach directly — no CORS, so every 200 PROVES the socket carried it). Two arms:
//   a header-auth gateway (no flags) and a --cookie-authority gateway.
//
//   What this pins: the CLI gateway boots and prints its bound port; auth:"auto" costs
//   a header-auth app NOTHING (first crossing settles fast — the gateway's default
//   hello declares sealed:false, no reseal, no safety-net stall) and gives a
//   cookie-auth app the sealed blob from the ws upgrade (the crossing carries the
//   httpOnly cookie to the backend, which the page never read); the force-browser seam
//   keeps declared globs on the browser's own fetch — including patterns recorded
//   automatically from page.route() (recordForceBrowserRoutes), so upstream mocks fire;
//   fetchAdapter crosses JSON negotiation and falls through for the rest; the
//   localStorage override reroutes the socket without a rebuild; the gateway's ws
//   origin gate refuses a foreign page.
//
// Run:  node test/e2e/auto-session-live.mts        (needs Playwright Chromium)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { installTransportWaits, recordForceBrowserRoutes } from "tierless/playwright";
import { makeCheck } from "../lib/check.mts";

// playwright: loaded via createRequire (no @types/playwright wired into this tsconfig) — chromium, browser, page are all any
const { chromium } = createRequire(process.env.PLAYWRIGHT_REQUIRE || "/opt/node22/lib/node_modules/")("playwright");
const { WebSocket } = createRequire(import.meta.url)("ws");
const { check, ok } = makeCheck();
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ---- mock backend: reachable ONLY via the gateways (no CORS headers) ---------------------
const backendHits: Record<string, number> = {};
const backendCookies: Record<string, string> = {};
let heavyFull = 0, heavyRevalidated = 0;   // the conditional-crossings arm: full 200s vs 0-byte 304s
const backend = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  backendHits[path] = (backendHits[path] ?? 0) + 1;
  backendCookies[path] = String(req.headers.cookie ?? "");
  res.setHeader("content-type", "application/json");
  if (path === "/api/heavy") {
    // an ETag'd mega-GET, the n8n community-node-types shape: If-None-Match -> 0-byte 304
    res.setHeader("etag", 'W/"heavy-v1"');
    if (req.headers["if-none-match"] === 'W/"heavy-v1"') { heavyRevalidated++; res.statusCode = 304; res.end(); return; }
    heavyFull++;
    res.end(JSON.stringify({ nodes: Array.from({ length: 2000 }, (_, i) => ({ name: "node" + i, props: { i } })) }));
    return;
  }
  res.end(JSON.stringify({ path, hit: backendHits[path], sawCookie: backendCookies[path] }));
});
await new Promise<void>((r) => backend.listen(0, r));
const backendUrl = "http://127.0.0.1:" + (backend.address() as { port: number }).port;

// ---- page server: the app origin (sets the httpOnly cookie the cookie arm mediates) ------
const PKG = fileURLToPath(new URL("../../packages/tierless/src/", import.meta.url));
const pageHits: Record<string, number> = {};
const PAGE_HTML = `<!doctype html><html><body><h1>auto-session-live</h1>
<script type="module">
  import { autoSession } from "/pkg/adapt-auto.mjs";
  import { fetchAdapter } from "/pkg/adapt-fetch.mjs";
  const q = new URLSearchParams(location.search);
  if (q.get("setOverride") !== null) localStorage.setItem("tierlessWsUrl", q.get("setOverride"));
  const t0 = Date.now();
  const t = autoSession({ url: q.get("ws") || undefined, forceBrowser: ["**/api/forced*"] });
  window.tierlessWsUrl = t.wsUrl;
  const call = (m, p, b, h) => t.exec({ op: "resource", tier: "server", name: "api." + m, args: [p, b, h ? { headers: h } : undefined] });
  window.firstCrossing = call("get", "/api/boot").then(
    (env) => ({ ms: Date.now() - t0, status: env && env.status, body: env && env.body }),
    (e) => ({ err: String(e) }));
  window.cross = (m, p, b) => call(m, p, b).then((env) => env, (e) => ({ err: String(e) }));
  window.tfetch = async (p, init) => { const r = await fetchAdapter({ exec: t.exec })(p, init || {}); return { status: r.status, body: await r.text() }; };
  window.axiosCheck = async () => {
    // tierlessAxios mechanics with an axios-SHAPED module: install, a crossing through
    // the real socket, and a pinned config falling through to the module's own adapter
    const { tierlessAxios } = await import("/pkg/adapt-auto.mjs");
    let fell = 0;
    const fakeAxios = { getAdapter: () => async () => { fell++; return { status: 200, data: "host" }; } };
    const instance = { defaults: { baseURL: location.origin } };
    tierlessAxios(fakeAxios, instance, { url: q.get("ws") || undefined });
    tierlessAxios(fakeAxios, instance, { url: q.get("ws") || undefined });   // idempotent
    const crossed = await instance.defaults.adapter({ method: "get", url: "/api/axios-check", headers: {} });
    const pinned = await instance.defaults.adapter({ method: "get", url: "/api/axios-check", responseType: "blob" });
    return { status: crossed.status, path: crossed.data && crossed.data.path, fellForPinned: fell === 1 && pinned.data === "host" };
  };
</script></body></html>`;
const pages = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  pageHits[path] = (pageHits[path] ?? 0) + 1;
  if (path.startsWith("/pkg/") && !path.includes("..")) {
    try { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(PKG + path.slice(5))); }
    catch { res.statusCode = 404; res.end(); }
  } else if (path === "/") {
    res.setHeader("set-cookie", "sid=SECRET; Path=/; HttpOnly");    // the authority the cookie arm mediates
    res.setHeader("content-type", "text/html"); res.end(PAGE_HTML);
  } else if (path === "/api/forced") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ forced: true })); }
  else if (path === "/direct.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ direct: true })); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise<void>((r) => pages.listen(0, r));
const pageUrl = "http://127.0.0.1:" + (pages.address() as { port: number }).port;

// ---- gateways: spawned through the CLI, the way a port's boot would ----------------------
const children: ChildProcess[] = [];
async function spawnGateway(extra: string[]): Promise<string> {
  const child = spawn(process.execPath, [ROOT + "packages/tierless/bin/tierless.mjs", "gateway", "--backend", backendUrl, "--port", "0", "--allow-origin", pageUrl, ...extra], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (c: Buffer) => { buf += c; const m = /tierless gateway 127\.0\.0\.1:(\d+)/.exec(buf); if (m) resolve(m[0]); });
    child.on("exit", (code) => reject(new Error("gateway exited " + code)));
    setTimeout(() => reject(new Error("gateway boot timeout")), 15000);
  });
  return "ws://127.0.0.1:" + /:(\d+)/.exec(line)![1] + "/__tierless";
}
const wsHeader = await spawnGateway([]);                                       // header-auth arm
const wsCookie = await spawnGateway(["--cookie-authority"]);                   // cookie arm
check("the CLI gateway boots and prints its bound port (both arms)", wsHeader.includes("ws://") && wsCookie.includes("ws://"));

// ---- drive it -----------------------------------------------------------------------------
const browser = await chromium.launch();
const context = await browser.newContext();
await installTransportWaits(context);
recordForceBrowserRoutes(context);
const page = await context.newPage();

// 1. the header-auth arm: auth:"auto" must cost nothing
{
  await page.goto(pageUrl + "/?ws=" + encodeURIComponent(wsHeader));
  const first = await page.evaluate("window.firstCrossing") as { ms: number; status: number; body: { sawCookie: string } };
  check("same-origin REST crossed the session socket (the browser cannot reach this backend)", first.status === 200 && backendHits["/api/boot"] === 1, JSON.stringify(first));
  check("auth:'auto' on a header-auth gateway settles at socket-open — no reseal, no 5s hello stall", first.ms < 2500, first.ms + "ms");
  check("no cookie authority: the crossing carried no cookie", first.body.sawCookie === "");
}

// 2. transparent waits integrate: an upstream-style wait resolves from an autoSession crossing
{
  const wait = page.waitForResponse((res: { url(): string; ok(): boolean }) => res.url().includes("/api/items") && res.ok());
  await page.evaluate("window.cross('get', '/api/items')");
  check("installTransportWaits sees autoSession crossings", ((await wait) as { status(): number }).status() === 200);
}

// 3. fetchAdapter over the same session: JSON negotiation crosses, the rest stays stock
{
  const viaSocket = await page.evaluate("window.tfetch('/api/things', { headers: { accept: 'application/json' } })") as { status: number };
  check("fetchAdapter crosses JSON requests over the socket", viaSocket.status === 200 && backendHits["/api/things"] === 1);
  const viaBrowser = await page.evaluate("window.tfetch('/direct.json', {})") as { body: string };
  check("fetchAdapter falls through to the browser for non-JSON accepts (page server saw HTTP)", (JSON.parse(viaBrowser.body) as { direct: boolean }).direct === true && pageHits["/direct.json"] === 1);
}

// 3b. the 2-line port call: tierlessAxios installs the whole bottom on an instance
{
  const r = await page.evaluate("window.axiosCheck()") as { status: number; path: string; fellForPinned: boolean };
  check("tierlessAxios: an installed instance's requests cross the socket", r.status === 200 && r.path === "/api/axios-check" && backendHits["/api/axios-check"] === 1);
  check("tierlessAxios: pinned configs fall through to the module's own adapter (install idempotent)", r.fellForPinned === true);
}

// 4. the force-browser seam: declared globs stay on the browser's own fetch
{
  const env = await page.evaluate("window.cross('get', '/api/forced?x=1')") as { status: number; body: { forced: boolean } };
  check("a forceBrowser glob keeps the request on browser HTTP (page server hit, backend never)", env.status === 200 && env.body.forced === true && pageHits["/api/forced"] === 1 && !backendHits["/api/forced"]);
}

// 5. recorded routes: a page.route() mock fires because its pattern auto-registered as force-browser
{
  await page.route("**/api/mocked*", (route: { fulfill(o: unknown): Promise<void> }) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mock: true }) }));
  const env = await page.evaluate("window.cross('get', '/api/mocked')") as { status: number; body: { mock: boolean } };
  check("recordForceBrowserRoutes keeps mocked routes interceptable (the mock answered)", env.status === 200 && env.body.mock === true && !backendHits["/api/mocked"]);
}

// 5b. conditional crossings: an ETag'd mega-GET pays once, then revalidates — across
// page loads (CacheStorage spans them, like the browser's own HTTP cache would have)
{
  const first = await page.evaluate("window.cross('get', '/api/heavy')") as { status: number; body: { nodes: unknown[] } };
  check("cold: the heavy GET crosses in full", first.status === 200 && first.body.nodes.length === 2000 && heavyFull === 1);
  await page.waitForTimeout(200);                          // the store is off the reply path
  const second = await page.evaluate("window.cross('get', '/api/heavy')") as { status: number; body: { nodes: unknown[] } };
  check("warm, same page: revalidated to a 304 and replayed in full", second.status === 200 && second.body.nodes.length === 2000 && heavyFull === 1 && heavyRevalidated === 1, JSON.stringify({ heavyFull, heavyRevalidated }));
  await page.goto(pageUrl + "/?ws=" + encodeURIComponent(wsHeader));   // a FRESH page session, same context
  const third = await page.evaluate("window.cross('get', '/api/heavy')") as { status: number; body: { nodes: unknown[] } };
  check("fresh page session: the envelope survived the page load — 304, never a re-ship", third.status === 200 && third.body.nodes.length === 2000 && heavyFull === 1 && heavyRevalidated === 2, JSON.stringify({ heavyFull, heavyRevalidated }));
}

// 6. the cookie arm: sealed authority from the ws upgrade, no app configuration
{
  await page.goto(pageUrl + "/?ws=" + encodeURIComponent(wsCookie));
  const first = await page.evaluate("window.firstCrossing") as { ms: number; status: number; body: { sawCookie: string } };
  check("cookie authority auto-engaged: the crossing carried the httpOnly cookie the page never read", first.status === 200 && first.body.sawCookie === "sid=SECRET", JSON.stringify(first.body));
  check("the sealed blob rode the upgrade — first crossing is fast (no reseal round trip)", first.ms < 2500, first.ms + "ms");
}

// 7. the shaped-run hook: a localStorage override reroutes the socket without a rebuild
{
  await page.goto(pageUrl + "/?setOverride=" + encodeURIComponent(wsHeader));   // page derives NO explicit url
  const used = await page.evaluate("window.tierlessWsUrl");
  check("the tierlessWsUrl localStorage override wins over the derived convention", used === wsHeader, String(used));
  const env = await page.evaluate("window.cross('get', '/api/override-check')") as { status: number };
  check("and the rerouted socket carries crossings", env.status === 200 && backendHits["/api/override-check"] === 1);
}

// 8. the gateway's ws origin gate: a foreign page is refused
{
  const evil = new WebSocket(wsHeader, { headers: { origin: "http://evil.example" } });
  const outcome = await new Promise<string>((resolve) => {
    evil.on("close", () => resolve("closed"));
    evil.on("error", () => resolve("closed"));
    setTimeout(() => resolve("open"), 3000);
  });
  check("a socket from a disallowed origin is refused", outcome === "closed");
}

await browser.close();
for (const c of children) c.kill();
backend.close(); pages.close();
console.log(ok()
  ? "PASS — one-call port surface, live: the CLI gateway served both arms, autoSession crossed same-origin REST with auto cookie authority (free for header-auth, sealed-blob for cookie-auth), the force-browser seam and recorded route mocks stayed interceptable, fetchAdapter split JSON/stock correctly, and the shaped-run override rerouted the socket"
  : "FAIL");
process.exit(ok() ? 0 : 1);

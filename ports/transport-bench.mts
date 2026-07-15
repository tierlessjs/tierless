// Measure the improvement ws-over-H2 buys: time-to-ws-open under injected RTT, plain ws vs
// ws-over-H2, in a real Chromium, same page. The clean A/B is one toggle:
//   enableConnectProtocol ON  -> the browser coalesces `new WebSocket` onto the page's EXISTING
//                                H2 connection as an Extended CONNECT stream: no new handshake.
//   enableConnectProtocol OFF -> the browser can't do ws-over-H2, so it opens a SEPARATE plain
//                                wss connection: TCP + TLS + upgrade on the boot path.
// Same page, same origin, same RTT — the only difference is whether the ws shares the page's
// connection. The delta in ws-open time IS the handshake the shared-connection transport saves.
//
//   node ports/transport-bench.mts
import http2 from "node:http2";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachTierless } from "../packages/tierless/src/server.mjs";
import { attachTierlessH2, isWebSocketConnect } from "../packages/tierless/src/server.mjs";
import { delayProxy } from "./latency-proxy.mts";

const PW = "/home/user/tierless/ports/work/n8n/src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.js";
const chromium = ((await import(PW)).default as { chromium: any }).chromium;
const SHELL = "/root/pw-browsers/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";
const REPS = 6, ONE_WAY = 40;   // 80 ms RTT

const dir = mkdtempSync(join(tmpdir(), "tl-bench-"));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 1 -subj /CN=localhost`, { stdio: "ignore" });
const PAGE = `<!doctype html><meta charset=utf-8><title>bench</title><script>
const t0 = performance.now();
try {
  const ws = new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/__tierless');
  ws.onopen = () => { window.__wsOpen = Math.round(performance.now() - t0); };
  ws.onerror = () => { window.__wsErr = true; };
} catch (e) { window.__wsErr = String(e); }
</script>body`;

const bench = async (enableConnect: boolean): Promise<{ wsOpen: number; h2: number; h1: number }> => {
  const counts = { h2: 0, h1: 0 };
  const server = http2.createSecureServer({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`), allowHTTP1: true, settings: { enableConnectProtocol: enableConnect } });
  server.on("stream", (s: any, h: any) => {
    if (isWebSocketConnect(h)) { counts.h2++; return; }             // observational (attachTierlessH2 also handles it)
    if (h[":method"] === "GET") { s.respond({ ":status": 200, "content-type": "text/html" }); s.end(PAGE); }   // the page over H2 (both arms)
  });
  server.on("upgrade", () => { counts.h1++; });                     // observational: a plain-ws (H1.1) upgrade — arm A's separate connection
  const sessionOpts = { bundle: { PROGRAMS: {}, __unwind: () => false } as never, session: () => ({ exec: async () => null }) };
  attachTierless(server as never, sessionOpts);                     // plain-ws (H1.1) endpoint
  attachTierlessH2(server, sessionOpts);                            // ws-over-H2 endpoint
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const sport = (server.address() as { port: number }).port;
  const proxy = delayProxy(0, sport, ONE_WAY);                      // shape RTT in front of the server
  await new Promise((r) => setTimeout(r, 100));
  const pport = (proxy.address() as { port: number }).port;

  const browser = await chromium.launch({ headless: true, executablePath: SHELL, args: ["--ignore-certificate-errors"] });
  const opens: number[] = [];
  for (let i = 0; i < REPS; i++) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.goto(`https://127.0.0.1:${pport}/`, { waitUntil: "domcontentloaded" });
    try { await page.waitForFunction("window.__wsOpen !== undefined || window.__wsErr", { timeout: 15000 }); } catch { /* -1 */ }
    const v = (await page.evaluate("window.__wsOpen ?? -1")) as number;
    opens.push(v);
    await ctx.close();
  }
  await browser.close(); proxy.close(); server.close();
  const s = opens.filter((x) => x >= 0).sort((a, b) => a - b);
  return { wsOpen: s.length ? s[Math.floor(s.length / 2)] : -1, ...counts };
};

console.log(`\ntransport bench @ ${ONE_WAY * 2} ms RTT (median ws-open of ${REPS}, real Chromium over TLS+H2)\n`);
const off = await bench(false);
const on = await bench(true);
console.log(`plain ws     (enableConnectProtocol OFF): ws-open ${off.wsOpen} ms   [server saw h1=${off.h1} h2=${off.h2}]`);
console.log(`ws-over-H2   (enableConnectProtocol ON):  ws-open ${on.wsOpen} ms   [server saw h1=${on.h1} h2=${on.h2}]`);
console.log(`\nimprovement: ${off.wsOpen - on.wsOpen} ms faster ws-open (${off.wsOpen > 0 ? Math.round(100 * (off.wsOpen - on.wsOpen) / off.wsOpen) : 0}%) — the saved handshake`);
rmSync(dir, { recursive: true, force: true });

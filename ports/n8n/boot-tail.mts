// Boot-tail decomposition: split stock n8n's boot wall time into (1) compute/render
// FLOOR (measured at RTT0, network ~free), (2) DATA-fetch network wait (/rest + /types
// — the part a server-side pre-boot could complete during bundle download), and (3)
// ASSET-download network wait (the JS bundle — the client needs it regardless). Runs the
// BASELINE (stock HTTP) build at RTT0 and RTT80 to a data-gated app-ready signal
// (project-name), pulling Resource Timing to bucket asset vs data and to see whether the
// data fan-out is parallel (wait ~1 RTT) or serial (wait ~N RTT).
//
//   node ports/n8n/boot-tail.mts --baseline
import { bootN8n, APP } from "./boot.mts";
import { delayProxy } from "../latency-proxy.mts";

const PW = "/home/user/tierless/ports/work/n8n/src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.js";
const pw = (await import(PW)).default;
const { chromium, request } = pw;
const SHELL = "/root/pw-browsers/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";

const REPS = 3;
const DELAY_PORT = 15680; // delayProxy(15680 -> 5680) for the shaped arm
const ARMS = [
  { name: "RTT0 ", base: APP, oneWay: 0 },
  { name: "RTT80", base: "http://127.0.0.1:" + DELAY_PORT, oneWay: 40 },
];

const boot = await bootN8n();
let proxy: any;
try {
  // one reset + login; reuse cookies for every arm/rep (identical DB state)
  const rc = await request.newContext({ baseURL: APP });
  const OWNER = { email: "nathan@n8n.io", password: "PlaywrightTest123", firstName: "N", lastName: "R", mfaEnabled: false };
  let rr = await rc.post("/rest/e2e/reset", { data: { owner: OWNER, members: [], admin: { email: "admin@n8n.io", password: "PlaywrightTest123", firstName: "A", lastName: "D" }, chat: { email: "chat@n8n.io", password: "PlaywrightTest123" } } });
  if (!rr.ok()) throw new Error("reset failed: " + rr.status());
  await new Promise((r) => setTimeout(r, 1000));
  const lr = await rc.post("/rest/login", { data: { emailOrLdapLoginId: OWNER.email, password: OWNER.password } });
  if (!lr.ok()) throw new Error("login failed: " + lr.status());
  const state = await rc.storageState();

  proxy = delayProxy(DELAY_PORT, 5680, 40);
  await new Promise((r) => setTimeout(r, 300));

  const browser = await chromium.launch({ headless: true, executablePath: SHELL });
  const isData = (u: string) => /\/(rest|types)\b/.test(u);
  const isAsset = (u: string) => /\/(assets|static)\//.test(u);

  const results: Record<string, any[]> = {};
  for (const arm of ARMS) {
    results[arm.name] = [];
    for (let rep = 0; rep < REPS; rep++) {
      const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      const t0 = Date.now();
      let dcl = -1;
      page.on("domcontentloaded", () => { if (dcl < 0) dcl = Date.now() - t0; });
      await page.goto(arm.base + "/home/workflows", { waitUntil: "commit" });
      // data-gated readiness: project header only renders after the boot data resolves
      let ready = -1;
      try { await page.getByTestId("project-name").first().waitFor({ state: "visible", timeout: 45000 }); ready = Date.now() - t0; }
      catch { ready = -1; }

      // Resource Timing: bucket asset vs data, measure parallelism of the data fan-out
      const rt = (await page.evaluate(`(() => {
        const e = performance.getEntriesByType('resource').map(r => ({ n: r.name, s: r.startTime, e: r.responseEnd, ttfb: r.responseStart - r.requestStart }));
        const fcp = (performance.getEntriesByName('first-contentful-paint')[0]||{}).startTime || -1;
        return { e, fcp };
      })()`)) as any;
      const bucket = (pred: (u: string) => boolean) => {
        const es = rt.e.filter((x: any) => pred(x.n));
        if (!es.length) return { n: 0, span: 0, ttfbMax: 0, busy: 0 };
        const s = Math.min(...es.map((x: any) => x.s)), e = Math.max(...es.map((x: any) => x.e));
        const busy = es.reduce((a: number, x: any) => a + (x.e - x.s), 0); // sum of durations (serial-if-1-conn upper bound)
        const ttfbMax = Math.max(...es.map((x: any) => x.ttfb || 0));
        return { n: es.length, span: Math.round(e - s), ttfbMax: Math.round(ttfbMax), busy: Math.round(busy) };
      };
      results[arm.name].push({ dcl, ready, fcp: Math.round(rt.fcp), data: bucket(isData), asset: bucket(isAsset) });
      await ctx.close();
    }
  }
  await browser.close();
  await rc.dispose();

  // ---- report ----
  const med = (xs: number[]) => { const s = [...xs].filter((x) => x >= 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : -1; };
  const P = (s: string) => process.stdout.write(s + "\n");
  P("\n===== n8n STOCK boot tail — decomposition (median of " + REPS + " reps) =====");
  P("arm     DCL   FCP   appReady    data{n,span,ttfbMax,busy}      asset{n,span,ttfbMax,busy}");
  const m: Record<string, any> = {};
  for (const arm of ARMS) {
    const rs = results[arm.name];
    const g = (f: (r: any) => number) => med(rs.map(f));
    const dm = { n: rs[0].data.n, span: g((r) => r.data.span), ttfbMax: g((r) => r.data.ttfbMax), busy: g((r) => r.data.busy) };
    const am = { n: rs[0].asset.n, span: g((r) => r.asset.span), ttfbMax: g((r) => r.asset.ttfbMax), busy: g((r) => r.asset.busy) };
    m[arm.name] = { dcl: g((r) => r.dcl), fcp: g((r) => r.fcp), ready: g((r) => r.ready), data: dm, asset: am };
    const q = m[arm.name];
    P(arm.name + "  " + String(q.dcl).padStart(5) + " " + String(q.fcp).padStart(5) + " " + String(q.ready).padStart(9) +
      "    {" + dm.n + ", " + dm.span + ", " + dm.ttfbMax + ", " + dm.busy + "}      {" + am.n + ", " + am.span + ", " + am.ttfbMax + ", " + am.busy + "}");
  }
  const f = m["RTT0 "], s = m["RTT80"];
  P("\n== decomposition of appReady @ RTT80 ==");
  P("  compute/render FLOOR (appReady @ RTT0, network ~free): " + f.ready + " ms   <- IRREDUCIBLE");
  P("  total network wait added by 80ms RTT (appReady80 - appReady0): " + (s.ready - f.ready) + " ms");
  P("  data fan-out shape @RTT80: " + s.data.n + " reqs, wall span " + s.data.span + " ms, worst single TTFB " + s.data.ttfbMax +
    " ms  -> " + (s.data.span <= s.data.ttfbMax * 2 ? "PARALLEL (wait ~1-2 RTT)" : "SERIAL (dependency depth)"));
  P("  asset download @RTT80: " + s.asset.n + " reqs, wall span " + s.asset.span + " ms, worst TTFB " + s.asset.ttfbMax + " ms");
  P("");
  P("  SERVER-PRE-COMPLETABLE (data-fetch wait the pre-boot hides) ~= data span @80 - data span @0 = " +
    (s.data.span - f.data.span) + " ms");
  P("  NOT hideable by pre-boot (client needs the bundle) ~= asset span @80 - asset span @0 = " +
    (s.asset.span - f.asset.span) + " ms");
} finally {
  if (proxy) proxy.close();
  boot.close();
}

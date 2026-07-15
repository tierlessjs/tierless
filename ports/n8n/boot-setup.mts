// Boot-setup timing across the port's boot-latency arms, high resolution (isolates the
// setup cost the whole-test duration buries). Boots the PORTED build once per arm with the
// gateway toggles set, drives an authenticated boot at RTT80, and reads: FCP, app-ready, and
// the session exec log's first/last crossing time + crossing count (a preboot JOIN does NOT
// cross, so its count drops — direct evidence). Arms:
//   P0  auth off, preboot off   -> HTTP reseal round trip (the pre-fix port behavior)
//   P1  auth on,  preboot off   -> reseal folded into the ws upgrade
//   P2  auth on,  preboot on    -> + boot GETs pre-fetched at upgrade, first crossings join
//
//   node ports/n8n/boot-setup.mts
import { bootN8n, APP } from "./boot.mts";
import { delayProxy } from "../latency-proxy.mts";

const PW = "/home/user/tierless/ports/work/n8n/src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.js";
const pw = (await import(PW)).default;
const { chromium, request } = pw;
const SHELL = "/root/pw-browsers/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";
const REPS = 4;
const SHAPED = "http://127.0.0.1:15680";   // delayProxy(15680->5680 app, 15780->5780 gateway)

const ARMS = [
  { name: "P0 reseal-http ", env: { TIERLESS_HELLO_AUTH: "0", TIERLESS_PREBOOT: "0" } },
  { name: "P1 reseal-upgrd", env: { TIERLESS_HELLO_AUTH: "1", TIERLESS_PREBOOT: "0" } },
  { name: "P2 +preboot    ", env: { TIERLESS_HELLO_AUTH: "1", TIERLESS_PREBOOT: "1", TIERLESS_PREBOOT_FILE: "/home/user/tierless/ports/n8n/results/preboot-manifest.txt" } },
];

const READY = "project-name";   // best-effort DOM ready; short timeout, -1 if absent (FCP + crossings are the primary signals)
const med = (xs: number[]): number => { const s = xs.filter((x) => x >= 0).sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : -1; };

const browser = await chromium.launch({ headless: true, executablePath: SHELL });
const OWNER = { email: "nathan@n8n.io", password: "PlaywrightTest123", firstName: "N", lastName: "R", mfaEnabled: false };
const results: Record<string, any[]> = {};

// app + gateway RTT proxies stay up across arms; only the gateway env changes (fresh boot per arm)
let p1: any, p2: any;
try {
  for (const arm of ARMS) {
    for (const k of ["TIERLESS_HELLO_AUTH", "TIERLESS_PREBOOT", "TIERLESS_PREBOOT_FILE"]) delete process.env[k];
    for (const [k, v] of Object.entries(arm.env)) process.env[k] = v as string;
    const boot = await bootN8n();
    if (!p1) { p1 = delayProxy(15680, 5680, 40); p2 = delayProxy(15780, 5780, 40); await new Promise((r) => setTimeout(r, 300)); }
    try {
      const rc = await request.newContext({ baseURL: APP });
      let rr = await rc.post("/rest/e2e/reset", { data: { owner: OWNER, members: [], admin: { email: "admin@n8n.io", password: "PlaywrightTest123", firstName: "A", lastName: "D" }, chat: { email: "chat@n8n.io", password: "PlaywrightTest123" } } });
      if (!rr.ok()) throw new Error("reset " + rr.status());
      await new Promise((r) => setTimeout(r, 800));
      const lr = await rc.post("/rest/login", { data: { emailOrLdapLoginId: OWNER.email, password: OWNER.password } });
      if (!lr.ok()) throw new Error("login " + lr.status());
      const state = await rc.storageState();
      results[arm.name] = [];
      for (let rep = 0; rep < REPS; rep++) {
        const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
        const page = await ctx.newPage();
        const t0 = Date.now();
        await page.goto(SHAPED + "/home/workflows", { waitUntil: "commit" });
        // wait for the boot to settle on the transport metric — the LAST boot crossing —
        // then read timings. A short DOM ready check is best-effort (project-name), -1 if absent.
        let ready = -1;
        try { await page.getByTestId(READY).first().waitFor({ state: "visible", timeout: 8000 }); ready = Date.now() - t0; } catch { /* -1 */ }
        // let the boot crossings finish arriving (they settle within a few RTTs of the socket)
        await page.waitForTimeout(6000);
        // crossings log wall-clock t (Date.now); relate to nav start t0 (same host clock). A
        // preboot JOIN never reaches the exec, so it is absent — crossings count drops on P2.
        const m = (await page.evaluate((t0v: number) => {
          const fcp = (performance.getEntriesByName("first-contentful-paint")[0] || ({} as { startTime?: number })).startTime ?? -1;
          const log = ((window as { __tierlessExecLog?: { t: number }[] }).__tierlessExecLog) || [];
          const ts = log.map((e) => e.t).filter((t) => typeof t === "number");
          return { fcp: Math.round(fcp), crossings: log.length, first: ts.length ? Math.min(...ts) - t0v : -1, last: ts.length ? Math.max(...ts) - t0v : -1 };
        }, t0)) as any;
        results[arm.name].push({ ready, ...m });
        await ctx.close();
      }
      await rc.dispose();
      const rs = results[arm.name];
      process.stderr.write(`[arm ${arm.name.trim()}] done: ${rs.length} reps, fcp~${med(rs.map((r) => r.fcp))} first~${med(rs.map((r) => r.first))} last~${med(rs.map((r) => r.last))} crossings~${med(rs.map((r) => r.crossings))}\n`);
    } finally { boot.close(); await new Promise((r) => setTimeout(r, 1500)); }
  }
  await browser.close();

  const P = (s: string) => process.stdout.write(s + "\n");
  P("\n===== ported boot setup timing @ RTT80 (median of " + REPS + ") =====");
  P("arm              appReady   FCP   firstCross  lastCross  crossings");
  const M: Record<string, any> = {};
  for (const arm of ARMS) {
    const rs = results[arm.name]; const g = (f: (r: any) => number) => med(rs.map(f));
    M[arm.name] = { ready: g((r) => r.ready), fcp: g((r) => r.fcp), first: g((r) => r.first), last: g((r) => r.last), crossings: g((r) => r.crossings) };
    const q = M[arm.name];
    P(arm.name + "  " + String(q.ready).padStart(7) + " " + String(q.fcp).padStart(6) + " " + String(q.first).padStart(11) + " " + String(q.last).padStart(10) + " " + String(q.crossings).padStart(9));
  }
  const d = (a: string, b: string, f: string) => M[a][f] - M[b][f];
  P("\n== deltas (lower = better) ==");
  P("  reseal-in-upgrade (P0->P1): appReady " + d("P0 reseal-http ", "P1 reseal-upgrd", "ready") + " ms, firstCross " + d("P0 reseal-http ", "P1 reseal-upgrd", "first") + " ms");
  P("  + preboot        (P1->P2): appReady " + d("P1 reseal-upgrd", "P2 +preboot    ", "ready") + " ms, lastCross " + d("P1 reseal-upgrd", "P2 +preboot    ", "last") + " ms, crossings " + d("P1 reseal-upgrd", "P2 +preboot    ", "crossings"));
  P("  full fix         (P0->P2): appReady " + d("P0 reseal-http ", "P2 +preboot    ", "ready") + " ms");
} finally {
  if (p1) p1.close(); if (p2) p2.close();
}

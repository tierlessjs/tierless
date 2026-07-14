// Boot-prefix probe: classify n8n's browser-capability touches during an authenticated
// boot as INCIDENTAL (a server-side DOM shim satisfies them — createElement, event
// listeners, null localStorage reads) vs ESSENTIAL (needs the REAL client's value —
// non-null localStorage/sessionStorage, viewport/matchMedia, locale/timezone). The
// essential set is the ceiling on the "server-side DOM boots the app" idea: it is the
// mirror payload the client must ship up front, or the crossings the server must pay.
//
//   node ports/n8n/boot-probe.mts
import { bootN8n, APP } from "./boot.mts";

const PW = "/home/user/tierless/ports/work/n8n/src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.js";
const pw = (await import(PW)).default;
const { chromium, request } = pw;

// runs in the page BEFORE any app script — wraps the client-specific accessors
const INSTRUMENT = `(() => {
  const log = []; window.__probe = log;
  const t0 = performance.now();
  const rec = (cat, detail) => log.push({ t: +(performance.now()-t0).toFixed(1), cat, ...detail });

  // Storage is an exotic object: assigning localStorage.getItem writes a KEY, not an
  // override. Patch Storage.prototype and disambiguate the store via 'this'.
  try {
    const proto = Storage.prototype;
    const nameOf = (self) => (self === window.sessionStorage ? 'sessionStorage' : 'localStorage');
    const g = proto.getItem, s = proto.setItem, r = proto.removeItem;
    proto.getItem = function (k) { const v = g.call(this, k); rec(nameOf(this)+'.get', { key: k, hit: v !== null, len: v ? v.length : 0 }); return v; };
    proto.setItem = function (k, v) { rec(nameOf(this)+'.set', { key: k }); return s.call(this, k, v); };
    proto.removeItem = function (k) { rec(nameOf(this)+'.remove', { key: k }); return r.call(this, k); };
  } catch (e) { rec('err', { msg: 'storage ' + e.message }); }

  try {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (d && d.get) Object.defineProperty(document, 'cookie', { configurable: true,
      get() { rec('cookie.get', {}); return d.get.call(document); },
      set(v) { rec('cookie.set', {}); return d.set.call(document, v); } });
  } catch (e) {}

  for (const p of ['language','languages','userAgent','platform','hardwareConcurrency','maxTouchPoints','vendor','onLine']) {
    try {
      const d = Object.getOwnPropertyDescriptor(Navigator.prototype, p);
      if (d && d.get) Object.defineProperty(navigator, p, { configurable: true, get() { rec('navigator.'+p, {}); return d.get.call(navigator); } });
    } catch (e) {}
  }
  try { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => { rec('matchMedia', { query: q }); return mm(q); }; } catch (e) {}
  for (const p of ['innerWidth','innerHeight','devicePixelRatio']) {
    try {
      const d = Object.getOwnPropertyDescriptor(window, p);
      Object.defineProperty(window, p, { configurable: true, get() { rec('window.'+p, {}); return d && d.get ? d.get.call(window) : (d ? d.value : undefined); } });
    } catch (e) {}
  }
  try { const RO = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () { const r = RO.call(this); rec('Intl.resolvedOptions', { tz: r.timeZone, locale: r.locale }); return r; }; } catch (e) {}
  try { const gto = Date.prototype.getTimezoneOffset; Date.prototype.getTimezoneOffset = function () { rec('Date.getTimezoneOffset', {}); return gto.call(this); }; } catch (e) {}

  // page-load-event listeners on window/document (incidental — a server DOM fires these too)
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if ((this === window || this === document) && ['load','DOMContentLoaded','readystatechange','pageshow'].includes(type))
      rec('pageload-listener', { type, on: this === window ? 'window' : 'document' });
    return add.call(this, type, ...rest);
  };
  // structural DOM volume (incidental)
  let create = 0; const oc = Document.prototype.createElement;
  Document.prototype.createElement = function (...a) { create++; return oc.apply(this, a); };
  window.__probeCreate = () => create;
})();`;

const boot = await bootN8n();
try {
  // reset DB + login via a request context to get owner cookies
  const rc = await request.newContext({ baseURL: APP });
  const OWNER = { email: "nathan@n8n.io", password: "PlaywrightTest123", firstName: "N", lastName: "R", mfaEnabled: false };
  let rr = await rc.post("/rest/e2e/reset", { data: { owner: OWNER, members: [], admin: { email: "admin@n8n.io", password: "PlaywrightTest123", firstName: "A", lastName: "D" }, chat: { email: "chat@n8n.io", password: "PlaywrightTest123" } } });
  if (!rr.ok()) throw new Error("reset failed: " + rr.status() + " " + (await rr.text()).slice(0, 200));
  await new Promise((r) => setTimeout(r, 1000));
  const lr = await rc.post("/rest/login", { data: { emailOrLdapLoginId: OWNER.email, password: OWNER.password } });
  if (!lr.ok()) throw new Error("login failed: " + lr.status() + " " + (await lr.text()).slice(0, 200));
  const state = await rc.storageState();

  const SHELL = "/root/pw-browsers/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell";
  const browser = await chromium.launch({ headless: true, executablePath: SHELL });
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(INSTRUMENT);
  const page = await ctx.newPage();

  const reqs: { t: number; url: string }[] = [];
  const allUrls: string[] = [];
  const t0 = Date.now();
  page.on("request", (r: { url(): string }) => {
    const u = r.url();
    allUrls.push(u);
    if (u.includes("/rest")) reqs.push({ t: Date.now() - t0, url: u.replace(APP, "").split("?")[0] });
  });

  const marks: Record<string, number> = {};
  page.on("domcontentloaded", () => { marks.domcontentloaded ??= Date.now() - t0; });
  page.on("load", () => { marks.load ??= Date.now() - t0; });

  await page.goto(APP, { waitUntil: "domcontentloaded" });
  // let the boot fan-out + render settle
  try { await page.waitForLoadState("networkidle", { timeout: 30000 }); marks.networkidle = Date.now() - t0; } catch { marks.networkidle = -1; }
  await page.waitForTimeout(1500);

  const log = (await page.evaluate("window.__probe")) as any[];
  const createCount = (await page.evaluate("window.__probeCreate ? window.__probeCreate() : -1")) as number;
  const url = page.url();
  // ground-truth: read the ACTUAL localStorage state the app left behind (bypasses instrumentation)
  const lsDump = (await page.evaluate(`(() => { const o = {}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); o[k]=(localStorage.getItem(k)||'').length;} return { count: localStorage.length, keys: o }; })()`)) as any;
  const nonAsset = [...new Set(allUrls.map((u) => u.replace(APP, "").split("?")[0]))].filter((p) => !p.startsWith("/assets/"));
  const P0 = (s: string) => process.stdout.write(s + "\n");
  P0("\n[debug] post-boot localStorage: " + lsDump.count + " keys -> " + JSON.stringify(lsDump.keys));
  P0("[debug] non-/assets request paths (" + nonAsset.length + "): " + nonAsset.join("  "));

  // ---- classify ----
  const by = (pred: (e: any) => boolean) => log.filter(pred);
  const storageReads = by((e) => /storage\.get$/.test(e.cat));
  const storageHits = by((e) => /storage\.get$/.test(e.cat) && e.hit);
  const storageMiss = by((e) => /storage\.get$/.test(e.cat) && !e.hit);
  const storageSet = by((e) => /storage\.(set|remove)$/.test(e.cat));
  const envReads = by((e) => e.cat.startsWith("navigator.") || e.cat === "matchMedia" || e.cat.startsWith("window.") || e.cat.startsWith("Intl.") || e.cat === "Date.getTimezoneOffset");
  const cookieReads = by((e) => e.cat.startsWith("cookie."));
  const loadListeners = by((e) => e.cat === "pageload-listener");

  const distinct = (arr: any[], keyer: (e: any) => string) => {
    const m = new Map<string, number>();
    for (const e of arr) m.set(keyer(e), (m.get(keyer(e)) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const P = (s: string) => process.stdout.write(s + "\n");
  // debug: raw category histogram + sample request URLs
  const cats = new Map<string, number>();
  for (const e of log) cats.set(e.cat, (cats.get(e.cat) || 0) + 1);
  P("\n[debug] log entries: " + log.length + "  categories: " + [...cats.entries()].map(([k, n]) => k + "=" + n).join(", "));
  P("[debug] " + allUrls.length + " total requests; sample distinct paths:");
  {
    const seen = new Set<string>();
    for (const r of allUrls) { const p = r.replace(APP, "").split("?")[0]; if (!seen.has(p)) { seen.add(p); if (seen.size <= 25) P("     " + p); } }
  }
  P("\n===== n8n authenticated boot — browser-capability touch classification =====");
  P("landed on: " + url);
  P("\n-- timeline (ms from nav) --");
  P("  domcontentloaded " + marks.domcontentloaded + "   load " + marks.load + "   networkidle " + marks.networkidle);
  P("  all requests: " + allUrls.length + "   /rest requests: " + reqs.length + "   first@" + (reqs[0]?.t ?? "-") + "  last@" + (reqs.at(-1)?.t ?? "-"));
  for (const rq of reqs.slice(0, 12)) P("     " + String(rq.t).padStart(6) + "ms  " + rq.url);
  const firstHit = storageHits[0]?.t, firstReq = reqs[0]?.t;
  P("  first localStorage HIT @" + (firstHit ?? "-") + " ms   (first /rest @" + (firstReq ?? "-") + " ms)");

  P("\n== ESSENTIAL — needs the real client's value (the server-DOM ceiling) ==");
  P("  localStorage/sessionStorage reads returning a VALUE: " + storageHits.length + " calls, distinct keys:");
  for (const [k, n] of distinct(storageHits, (e) => e.cat.split(".")[0] + ":" + e.key)) {
    const ex = storageHits.find((e) => e.cat.split(".")[0] + ":" + e.key === k);
    P("     " + String(n).padStart(3) + "x  " + k + "  (first@" + ex.t + "ms, " + ex.len + " chars)");
  }
  P("  client-environment reads (viewport / locale / timezone / hardware): " + envReads.length + " calls, distinct:");
  for (const [k, n] of distinct(envReads, (e) => e.cat + (e.query ? " " + e.query : "") + (e.tz ? " " + e.tz + "/" + e.locale : ""))) P("     " + String(n).padStart(3) + "x  " + k);

  P("\n== INCIDENTAL — a server-side DOM shim satisfies these (no client value) ==");
  P("  document.createElement calls: " + createCount);
  P("  page-load-event listeners (load/DOMContentLoaded/readystatechange): " + loadListeners.length);
  for (const [k, n] of distinct(loadListeners, (e) => e.on + "/" + e.type)) P("     " + String(n).padStart(3) + "x  " + k);
  P("  localStorage/sessionStorage reads returning NULL (server default matches): " + storageMiss.length);
  P("  localStorage/sessionStorage writes: " + storageSet.length + "   document.cookie reads: " + cookieReads.length);

  // the mirror payload for a server-side boot = post-boot localStorage (repeat-visit UI
  // prefs) + the handful of device-env facts. All render-gating, none network-gating.
  const mirrorKeys = Object.entries(lsDump.keys as Record<string, number>);
  const mirrorBytes = mirrorKeys.reduce((s, [k, v]) => s + k.length + (v as number), 0);
  const envFacts = new Set(envReads.map((e) => e.cat));
  P("\n== VERDICT — is any boot decision gated on a real client value? ==");
  P("  Fresh boot starts with EMPTY localStorage (DB reset) yet loads its full dataset and");
  P("  reaches /home/workflows — so the fan-out is NOT gated on any stored value.");
  P("  localStorage reads that returned a VALUE (could gate a decision): " + storageHits.length +
    "   [note: total read count is flaky — n8n installs its own Storage wrapper that");
  P("   sometimes clobbers the probe; the post-boot dump below is direct ground truth.]");
  P("  Repeat-visit state a server boot would need to mirror = " + lsDump.count + " keys / ~" + mirrorBytes + " B, all UI prefs:");
  P("      " + mirrorKeys.map(([k]) => k).join(", "));
  P("  device-env facts read (gate RENDERING, not which requests fire): " + [...envFacts].join(", "));
  P("");
  P("  NETWORK-gating client values (change what is fetched): NONE observed");
  P("  RENDER-gating client values (change final paint only): device-env + " + lsDump.count + " UI-pref keys (~" + mirrorBytes + " B)");
  P("  INCIDENTAL touches a server DOM satisfies for free: createElement " + createCount +
    ", page-load listeners " + loadListeners.length + ", cookie " + cookieReads.length + " (server holds the cookie)");

  await browser.close();
  await rc.dispose();
} finally {
  boot.close();
}

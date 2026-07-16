// Transport-agnostic Playwright waits — the corpus run protocol's test-accommodation
// surface (docs/corpus.md), generalized out of the per-port patches.
//
// A ported build serves an app's same-origin REST over the tierless session socket, so
// the HTTP response a stock test waits on (`page.waitForResponse(...)`) can never fire —
// the request leaves as a ws frame the browser's network stack never sees. The per-port
// answer was to rewrite every such wait by hand: ~1,450 patch lines across the first
// four ports were exactly this rewrite. This module is the general answer:
// `installTransportWaits(pageOrContext)` re-binds `page.waitForResponse` /
// `page.waitForRequest` IN PLACE to race the original HTTP wait against the page's
// tierless exec log (the opt-in per-crossing record in browser.mts). The caller's own
// matcher runs unchanged — predicate, glob, or RegExp form — against a Response-shaped
// facade of each crossing, and the resolved value keeps the caller's read surface
// (`.json()`, `.ok()`, `.request().postDataJSON()`, …), so upstream tests pass with NO
// edit to the spec files.
//
// Honesty posture (identical to the per-port patches it replaces — corpus.md "test
// accommodations", applied to BOTH arms):
// - On the stock build no crossing is ever logged, so every wait reduces to the original
//   HTTP wait exactly: same matcher, same options, and the TIMEOUT stays Playwright's
//   own — the crossing side keeps no timer of its own, so a timed-out wait rejects with
//   the untouched TimeoutError from the untouched clock on both arms.
// - A wait is never weakened: a crossing wins the race only by passing the caller's own
//   matcher (their predicate, their glob) against what the crossing truthfully carries.
// - Facades answer only what the log records (url, method, status, headers, bodies). A
//   predicate that reads beyond that (e.g. `frame()`) makes the facade THROW; the throw
//   is caught, warned once, and treated as no-match — the wait can then only be
//   satisfied by real HTTP, never by a fabricated answer.
//
// What still needs hand patches: tests that assert transport SEMANTICS the port
// deliberately changes — a `page.route` mock the socket would bypass (the force-browser
// seam), or a wait whose removal reorders the app (semantic accommodations, each with
// its own why-comment in the recipe's testPatches).
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import path from "node:path";

// One crossing as browser.mts records it (opt-in via __TIERLESS_EXEC_LOG__).
interface LogEntry { t: number; name: string; url: string; status?: number; headers?: Record<string, string>; reqBody?: unknown; reqHeaders?: Record<string, string>; body?: unknown }
interface Crossing { seq: number; url: string; e: LogEntry }

// Structural slices of Playwright's Page/BrowserContext — this module must not make the
// tierless package depend on Playwright (the target suite brings its own copy).
interface FrameLike { url(): string }
interface BindingSource { page?: object; frame?: FrameLike }
interface Bindable {
  exposeBinding(name: string, cb: (source: BindingSource, arg: string) => unknown): Promise<void>;
  addInitScript(script: string): Promise<void>;
}
export interface PageLike extends Bindable {
  evaluate(script: string): Promise<unknown>;
  waitForResponse(urlOrPredicate: unknown, options?: unknown): Promise<unknown>;
  waitForRequest(urlOrPredicate: unknown, options?: unknown): Promise<unknown>;
}
export interface ContextLike extends Bindable {
  pages(): PageLike[];
  on(event: "page", cb: (page: PageLike) => void): unknown;
}

const BINDING = "__tierlessCrossingPush";

// Page-side wiring, per document (init script for future documents, evaluate for the
// current one): turn the exec log on and forward each push to the Node-side binding.
// The runtime does `__tierlessExecLog ||= []`, so wiring the array FIRST keeps ours; if
// the runtime got there first, we wrap the existing array's own push in place AND drain
// what already landed — the lazy (prototype-patched) path wires on a page's first wait,
// which may be after crossings settled; the arm-time filter below keeps drained history
// from satisfying a wait it predates. Entries ride as JSON strings — they crossed the
// wire already, so they are JSON-safe by construction. On a stock build nothing ever
// pushes and this is inert.
const PAGE_WIRE = `(() => {
  const g = globalThis;
  g.__TIERLESS_EXEC_LOG__ = true;
  const log = (g.__tierlessExecLog = g.__tierlessExecLog || []);
  if (log.__tierlessPushWired) return;
  Object.defineProperty(log, "__tierlessPushWired", { value: true });
  const fwd = (it) => {
    try { const p = g.${BINDING}(JSON.stringify(it)); if (p && typeof p.catch === "function") p.catch(() => {}); } catch (e) { /* binding gone mid-navigation */ }
  };
  for (let i = 0; i < log.length; i++) fwd(log[i]);
  const base = log.push.bind(log);
  log.push = function () {
    for (let i = 0; i < arguments.length; i++) fwd(arguments[i]);
    return base.apply(null, arguments);
  };
})()`;

interface State {
  seq: number;
  entries: Crossing[];
  gate: Promise<void>;                       // resolves on the next push (or stop bump)
  bump: () => void;
  push: (e: LogEntry, frameUrl: string) => void;
  warnOnce: (key: string, msg: string) => void;
}

const STATES = new WeakMap<object, State>();
const PATCHED = new WeakSet<object>();
const BOUND = new WeakSet<object>();

function stateFor(page: object, warn: (msg: string) => void): State {
  let st = STATES.get(page);
  if (st) return st;
  let open!: () => void;
  const warned = new Set<string>();
  st = {
    seq: 0,
    entries: [],
    gate: new Promise<void>((r) => (open = r)),
    bump: () => { const o = open; st!.gate = new Promise<void>((r) => (open = r)); o(); },
    push: (e, frameUrl) => {
      // absolute URL: the log records the crossing's own arg (usually an origin-relative
      // path); upstream matchers see full URLs, so resolve against the logging document
      let url = String(e.url ?? "");
      try { url = new URL(url, frameUrl || undefined).href; } catch { /* keep raw */ }
      st!.entries.push({ seq: ++st!.seq, url, e });
      if (st!.entries.length > 2000) st!.entries.splice(0, st!.entries.length - 2000);
      st!.bump();
    },
    warnOnce: (key, msg) => { if (!warned.has(key)) { warned.add(key); warn("[tierless/playwright] " + msg); } },
  };
  STATES.set(page, st);
  return st;
}

// ---------------------------------------------------------------------- facades ----
// Only what a crossing truthfully carries. Everything else throws a descriptive error —
// caught by the matcher (no-match + one warning), loud if reached from a resolved value.
const unsupported = (member: string) => new Error("tierless crossing facade: " + member + " is not carried by a session crossing — match on url/method/status/headers/bodies instead");
const methodOf = (e: LogEntry): string => (String(e.name || "").split(".").pop() || "").toUpperCase();
const lower = (h: Record<string, string> | undefined): Record<string, string> => { const out: Record<string, string> = {}; for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = v; return out; };
const textOf = (e: LogEntry): string => (typeof e.body === "string" ? e.body : e.body === undefined ? "" : JSON.stringify(e.body));
const reqTextOf = (e: LogEntry): string | null => (e.reqBody === undefined ? null : typeof e.reqBody === "string" ? e.reqBody : JSON.stringify(e.reqBody));

function requestFacade(c: Crossing): Record<string, unknown> {
  const e = c.e, headers = lower(e.reqHeaders);
  return {
    __tierlessCrossing: true,
    url: () => c.url,
    method: () => methodOf(e),
    headers: () => ({ ...headers }),
    allHeaders: async () => ({ ...headers }),
    headersArray: async () => Object.entries(headers).map(([name, value]) => ({ name, value })),
    headerValue: async (name: string) => headers[String(name).toLowerCase()] ?? null,
    postData: () => reqTextOf(e),
    postDataBuffer: () => { const t = reqTextOf(e); return t === null ? null : Buffer.from(t); },
    postDataJSON: () => (typeof e.reqBody === "string" ? JSON.parse(e.reqBody) : e.reqBody),
    resourceType: () => "fetch",
    isNavigationRequest: () => false,
    failure: () => null,
    redirectedFrom: () => null,
    redirectedTo: () => null,
    serviceWorker: () => null,
    response: async () => (e.status === undefined ? null : responseFacade(c)),
    frame: () => { throw unsupported("request.frame()"); },
    sizes: async () => { throw unsupported("request.sizes()"); },
    timing: () => { throw unsupported("request.timing()"); },
  };
}

function responseFacade(c: Crossing): Record<string, unknown> {
  const e = c.e, headers = lower(e.headers);
  return {
    __tierlessCrossing: true,
    url: () => c.url,
    status: () => e.status ?? 0,
    ok: () => (e.status ?? 0) >= 200 && (e.status ?? 0) <= 299,
    statusText: () => "",                                     // Playwright itself returns "" for HTTP/2
    headers: () => ({ ...headers }),
    allHeaders: async () => ({ ...headers }),
    headersArray: async () => Object.entries(headers).map(([name, value]) => ({ name, value })),
    headerValue: async (name: string) => headers[String(name).toLowerCase()] ?? null,
    headerValues: async (name: string) => { const v = headers[String(name).toLowerCase()]; return v === undefined ? [] : [v]; },
    json: async () => (typeof e.body === "string" ? JSON.parse(e.body) : e.body),
    text: async () => textOf(e),
    body: async () => Buffer.from(textOf(e)),
    finished: async () => null,
    fromServiceWorker: () => false,
    request: () => requestFacade(c),
    securityDetails: async () => null,
    serverAddr: async () => null,
    frame: () => { throw unsupported("response.frame()"); },
  };
}

// ------------------------------------------------------------------ url matching ----
// Playwright-faithful glob → regex, shared with the force-browser seam (url-glob.mts;
// the live proof differentially verifies it against the installed playwright-core).
import { globToRegexPattern } from "./url-glob.mjs";
export { globToRegexPattern } from "./url-glob.mjs";

// Playwright resolves a non-`*`-leading string pattern against the context baseURL,
// which a Page doesn't expose; the crossing's own absolute URL is the closest truthful
// base (these suites' baseURL IS the page origin). Patterns starting with `*` — every
// one observed across the four ports — never touch this path.
function globMatches(pattern: string, url: string): boolean {
  let resolved = pattern;
  if (!pattern.startsWith("*")) { try { resolved = new URL(pattern, url).href; } catch { /* keep raw */ } }
  return new RegExp(globToRegexPattern(resolved)).test(url);
}

// ---------------------------------------------------------------------- the race ----
type Kind = "response" | "request";
// Accept: facade when the crossing satisfies the caller's matcher, null otherwise.
type Accept = (c: Crossing) => Promise<unknown | null>;

function matcherFor(arg: unknown, kind: Kind, st: State): Accept {
  const make = (c: Crossing) => (kind === "response" ? responseFacade(c) : requestFacade(c));
  // a RESPONSE wait needs a settled REST envelope (a status); request waits take any
  // logged crossing — note a crossing is recorded when it SETTLES, so a request-side
  // wait observes the send later than stock would (the send provably happened)
  const gate = (c: Crossing) => kind === "request" || c.e.status !== undefined;
  if (typeof arg === "function") {
    return async (c) => {
      if (!gate(c)) return null;
      const facade = make(c);
      try { return (await (arg as (x: unknown) => unknown)(facade)) ? facade : null; }
      catch (err) {
        st.warnOnce(kind + ":" + String(err), "a waitFor" + (kind === "response" ? "Response" : "Request") + " predicate threw against a tierless crossing facade (" + String(err) + "); this wait can now only be satisfied by real HTTP");
        return null;
      }
    };
  }
  if (arg instanceof RegExp) return async (c) => (gate(c) && arg.test(c.url) ? make(c) : null);
  if (typeof arg === "string") return async (c) => (gate(c) && globMatches(arg, c.url) ? make(c) : null);
  return async () => null;
}

const STOPPED = Symbol("tierless-crossing-wait-stopped");

// Resolve with the first crossing after `cursor` the matcher accepts; reject STOPPED
// when the HTTP side settled first. Entries arriving mid-scan are picked up by seq.
// `armT` (wall clock, same machine as the page) excludes crossings that COMPLETED
// before this wait was armed — Playwright's own semantics — which matters on the lazy
// path, where wiring a page's first wait drains crossings that predate it.
function firstCrossing(st: State, accept: Accept, armT: number): { promise: Promise<unknown>; stop: () => void } {
  let stopped = false;
  const cursor = st.seq;
  const promise = (async () => {
    let last = cursor;
    while (!stopped) {
      const gate = st.gate;                              // capture BEFORE scanning: a push during the scan re-arms it
      const next = st.entries.find((c) => c.seq > last);
      if (next) {
        last = next.seq;
        if (next.e.t < armT) continue;
        const facade = await accept(next);
        if (facade != null) return facade;
        continue;
      }
      await gate;
    }
    throw STOPPED;
  })();
  return { promise, stop: () => { stopped = true; st.bump(); } };
}

// First success wins; rejection (timeout, page close) only ever comes from the HTTP
// side — Playwright's own clock and error, untouched on both arms.
function raced(http: Promise<unknown>, crossing: { promise: Promise<unknown>; stop: () => void }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let done = false;
    http.then(
      (v) => { if (!done) { done = true; crossing.stop(); resolve(v); } },
      (e) => { if (!done) { done = true; crossing.stop(); reject(e); } },
    );
    crossing.promise.then(
      (v) => { if (!done) { done = true; resolve(v); } },
      () => {},                                          // STOPPED (or a scan error): the HTTP side is the outcome
    );
  });
}

function patchPage(page: PageLike, warn: (msg: string) => void): void {
  if (PATCHED.has(page)) return;
  PATCHED.add(page);
  const st = stateFor(page, warn);
  for (const [method, kind] of [["waitForResponse", "response"], ["waitForRequest", "request"]] as [keyof PageLike & ("waitForResponse" | "waitForRequest"), Kind][]) {
    const orig = (page[method] as (u: unknown, o?: unknown) => Promise<unknown>).bind(page);
    (page as unknown as Record<string, unknown>)[method] = (urlOrPredicate: unknown, options?: unknown) =>
      raced(orig(urlOrPredicate, options), firstCrossing(st, matcherFor(urlOrPredicate, kind, st), Date.now()));
  }
}

async function bindTarget(target: Bindable, warn: (msg: string) => void): Promise<void> {
  if (BOUND.has(target)) return;
  BOUND.add(target);
  try {
    await target.exposeBinding(BINDING, (source, json) => {
      const page = source && source.page;
      if (!page) return;
      let e: LogEntry;
      try { e = JSON.parse(String(json)) as LogEntry; } catch { return; }
      const frameUrl = source.frame && typeof source.frame.url === "function" ? source.frame.url() : "";
      stateFor(page, warn).push(e, frameUrl);
    });
  } catch (err) {
    // page-level install after a context-level one (or vice versa): the binding is
    // already reachable from the page — anything else is a real error
    if (!/already registered|has been already registered/i.test(String(err))) throw err;
  }
  await target.addInitScript(PAGE_WIRE);
}

// Per-page wiring for the LAZY (prototype-patched) path: binding + init script + the
// current document, memoized. Fire-and-forget from a wait call — the crossing watcher
// reads the page's state, which fills as soon as this lands; a wait armed at the same
// call only matches later crossings anyway (its cursor is taken at arm time).
const WIRED = new WeakMap<object, Promise<void>>();
function wirePage(page: PageLike, warn: (msg: string) => void): Promise<void> {
  let p = WIRED.get(page);
  if (!p) {
    p = bindTarget(page, warn).then(() => page.evaluate(PAGE_WIRE).then(() => undefined, () => undefined));
    WIRED.set(page, p);
  }
  return p;
}

/** Patch `waitForResponse`/`waitForRequest` on a Page — or on a BrowserContext and every
 *  page it ever creates (popups included) — to also accept tierless session crossings.
 *  Idempotent. Call it once from the suite's fixture/setup; upstream spec files need no
 *  edits. `warn` (default console.warn) receives the once-per-cause notes when a
 *  caller's predicate reads something a crossing can't carry. */
export async function installTransportWaits(target: PageLike | ContextLike, { warn = (msg: string) => console.warn(msg) }: { warn?: (msg: string) => void } = {}): Promise<void> {
  await bindTarget(target, warn);
  if (typeof (target as ContextLike).pages === "function") {
    const ctx = target as ContextLike;
    for (const p of ctx.pages()) { patchPage(p, warn); void p.evaluate(PAGE_WIRE).catch(() => {}); }
    ctx.on("page", (p) => patchPage(p, warn));           // its documents get the init script
  } else {
    const page = target as PageLike;
    patchPage(page, warn);
    // current document (the init script only reaches documents created from now on)
    await page.evaluate(PAGE_WIRE).catch(() => {});
  }
}

// -------------------------------------------------------- force-browser recorder ----
// The companion accommodation to the waits: a `page.route()` mock hooks the browser's
// own fetch/XHR, so a request that leaves as a ws frame is invisible to it and the mock
// never fires. The ported build's I/O bottom exposes a seam for exactly this — a page
// global listing URL patterns that must stay on the browser's fetch (adapt-auto reads
// `window.__tierlessForceBrowser`; empty in production, so a no-op there). This
// recorder wraps route() so every pattern a test intercepts registers there
// automatically: the mocked request stays browser-side, the intercept fires, the
// assertion is unchanged. Only the TRANSPORT of intercepted requests is affected. On
// the stock arm the global is inert (those requests are already HTTP).
type RouteMatcher = string | RegExp | ((url: unknown) => boolean);
type ForceDescriptor = { glob: string } | { re: [string, string] };
interface RoutablePage {
  route(url: RouteMatcher, handler: unknown, options?: unknown): Promise<void>;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  addInitScript(script: unknown, arg?: unknown): Promise<void>;
}
interface RoutableContext {
  route(url: RouteMatcher, handler: unknown, options?: unknown): Promise<void>;
  pages(): RoutablePage[];
  on(event: "page", cb: (page: RoutablePage) => void): unknown;
}

// a function matcher can't be serialized into the page (and is the rare case). Skipped:
// worst case that one request rides the socket and its mock misses — the run surfaces it.
const describeMatcher = (url: RouteMatcher): ForceDescriptor | null =>
  typeof url === "string" ? { glob: url } : url instanceof RegExp ? { re: [url.source, url.flags] } : null;

const PUSH_FORCE = (g: unknown): void => {
  const w = window as unknown as { __tierlessForceBrowser?: unknown[] };
  (w.__tierlessForceBrowser ??= []).push(g);
};

const seedForce = (page: RoutablePage, d: ForceDescriptor): void => {
  // current document (route() may be called after the page loaded)…
  void page.evaluate(PUSH_FORCE, d).catch(() => {});
  // …and every future document (navigations reset window; init scripts re-run per doc)
  void page.addInitScript(PUSH_FORCE, d).catch(() => {});
};

const ROUTE_WRAPPED = new WeakSet<object>();

/** Wrap a BrowserContext's route() — and every page's, current and future — so each
 *  intercepted URL pattern registers as force-browser on the ported build's seam
 *  (`window.__tierlessForceBrowser`, read by adapt-auto). Mocked requests then stay on
 *  the browser's fetch where the intercept can fire. Idempotent per target. */
export function recordForceBrowserRoutes(context: RoutableContext): void {
  if (ROUTE_WRAPPED.has(context)) return;
  ROUTE_WRAPPED.add(context);

  // context.route() applies to every page including future ones: remember its patterns
  // and seed them onto each page as it appears
  const contextDescriptors: ForceDescriptor[] = [];
  const ctxRoute = context.route.bind(context);
  context.route = async (url, handler, options?) => {
    const d = describeMatcher(url);
    if (d) { contextDescriptors.push(d); for (const p of context.pages()) seedForce(p, d); }
    return ctxRoute(url, handler, options);
  };

  const wrapPage = (page: RoutablePage): void => {
    if (ROUTE_WRAPPED.has(page)) return;
    ROUTE_WRAPPED.add(page);
    for (const d of contextDescriptors) seedForce(page, d);
    const pageRoute = page.route.bind(page);
    page.route = async (url, handler, options?) => {
      const d = describeMatcher(url);
      if (d) seedForce(page, d);
      return pageRoute(url, handler, options);
    };
  };
  for (const p of context.pages()) wrapPage(p);
  context.on("page", wrapPage);
}

// ----------------------------------------------------- zero-touch suite delivery ----
// The two accommodations above still needed one hook line in the target suite. This
// section removes even that: Playwright loads the test CONFIG inside the runner AND
// every worker process, so a config wrapper (passed via `--config`, generated by the
// suite driver — never a patch) can patch the suite's own playwright-core Page class
// once per process. Every page in every worker is covered lazily: the first
// waitForResponse/waitForRequest call on a page wires it (binding + init script) and
// races from there — identical semantics to installTransportWaits, since a wait only
// ever matches crossings after its own arming cursor. The target tree stays PRISTINE.

export interface SuitePlaywright {
  Page: { prototype: Record<string, unknown> };
  BrowserContext: { prototype: Record<string, unknown> };
}

/** Dig the suite's own playwright-core client classes out of its dependency tree
 *  (absolute-path require — the internals aren't in the exports map). `fromDir` is the
 *  suite directory whose resolution should be used, so the patched Page class is the
 *  SAME class the suite's fixtures hand to tests. */
export function resolveSuitePlaywright(fromDir: string): SuitePlaywright {
  const req = createRequire(path.join(fromDir, "__tierless_resolve__.js"));
  let corePkg: string;
  try { corePkg = req.resolve("playwright-core/package.json"); }
  catch { corePkg = createRequire(req.resolve("@playwright/test/package.json")).resolve("playwright-core/package.json"); }
  const core = path.dirname(corePkg);
  const { Page } = req(path.join(core, "lib/client/page.js")) as { Page: SuitePlaywright["Page"] };
  const { BrowserContext } = req(path.join(core, "lib/client/browserContext.js")) as { BrowserContext: SuitePlaywright["BrowserContext"] };
  return { Page, BrowserContext };
}

const PROTO_PATCHED = new WeakSet<object>();

/** Patch the suite's Page class so EVERY page's waits are transport-agnostic — the
 *  zero-touch form of installTransportWaits, applied from a generated config wrapper
 *  or the NODE_OPTIONS register. `initScript` (optional) is added to every context
 *  before its first page — the harness's channel for page-visible run parameters
 *  (e.g. seeding the tierlessWsUrl localStorage override on shaped runs) without
 *  touching the app or the suite. `recordRoutes` (default true) is the zero-touch form
 *  of recordForceBrowserRoutes: every route()'d pattern registers on the force-browser
 *  seam so upstream mocks keep firing on the ported build; on stock the global is
 *  inert. */
export function patchPlaywrightPages({ Page, BrowserContext }: SuitePlaywright, { warn = (msg: string) => console.warn(msg), initScript, recordRoutes = true }: { warn?: (msg: string) => void; initScript?: string; recordRoutes?: boolean } = {}): void {
  if (!PROTO_PATCHED.has(Page)) {
    PROTO_PATCHED.add(Page);
    for (const [method, kind] of [["waitForResponse", "response"], ["waitForRequest", "request"]] as [string, Kind][]) {
      const orig = Page.prototype[method] as (this: PageLike, u: unknown, o?: unknown) => Promise<unknown>;
      Page.prototype[method] = function (this: PageLike, urlOrPredicate: unknown, options?: unknown) {
        void wirePage(this, warn).catch(() => {});      // lazy per-page wiring; no-op once wired
        const st = stateFor(this, warn);
        return raced(orig.call(this, urlOrPredicate, options), firstCrossing(st, matcherFor(urlOrPredicate, kind, st), Date.now()));
      };
    }
    if (recordRoutes) {
      const origRoute = Page.prototype.route as (this: RoutablePage, u: RouteMatcher, h: unknown, o?: unknown) => Promise<void>;
      Page.prototype.route = function (this: RoutablePage, url: RouteMatcher, handler: unknown, options?: unknown) {
        const d = describeMatcher(url);
        if (d) seedForce(this, d);
        return origRoute.call(this, url, handler, options);
      };
    }
  }
  if (!PROTO_PATCHED.has(BrowserContext)) {
    PROTO_PATCHED.add(BrowserContext);
    if (initScript) {
      const seeded = new WeakSet<object>();
      const origNewPage = BrowserContext.prototype.newPage as (this: object) => Promise<unknown>;
      BrowserContext.prototype.newPage = async function (this: object) {
        if (!seeded.has(this)) {
          seeded.add(this);
          try { await (this as { addInitScript(s: string): Promise<void> }).addInitScript(initScript); } catch { /* context already closing */ }
        }
        return origNewPage.call(this);
      };
    }
    if (recordRoutes) {
      const origCtxRoute = BrowserContext.prototype.route as (this: RoutableContext & { addInitScript(s: unknown, a?: unknown): Promise<void> }, u: RouteMatcher, h: unknown, o?: unknown) => Promise<void>;
      BrowserContext.prototype.route = function (this: RoutableContext & { addInitScript(s: unknown, a?: unknown): Promise<void> }, url: RouteMatcher, handler: unknown, options?: unknown) {
        const d = describeMatcher(url);
        if (d) {
          // context routes cover every page including future ones: current documents by
          // evaluate, future documents by a context-level init script
          for (const p of this.pages()) void p.evaluate(PUSH_FORCE, d).catch(() => {});
          void this.addInitScript(PUSH_FORCE, d).catch(() => {});
        }
        return origCtxRoute.call(this, url, handler, options);
      };
    }
  }
}

/** Re-anchor a config object's relative paths to the directory of the config file it
 *  came from — what a `--config` wrapper OUTSIDE the suite tree needs, since Playwright
 *  resolves these against the wrapper's own location. Projects are anchored too. */
export function anchorPlaywrightConfig<T extends Record<string, unknown>>(config: T, dir: string): T {
  const FIELDS = ["testDir", "outputDir", "globalSetup", "globalTeardown", "snapshotDir"];
  const anchor = (o: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...o };
    for (const f of FIELDS) {
      const v = out[f];
      if (typeof v === "string" && !path.isAbsolute(v)) out[f] = path.resolve(dir, v);
    }
    return out;
  };
  const out = anchor(config);
  if (Array.isArray(out.projects)) out.projects = (out.projects as Record<string, unknown>[]).map(anchor);
  return out as T;
}

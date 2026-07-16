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
const BINDING = "__tierlessCrossingPush";
// Page-side wiring, per document (init script for future documents, evaluate for the
// current one): turn the exec log on and forward each push to the Node-side binding.
// The runtime does `__tierlessExecLog ||= []`, so wiring the array FIRST keeps ours; if
// the runtime got there first, we wrap the existing array's own push in place. Entries
// ride as JSON strings — they crossed the wire already, so they are JSON-safe by
// construction. On a stock build nothing ever pushes and this is inert.
const PAGE_WIRE = `(() => {
  const g = globalThis;
  g.__TIERLESS_EXEC_LOG__ = true;
  const log = (g.__tierlessExecLog = g.__tierlessExecLog || []);
  if (log.__tierlessPushWired) return;
  Object.defineProperty(log, "__tierlessPushWired", { value: true });
  const base = log.push.bind(log);
  log.push = function () {
    for (let i = 0; i < arguments.length; i++) {
      try { const p = g.${BINDING}(JSON.stringify(arguments[i])); if (p && typeof p.catch === "function") p.catch(() => {}); } catch (e) { /* binding gone mid-navigation */ }
    }
    return base.apply(null, arguments);
  };
})()`;
const STATES = new WeakMap();
const PATCHED = new WeakSet();
const BOUND = new WeakSet();
function stateFor(page, warn) {
    let st = STATES.get(page);
    if (st)
        return st;
    let open;
    const warned = new Set();
    st = {
        seq: 0,
        entries: [],
        gate: new Promise((r) => (open = r)),
        bump: () => { const o = open; st.gate = new Promise((r) => (open = r)); o(); },
        push: (e, frameUrl) => {
            // absolute URL: the log records the crossing's own arg (usually an origin-relative
            // path); upstream matchers see full URLs, so resolve against the logging document
            let url = String(e.url ?? "");
            try {
                url = new URL(url, frameUrl || undefined).href;
            }
            catch { /* keep raw */ }
            st.entries.push({ seq: ++st.seq, url, e });
            if (st.entries.length > 2000)
                st.entries.splice(0, st.entries.length - 2000);
            st.bump();
        },
        warnOnce: (key, msg) => { if (!warned.has(key)) {
            warned.add(key);
            warn("[tierless/playwright] " + msg);
        } },
    };
    STATES.set(page, st);
    return st;
}
// ---------------------------------------------------------------------- facades ----
// Only what a crossing truthfully carries. Everything else throws a descriptive error —
// caught by the matcher (no-match + one warning), loud if reached from a resolved value.
const unsupported = (member) => new Error("tierless crossing facade: " + member + " is not carried by a session crossing — match on url/method/status/headers/bodies instead");
const methodOf = (e) => (String(e.name || "").split(".").pop() || "").toUpperCase();
const lower = (h) => { const out = {}; for (const [k, v] of Object.entries(h || {}))
    out[k.toLowerCase()] = v; return out; };
const textOf = (e) => (typeof e.body === "string" ? e.body : e.body === undefined ? "" : JSON.stringify(e.body));
const reqTextOf = (e) => (e.reqBody === undefined ? null : typeof e.reqBody === "string" ? e.reqBody : JSON.stringify(e.reqBody));
function requestFacade(c) {
    const e = c.e, headers = lower(e.reqHeaders);
    return {
        __tierlessCrossing: true,
        url: () => c.url,
        method: () => methodOf(e),
        headers: () => ({ ...headers }),
        allHeaders: async () => ({ ...headers }),
        headersArray: async () => Object.entries(headers).map(([name, value]) => ({ name, value })),
        headerValue: async (name) => headers[String(name).toLowerCase()] ?? null,
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
function responseFacade(c) {
    const e = c.e, headers = lower(e.headers);
    return {
        __tierlessCrossing: true,
        url: () => c.url,
        status: () => e.status ?? 0,
        ok: () => (e.status ?? 0) >= 200 && (e.status ?? 0) <= 299,
        statusText: () => "", // Playwright itself returns "" for HTTP/2
        headers: () => ({ ...headers }),
        allHeaders: async () => ({ ...headers }),
        headersArray: async () => Object.entries(headers).map(([name, value]) => ({ name, value })),
        headerValue: async (name) => headers[String(name).toLowerCase()] ?? null,
        headerValues: async (name) => { const v = headers[String(name).toLowerCase()]; return v === undefined ? [] : [v]; },
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
function globMatches(pattern, url) {
    let resolved = pattern;
    if (!pattern.startsWith("*")) {
        try {
            resolved = new URL(pattern, url).href;
        }
        catch { /* keep raw */ }
    }
    return new RegExp(globToRegexPattern(resolved)).test(url);
}
function matcherFor(arg, kind, st) {
    const make = (c) => (kind === "response" ? responseFacade(c) : requestFacade(c));
    // a RESPONSE wait needs a settled REST envelope (a status); request waits take any
    // logged crossing — note a crossing is recorded when it SETTLES, so a request-side
    // wait observes the send later than stock would (the send provably happened)
    const gate = (c) => kind === "request" || c.e.status !== undefined;
    if (typeof arg === "function") {
        return async (c) => {
            if (!gate(c))
                return null;
            const facade = make(c);
            try {
                return (await arg(facade)) ? facade : null;
            }
            catch (err) {
                st.warnOnce(kind + ":" + String(err), "a waitFor" + (kind === "response" ? "Response" : "Request") + " predicate threw against a tierless crossing facade (" + String(err) + "); this wait can now only be satisfied by real HTTP");
                return null;
            }
        };
    }
    if (arg instanceof RegExp)
        return async (c) => (gate(c) && arg.test(c.url) ? make(c) : null);
    if (typeof arg === "string")
        return async (c) => (gate(c) && globMatches(arg, c.url) ? make(c) : null);
    return async () => null;
}
const STOPPED = Symbol("tierless-crossing-wait-stopped");
// Resolve with the first crossing after `cursor` the matcher accepts; reject STOPPED
// when the HTTP side settled first. Entries arriving mid-scan are picked up by seq.
function firstCrossing(st, accept) {
    let stopped = false;
    const cursor = st.seq;
    const promise = (async () => {
        let last = cursor;
        while (!stopped) {
            const gate = st.gate; // capture BEFORE scanning: a push during the scan re-arms it
            const next = st.entries.find((c) => c.seq > last);
            if (next) {
                last = next.seq;
                const facade = await accept(next);
                if (facade != null)
                    return facade;
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
function raced(http, crossing) {
    return new Promise((resolve, reject) => {
        let done = false;
        http.then((v) => { if (!done) {
            done = true;
            crossing.stop();
            resolve(v);
        } }, (e) => { if (!done) {
            done = true;
            crossing.stop();
            reject(e);
        } });
        crossing.promise.then((v) => { if (!done) {
            done = true;
            resolve(v);
        } }, () => { });
    });
}
function patchPage(page, warn) {
    if (PATCHED.has(page))
        return;
    PATCHED.add(page);
    const st = stateFor(page, warn);
    for (const [method, kind] of [["waitForResponse", "response"], ["waitForRequest", "request"]]) {
        const orig = page[method].bind(page);
        page[method] = (urlOrPredicate, options) => raced(orig(urlOrPredicate, options), firstCrossing(st, matcherFor(urlOrPredicate, kind, st)));
    }
}
async function bindTarget(target, warn) {
    if (BOUND.has(target))
        return;
    BOUND.add(target);
    try {
        await target.exposeBinding(BINDING, (source, json) => {
            const page = source && source.page;
            if (!page)
                return;
            let e;
            try {
                e = JSON.parse(String(json));
            }
            catch {
                return;
            }
            const frameUrl = source.frame && typeof source.frame.url === "function" ? source.frame.url() : "";
            stateFor(page, warn).push(e, frameUrl);
        });
    }
    catch (err) {
        // page-level install after a context-level one (or vice versa): the binding is
        // already reachable from the page — anything else is a real error
        if (!/already registered|has been already registered/i.test(String(err)))
            throw err;
    }
    await target.addInitScript(PAGE_WIRE);
}
/** Patch `waitForResponse`/`waitForRequest` on a Page — or on a BrowserContext and every
 *  page it ever creates (popups included) — to also accept tierless session crossings.
 *  Idempotent. Call it once from the suite's fixture/setup; upstream spec files need no
 *  edits. `warn` (default console.warn) receives the once-per-cause notes when a
 *  caller's predicate reads something a crossing can't carry. */
export async function installTransportWaits(target, { warn = (msg) => console.warn(msg) } = {}) {
    await bindTarget(target, warn);
    if (typeof target.pages === "function") {
        const ctx = target;
        for (const p of ctx.pages()) {
            patchPage(p, warn);
            void p.evaluate(PAGE_WIRE).catch(() => { });
        }
        ctx.on("page", (p) => patchPage(p, warn)); // its documents get the init script
    }
    else {
        const page = target;
        patchPage(page, warn);
        // current document (the init script only reaches documents created from now on)
        await page.evaluate(PAGE_WIRE).catch(() => { });
    }
}
// a function matcher can't be serialized into the page (and is the rare case). Skipped:
// worst case that one request rides the socket and its mock misses — the run surfaces it.
const describeMatcher = (url) => typeof url === "string" ? { glob: url } : url instanceof RegExp ? { re: [url.source, url.flags] } : null;
const PUSH_FORCE = (g) => {
    const w = window;
    (w.__tierlessForceBrowser ??= []).push(g);
};
const seedForce = (page, d) => {
    // current document (route() may be called after the page loaded)…
    void page.evaluate(PUSH_FORCE, d).catch(() => { });
    // …and every future document (navigations reset window; init scripts re-run per doc)
    void page.addInitScript(PUSH_FORCE, d).catch(() => { });
};
const ROUTE_WRAPPED = new WeakSet();
/** Wrap a BrowserContext's route() — and every page's, current and future — so each
 *  intercepted URL pattern registers as force-browser on the ported build's seam
 *  (`window.__tierlessForceBrowser`, read by adapt-auto). Mocked requests then stay on
 *  the browser's fetch where the intercept can fire. Idempotent per target. */
export function recordForceBrowserRoutes(context) {
    if (ROUTE_WRAPPED.has(context))
        return;
    ROUTE_WRAPPED.add(context);
    // context.route() applies to every page including future ones: remember its patterns
    // and seed them onto each page as it appears
    const contextDescriptors = [];
    const ctxRoute = context.route.bind(context);
    context.route = async (url, handler, options) => {
        const d = describeMatcher(url);
        if (d) {
            contextDescriptors.push(d);
            for (const p of context.pages())
                seedForce(p, d);
        }
        return ctxRoute(url, handler, options);
    };
    const wrapPage = (page) => {
        if (ROUTE_WRAPPED.has(page))
            return;
        ROUTE_WRAPPED.add(page);
        for (const d of contextDescriptors)
            seedForce(page, d);
        const pageRoute = page.route.bind(page);
        page.route = async (url, handler, options) => {
            const d = describeMatcher(url);
            if (d)
                seedForce(page, d);
            return pageRoute(url, handler, options);
        };
    };
    for (const p of context.pages())
        wrapPage(p);
    context.on("page", wrapPage);
}

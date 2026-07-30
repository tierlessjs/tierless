// One-call session wiring for a corpus port — the browser side of the port recipe,
// generalized out of the per-port session-socket patches (each port re-derived the ws
// URL, the shaped-run override, preconnect, the same-origin/external split, the
// force-browser seam, and the cookie-auth wrap by hand — ~60 lines per app of pure
// convention). With this, an I/O-bottom patch is the seam line plus:
//
//   const tierless = autoSession();                       // or { gatewayPort, forceBrowser, ... }
//   axiosInstance.defaults.adapter = axiosAdapter({ exec: tierless.execFor(baseURL), ... });
//
// Conventions (each overridable):
//   - ws URL: `ws(s)://<page-hostname>:<page-port + 100>/__tierless`, scheme following
//     the page (an https page blocks ws:// as mixed content); explicit `url` or
//     `gatewayPort` override; a `tierlessWsUrl` localStorage key overrides everything —
//     the measured-run hook that routes the socket through a shaping relay.
//   - same-origin requests cross the session socket; an external origin keeps a direct
//     browser fetch (stock behavior — external I/O is never a crossing).
//   - force-browser: a request matching `forceBrowser` globs — or the page-global
//     `window.__tierlessForceBrowser` a test harness populates (tierless/playwright's
//     recordForceBrowserRoutes) — stays on the browser's own fetch, visible to service
//     workers, extensions, and route interception. Empty in production: a no-op.
//   - cookie authority: auth "auto" (default) wraps the exec in cookieSessionAuth and
//     lets the GATEWAY's hello declaration decide — a sealing gateway delivers the blob
//     in the ws upgrade, a header-auth gateway declares sealed:false and the wrap
//     no-ops. Costs header-auth apps nothing (attachTierless always sends a hello).
import { configureTierless, sessionDown, sessionExec, sessionHello } from "./browser.mjs";
import { cookieSessionAuth } from "./adapt-session-auth.mjs";
import { conditionalCrossings } from "./adapt-cache.mjs";
import { restResources } from "./adapt.mjs";
import { axiosAdapter } from "./adapt-axios.mjs";
import { WS_PATH } from "./ws-path.mjs";
import { matchesForceBrowser } from "./url-glob.mjs";
export function autoSession({ url, gatewayPort, path = WS_PATH, storageKey = "tierlessWsUrl", forceBrowser = [], auth = "auto", cross, awaitClaims, preconnect = true, conditional = true } = {}) {
    if (typeof location === "undefined")
        throw new Error("autoSession: browser-only (SSR/twin bundles keep their host fetch — gate the call on typeof location)");
    const pagePort = Number(location.port || (location.protocol === "https:" ? 443 : 80));
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const derived = url || `${scheme}://${location.hostname}:${gatewayPort ?? pagePort + 100}${path}`;
    const override = storageKey === null ? null : (() => { try {
        return localStorage.getItem(storageKey);
    }
    catch {
        return null;
    } })();
    const wsUrl = override || derived;
    configureTierless({ url: wsUrl, preconnect });
    const staticList = forceBrowser.map((p) => (typeof p === "string" ? { glob: p } : { re: [p.source, p.flags] }));
    const pageList = () => window.__tierlessForceBrowser ?? [];
    // The gateway's hello may DECLARE oversize paths — GETs whose measured reply body
    // exceeds its browse threshold. Those go into the page's force-browser list: a few
    // huge responses gain nothing from the socket (per-request overhead is negligible at
    // that size) and cost real main-thread time as single frames (n8n hauled a 12.66 MB
    // node-types reply through the renderer mid-mount, +1.4-1.9 s/test), while stock HTTP
    // streams them off-thread, compressed, through the browser's own cache. ADVISORY:
    // merged whenever the hello lands; a request racing it crosses once at full price.
    // Gated so it never materializes a connection nothing else opens.
    if (auth !== "none" || preconnect) {
        void sessionHello().then((h) => {
            if (!h.forceBrowser?.length)
                return;
            const g = window;
            const list = (g.__tierlessForceBrowser ||= []);
            for (const p of h.forceBrowser) {
                const glob = "**" + p;
                if (!list.some((d) => "glob" in d && d.glob === glob))
                    list.push({ glob });
            }
        }).catch(() => { });
    }
    const noteDelegated = (req, path, why) => {
        const g = globalThis;
        const log = (g.__tierlessDelegated ||= []);
        log.push({ t: Date.now(), name: String(req.name), path, why });
        if (log.length > 500)
            log.splice(0, 250); // a long-lived page must not grow one
    };
    /** Whether this request is delegated to the browser's own fetch, recording the decision.
     *  `why` separates the port author's own globs from what the GATEWAY advised — they are
     *  different claims and a report must not blend them. */
    const forced = (req, origin) => {
        const fromPage = pageList();
        if (!staticList.length && !fromPage.length)
            return false;
        const path0 = String((req.args ?? [])[0] ?? "");
        let full;
        try {
            full = new URL(path0, origin + "/").href;
        }
        catch {
            full = origin + path0;
        }
        if (staticList.length && matchesForceBrowser(staticList, full)) {
            noteDelegated(req, path0, "glob");
            return true;
        }
        if (fromPage.length && matchesForceBrowser(fromPage, full)) {
            noteDelegated(req, path0, "advisory");
            return true;
        }
        return false;
    };
    const bare = auth === "none"
        ? sessionExec()
        : cookieSessionAuth({ gateway: new URL(wsUrl.replace(/^ws/, "http")).origin, hello: sessionHello(), ...(awaitClaims !== undefined ? { awaitClaims } : {}) }).wrap(sessionExec());
    // stock HTTP caching semantics on the socket (adapt-cache.mts): an ETag'd GET
    // revalidates instead of re-crossing in full — what the browser's own cache would
    // have done for these requests. conditional:false is the measurement ablation.
    const session = conditional ? conditionalCrossings().wrap(bare) : bare;
    // THE TRANSPORT IS AN OPTIMIZATION, SO ITS FAILURE MUST COST STOCK BEHAVIOR, NOT THE
    // APP. A build whose gateway is unreachable — CSP, firewall, gateway down — runs on the
    // browser's own fetch instead. Grafana measured what the alternative costs: their e2e
    // CSP blocked ws://:3101 and 94 of 101 tests sat until the suite timeout.
    //
    // WHAT MAY BE REISSUED IS NOT THE SAME IN BOTH FAILURES (browser.mts DownReason).
    // "never-opened": nothing was ever sent, so every request may go direct. "dropped": the
    // socket lived, so a request that was in flight may ALREADY have been applied upstream —
    // reissuing a POST would double-apply it, so only idempotent requests are retried and
    // everything else surfaces the error the app would have seen from a failed fetch.
    let warned = false;
    const degrade = (why) => {
        if (warned)
            return;
        warned = true;
        console.warn(`tierless: session socket unavailable (${why}) — falling back to the browser's own fetch (stock behavior)`);
    };
    const IDEMPOTENT = /^api\.(get|head|options)$/;
    const withFallback = (direct) => async (req) => {
        // ALREADY known dead: this request has not been sent anywhere, so any method may go
        // direct — it is indistinguishable from an app that was never ported.
        if (sessionDown()) {
            degrade(sessionDown());
            return direct(req);
        }
        try {
            return await session(req);
        }
        catch (err) {
            // It FAILED while we thought the socket was live, which is the ambiguous case: the
            // request may have reached the gateway and been applied before the reply was lost.
            // Reissuing a GET is free; reissuing a POST could double-apply it, so that error
            // surfaces exactly as a failed fetch would and the app decides.
            const why = sessionDown();
            if (why === "never-opened" || (why === "dropped" && IDEMPOTENT.test(req.name))) {
                degrade(why);
                return direct(req);
            }
            throw err; // healthy socket, or an unsafe replay: the app's own error
        }
    };
    const crosses = cross ?? ((origin) => origin === location.origin);
    const byOrigin = new Map();
    const execFor = (baseUrl = "/") => {
        const origin = new URL(baseUrl, location.href).origin;
        let e = byOrigin.get(origin);
        if (!e) {
            const direct = restResources(origin, { envelopeErrors: true });
            const crossed = withFallback(direct);
            e = crosses(origin) ? (req) => (forced(req, origin) ? direct(req) : crossed(req)) : direct;
            byOrigin.set(origin, e);
        }
        return e;
    };
    return { exec: execFor(), execFor, wsUrl };
}
let sharedAuto;
const INSTALLED = new WeakSet();
/** The whole transport port for an axios app, one call at the app's own API client:
 *
 *     import { tierlessAxios } from 'tierless/adapt-auto'
 *     tierlessAxios(axios, api.instance)
 *
 *  Installs the tierless I/O bottom (adapt-axios) fed by autoSession() — every request
 *  through this instance crosses the session socket (the INSTALLATION CONTRACT in
 *  adapt-axios.mts: the instance's baseURL IS the app's own API, wherever it is hosted;
 *  explicit other-origin URLs still fall through at the adapter). Browser-pinned
 *  configs fall through to the app's own stock adapter via `axios.getAdapter`. Under
 *  SSR/Node this is a no-op — the stock adapter stays. Idempotent per instance; the
 *  first call's opts configure the shared session (one socket per page). */
export function tierlessAxios(axios, instance, opts = {}) {
    if (typeof window === "undefined" || typeof location === "undefined")
        return;
    if (INSTALLED.has(instance))
        return;
    INSTALLED.add(instance);
    sharedAuto ??= autoSession({ ...opts, cross: () => true });
    instance.defaults.adapter = axiosAdapter({
        exec: sharedAuto.execFor(instance.defaults.baseURL || "/"),
        fallback: typeof XMLHttpRequest !== "undefined" && axios.getAdapter ? axios.getAdapter(["xhr", "http"]) : undefined,
        crossCredentialed: opts.crossCredentialed,
        crossTimeouts: opts.crossTimeouts,
    });
}

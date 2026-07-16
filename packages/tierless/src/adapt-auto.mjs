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
import { configureTierless, sessionExec, sessionHello } from "./browser.mjs";
import { cookieSessionAuth } from "./adapt-session-auth.mjs";
import { restResources } from "./adapt.mjs";
import { axiosAdapter } from "./adapt-axios.mjs";
import { WS_PATH } from "./ws-path.mjs";
import { matchesForceBrowser } from "./url-glob.mjs";
export function autoSession({ url, gatewayPort, path = WS_PATH, storageKey = "tierlessWsUrl", forceBrowser = [], auth = "auto", cross, awaitClaims, preconnect = true } = {}) {
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
    const forced = (req, origin) => {
        const list = [...staticList, ...pageList()];
        if (!list.length)
            return false;
        const path0 = String((req.args ?? [])[0] ?? "");
        let full;
        try {
            full = new URL(path0, origin + "/").href;
        }
        catch {
            full = origin + path0;
        }
        return matchesForceBrowser(list, full);
    };
    const session = auth === "none"
        ? sessionExec()
        : cookieSessionAuth({ gateway: new URL(wsUrl.replace(/^ws/, "http")).origin, hello: sessionHello(), ...(awaitClaims !== undefined ? { awaitClaims } : {}) }).wrap(sessionExec());
    const crosses = cross ?? ((origin) => origin === location.origin);
    const byOrigin = new Map();
    const execFor = (baseUrl = "/") => {
        const origin = new URL(baseUrl, location.href).origin;
        let e = byOrigin.get(origin);
        if (!e) {
            const direct = restResources(origin, { envelopeErrors: true });
            e = crosses(origin) ? (req) => (forced(req, origin) ? direct(req) : session(req)) : direct;
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
    });
}

// Tierless — the browser host, assembled. Two shapes:
//
//   connect({ url?, exec?, bundle? })     one socket to the app's session endpoint.
//     .register(module, bundle)           add a compiled mix-module to this connection
//     .call(entry, args, module?)         start entry(...) on the SERVER; bounces welcome
//     .ready / .close()
//
//   bindActions(bundle, { module, url? }) what compiled "use tierless" modules call: returns
//     { entryName: (...args) => Promise } for every PROGRAM, sharing ONE lazy connection
//     per page no matter how many mix-modules the app imports.
//
// Browser-safe and import-safe under SSR: nothing touches WebSocket/location until the
// first call. `exec` services browser-pinned resources (dom.commit in the full-tierless
// mode, ui.* if you pin some); actions that never touch one simply run out on the server.
import { makeHost, answerWith, batchExec, execOver } from "./host.mjs";
import { makeCoherence } from "./coherence.mjs";
import { methodMigrate, loadProfile } from "./trace.mjs";
import { makePeer, wsPort, onEvent } from "./transport.mjs";
import { WS_PATH } from "./ws-path.mjs";
import { httpResources, httpPins, crossHttpRequest } from "./adapt.mjs";
const defaultUrl = () => {
    if (typeof location === "undefined")
        throw new Error("tierless: no location — pass { url } (or call actions from the browser)");
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + WS_PATH;
};
// The app-wide §6 method rule + the profiling recorder options, set by connect() from
// ConnectOpts and consulted by every bindMethods stub. Mutable refs: a profile that
// arrives after the first interaction upgrades later calls; before it, cold = fetch.
let appMigrate = null;
let appTrace = null;
const appHashes = []; // per-module BUNDLE_HASHes of the merged world, sorted — the profile validity key
export const mergedAppHash = () => "merged:" + [...appHashes].sort().join("+");
// A fetched comparison profile stays PENDING until the merged world matches it: with
// preconnect, the fetch usually resolves before app modules bindMethods (their hashes
// aren't in the merged key yet), so validating once at fetch time would permanently
// reject a valid profile. Revalidated on every registration; calls before it settles
// run on the fetch arm, the same cold-start rule as a late-arriving profile.
let pendingProfile = null;
// the comparison-run READINESS BARRIER (docs/corpus.md run protocol): two comparison
// runs must make the same decisions, so the first compiled-method call cannot race the
// profile fetch — bindMethods stubs hold until this settles when a profileUrl is set
let profileFetched = null;
const tryActivateProfile = () => {
    if (!pendingProfile)
        return;
    const prof = loadProfile(pendingProfile, mergedAppHash());
    if (prof) {
        appMigrate = methodMigrate(prof);
        pendingProfile = null;
    }
};
export function connect({ url, exec, bundle, tier = "browser", heap = true, 
// run-protocol wiring can also come from page globals (a measured run's driver injects
// them into the built index.html, like their CI's window.TESTING) — build-time shims
// can't know a preview-time mode
traceUrl = globalThis.__TIERLESS_TRACE__, profileUrl = globalThis.__TIERLESS_PROFILE__, } = {}) {
    const ws = new WebSocket((typeof url === "function" ? url() : url) || defaultUrl());
    // burst coalescing (host.mts batchExec): concurrent execs merge into one crossing.
    // DEFAULT OFF — measured neutral on time and bytes for the first corpus app (frame
    // count only, ports/vikunja); opt in via the page global (same pattern as the
    // run-protocol globals) where per-frame costs matter. Review once more ports exist.
    const raw = makePeer(wsPort(ws));
    const peer = globalThis.__TIERLESS_EXEC_BATCH__ ? batchExec(raw) : raw;
    const ready = new Promise((res, rej) => {
        onEvent(ws, "open", () => res());
        onEvent(ws, "error", (e) => rej(new Error("tierless: websocket error" + (e && e.message ? ": " + e.message : ""))));
    });
    if (traceUrl) { // PROFILING run: batch records to the gateway
        // a lost batch must not go silent: an incomplete run that still delivers its `end`
        // record would teach buildProfile a FALSE trajectory. Failed batches requeue at the
        // front and retry on the next tick, bounded; past the bound the run's remaining
        // records are dropped WITH their end marker, so the run reads incomplete, not wrong.
        const buf = [];
        let poisoned = false;
        let sending = Promise.resolve(); // SERIALIZED: a later batch must not land while an earlier one is failing — an out-of-order `end` would mark an incomplete run complete
        const flush = () => {
            if (!buf.length || poisoned)
                return;
            const batch = buf.splice(0, buf.length);
            const body = batch.map((r) => JSON.stringify(r)).join("\n") + "\n";
            sending = sending.then(() => fetch(traceUrl, { method: "POST", body, keepalive: true }).then((r) => {
                if (!r.ok)
                    throw new Error(String(r.status));
            })).catch(() => {
                if (buf.length + batch.length > 5000) {
                    poisoned = true;
                    buf.length = 0;
                    console.warn("tierless: trace delivery failing — dropping this page's remaining records (runs read incomplete, not wrong)");
                }
                else
                    buf.unshift(...batch);
            });
        };
        setInterval(flush, 1000);
        if (typeof addEventListener === "function")
            addEventListener("pagehide", flush);
        appTrace = { rate: 1, sink: (r) => { if (!poisoned) {
                buf.push(r);
                if (buf.length >= 100)
                    flush();
            } } };
    }
    if (profileUrl) { // COMPARISON run: locked profile, no exploration
        profileFetched = fetch(profileUrl).then((r) => (r.ok ? r.json() : null)).then((p) => {
            if (!p)
                return;
            pendingProfile = p;
            tryActivateProfile();
            if (pendingProfile)
                console.warn("tierless: profile pending — built for " + pendingProfile.bundle + ", app is currently " + mergedAppHash() + " (revalidates as modules register)");
        }).catch(() => { });
    }
    // §5 heap coherence for this connection, shared by every module-host on it (each host
    // applies it only if its own bundle is heap-compiled). serve() lets the server fetch
    // browser-owned handles back, receive write-backs, and release finished continuations.
    const coherence = heap ? makeCoherence(tier) : undefined;
    if (coherence)
        coherence.serve(peer);
    const hosts = new Map(); // moduleId -> host
    const register = (module, b) => {
        const id = module || "";
        if (!hosts.has(id))
            hosts.set(id, makeHost({ bundle: b, tier, exec: exec, meta: id ? { module: id } : {}, coherence, ...(appTrace ? { trace: appTrace } : {}) })); // exec is optional here (actions-only pages never own a resource); makeHost only calls it when one is
        return hosts.get(id);
    };
    if (bundle)
        register("", bundle);
    answerWith(peer, (id) => {
        const h = hosts.get(id || "");
        if (!h)
            throw new Error("tierless: no bundle registered for module " + JSON.stringify(id));
        return h;
    });
    return {
        ready,
        register,
        call: async (entry, args = [], module = "") => {
            await ready;
            const h = hosts.get(module || "");
            if (!h)
                throw new Error("tierless: no bundle registered" + (module ? " for " + module : ""));
            return h.call(peer, entry, args);
        },
        runLocal: async (entry, args = [], module = "", opts) => {
            await ready;
            const h = hosts.get(module || "");
            if (!h)
                throw new Error("tierless: no bundle registered" + (module ? " for " + module : ""));
            return h.runLocal(peer, entry, args, opts);
        },
        exec: async (req) => {
            await ready;
            // observability hook (opt-in via page global): a bounded log of completed
            // crossings, so TEST harnesses whose waits watch the HTTP transport (playwright
            // waitForResponse) can watch the session transport instead — the run-protocol
            // accommodation surface. Zero cost unless the page set the flag.
            // t (wall clock) rather than an index cursor: navigations reset the page world
            // and restart the log, but time stays comparable — a harness wait armed before
            // a goto() still recognizes the new document's crossings.
            const g = globalThis;
            const record = (status, body, hasBody) => {
                if (!g.__TIERLESS_EXEC_LOG__)
                    return;
                const log = (g.__tierlessExecLog ||= []);
                log.push({ t: Date.now(), name: req.name, url: String(req.args?.[0] ?? ""), status, ...(hasBody ? { body } : {}) });
                if (log.length > 500)
                    log.splice(0, log.length - 500);
            };
            let value;
            try {
                value = await execOver(peer, req);
            }
            catch (err) {
                // a REJECTED crossing is still a crossing a harness wait may be matching on
                // (shaped 4xx/5xx errors carry .response) — log it before rethrowing
                const r = err?.response;
                record(r && typeof r.status === "number" ? r.status : undefined, r?.data, !!r && "data" in r);
                throw err;
            }
            const env = value;
            record(env && typeof env.status === "number" ? env.status : undefined, env?.body, !!env && "body" in env);
            return value;
        },
        close: () => ws.close(),
    };
}
/** The shared connection's exec crossing as a tierless Exec — what an I/O-bottom
 *  adapter plugs in to route the app's requests over the session socket:
 *  `axiosAdapter({ exec: sessionExec(), ... })`. Lazy: the socket opens on first use
 *  (or at configureTierless({ preconnect }) time), each call awaits readiness. */
export function sessionExec() {
    return (req) => sharedConn().exec(req);
}
// ---- the actions surface (what the Vite plugin emits calls into) ----------------------
let sharedOpts = {};
let shared = null;
// Optional page-level configuration (url, exec for browser-pinned resources). Call before
// the first action fires; the first bindActions() call materializes the connection.
// preconnect opens the socket NOW, during app bootstrap, instead of lazily inside the
// first action — on a fresh page the TCP+upgrade handshake (~2 RTT) otherwise lands on
// the first navigation's critical path and cancels most of what the migration saves.
export function configureTierless(opts) {
    sharedOpts = opts || {};
    shared = null;
    if (opts?.preconnect)
        sharedConn();
}
const sharedConn = () => (shared || (shared = connect(sharedOpts)));
export function bindActions(bundle, { module = "" } = {}) {
    const out = {};
    for (const name of Object.keys(bundle.PROGRAMS)) {
        out[name] = (...args) => {
            const conn = sharedConn();
            conn.register(module, bundle);
            return conn.call(name, args, module);
        };
    }
    return out;
}
// ONE merged machine world per page (docs/migrate-arm.md slice 3): every bindMethods
// module contributes its programs and slot tables, so a dynamic call park in one
// module's machine (a store) can push another module's (a service) — locally or on the
// far side of a migration. The maps mutate IN PLACE: hosts capture the objects, so a
// module bound later is visible to sessions already running.
const APP_MERGED = { PROGRAMS: {}, __unwind: () => false, __slots: {} };
let appUnwindSet = false;
/** Route a compiled module's class-method stubs (real app code — service layers) through
 *  the shared connection. Methods run on the FETCH path: the frame — whose arg 0 is the
 *  live instance, often a framework proxy — stays in the browser and mutates the real
 *  object; only resource requests and results cross. Call once per compiled module. */
export function bindMethods(bundle, { module = "", migrate } = {}) {
    if (typeof bundle.__bindTierlessMethods !== "function")
        throw new Error("tierless: bundle has no compiled class methods (rebuild with a compiler that emits __bindTierlessMethods)");
    for (const [k, v] of Object.entries(bundle.PROGRAMS)) {
        // a collision is guaranteed wrongness, not a warning: programs are named Class$method,
        // so a second module defining the same pair would silently execute the first module's
        // machine for half its calls. Fail at bind time, where the stack names both modules.
        if (APP_MERGED.PROGRAMS[k] && APP_MERGED.PROGRAMS[k] !== v)
            throw new Error("tierless: program name collision across compiled modules: " + k + " — rename one class or method (compiled program ids are Class$method, app-wide)");
        APP_MERGED.PROGRAMS[k] = v;
    }
    if (bundle.__slots)
        Object.assign(APP_MERGED.__slots, bundle.__slots);
    if (!appUnwindSet) {
        APP_MERGED.__unwind = bundle.__unwind;
        appUnwindSet = true;
    } // driver-identical across compiled modules
    if (typeof bundle.BUNDLE_HASH === "string") {
        appHashes.push(bundle.BUNDLE_HASH);
        tryActivateProfile();
    } // the merged world's profile-validity key grew — a pending profile may match now
    bundle.__bindTierlessMethods(async (prog, self, args) => {
        if (profileFetched)
            await profileFetched; // comparison-run barrier: no call decides before the profile settled
        const conn = sharedConn();
        conn.register(module, APP_MERGED);
        // pinned requests (declared: blob/stream responses; owned values: callbacks,
        // FormData) run on the instance's OWN http — the same object the uncompiled method
        // would have used — so uploads and downloads behave stock. Crossing requests are
        // prepared by crossHttpRequest: the instance's request-interceptor chain (app code —
        // auth headers, model→DTO transforms, casing) runs HERE, and the post-chain wire
        // config crosses — exactly what axios would hand its adapter. An async chain
        // returns null and the request pins to the instance instead.
        // the instance owning a park is the PARKED frame's arg 0 (nested machines: a store
        // method's park belongs to the service instance it called, not to the store) — fall
        // back to the run's own receiver for the common single-frame case
        const httpOf = (frame) => (frame?.args?.[0]?.http) ?? self?.http;
        return conn.runLocal(prog, [self, ...args], module, {
            pins: httpPins,
            map: (req, frame) => crossHttpRequest(httpOf(frame), req),
            exec: (req, frame) => {
                const own = httpOf(frame);
                if (!own)
                    throw new Error("tierless: no instance http to serve a pinned request");
                return httpResources(own)(req);
            },
            // §6 at the park: an explicit opt wins; otherwise the app-wide profile rule
            // (loaded by connect({ profileUrl }) on comparison runs; null = cold = fetch arm)
            migrate: migrate ?? ((req, site) => appMigrate?.(req, site) ?? false),
        });
    });
}

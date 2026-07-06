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
import { makeHost, answerWith } from "./host.mjs";
import { makePeer, wsPort, onEvent } from "./transport.mjs";
import { WS_PATH } from "./ws-path.mjs";
import { httpResources, httpPins } from "./adapt.mjs";
const defaultUrl = () => {
    if (typeof location === "undefined")
        throw new Error("tierless: no location — pass { url } (or call actions from the browser)");
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + WS_PATH;
};
export function connect({ url, exec, bundle, tier = "browser" } = {}) {
    const ws = new WebSocket((typeof url === "function" ? url() : url) || defaultUrl());
    const peer = makePeer(wsPort(ws));
    const ready = new Promise((res, rej) => {
        onEvent(ws, "open", () => res());
        onEvent(ws, "error", (e) => rej(new Error("tierless: websocket error" + (e && e.message ? ": " + e.message : ""))));
    });
    const hosts = new Map(); // moduleId -> host
    const register = (module, b) => {
        const id = module || "";
        if (!hosts.has(id))
            hosts.set(id, makeHost({ bundle: b, tier, exec: exec, meta: id ? { module: id } : {} })); // exec is optional here (actions-only pages never own a resource); makeHost only calls it when one is
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
        close: () => ws.close(),
    };
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
/** Route a compiled module's class-method stubs (real app code — service layers) through
 *  the shared connection. Methods run on the FETCH path: the frame — whose arg 0 is the
 *  live instance, often a framework proxy — stays in the browser and mutates the real
 *  object; only resource requests and results cross. Call once per compiled module. */
export function bindMethods(bundle, { module = "" } = {}) {
    if (typeof bundle.__bindTierlessMethods !== "function")
        throw new Error("tierless: bundle has no compiled class methods (rebuild with a compiler that emits __bindTierlessMethods)");
    bundle.__bindTierlessMethods(async (prog, self, args) => {
        const conn = sharedConn();
        conn.register(module, bundle);
        // pinned requests (declared: blob/stream responses; owned values: callbacks,
        // FormData) run on the instance's OWN http — the same object the uncompiled method
        // would have used — so uploads and downloads behave stock while plain-data requests
        // ride the session
        const own = self?.http;
        return conn.runLocal(prog, [self, ...args], module, own ? { exec: httpResources(own), pins: httpPins } : { pins: httpPins });
    });
}

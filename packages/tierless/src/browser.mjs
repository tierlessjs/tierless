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
import { makeCoherence, usesHeap } from "./coherence.mjs";
import { makePeer, wsPort, onEvent } from "./transport.mjs";
import { WS_PATH } from "./ws-path.mjs";
const defaultUrl = () => {
    if (typeof location === "undefined")
        throw new Error("tierless: no location — pass { url } (or call actions from the browser)");
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + WS_PATH;
};
export function connect({ url, exec, bundle, tier = "browser", heap } = {}) {
    const ws = new WebSocket(url || defaultUrl());
    const peer = makePeer(wsPort(ws));
    const ready = new Promise((res, rej) => {
        onEvent(ws, "open", () => res());
        onEvent(ws, "error", (e) => rej(new Error("tierless: websocket error" + (e && e.message ? ": " + e.message : ""))));
    });
    // §5 heap coherence for this connection, created once the first heap-using bundle is
    // known (or if opted in). serve() lets the server fetch browser-owned handles back.
    let coherence;
    const enableCoherence = (b) => {
        if (coherence)
            return;
        if (heap ?? (b ? usesHeap(b) : false)) {
            coherence = makeCoherence(tier);
            coherence.serve(peer);
        }
    };
    enableCoherence(bundle);
    const hosts = new Map(); // moduleId -> host
    const register = (module, b) => {
        const id = module || "";
        if (!hosts.has(id)) {
            enableCoherence(b);
            hosts.set(id, makeHost({ bundle: b, tier, exec: exec, meta: id ? { module: id } : {}, coherence }));
        } // exec is optional here (actions-only pages never own a resource); makeHost only calls it when one is
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
        close: () => ws.close(),
    };
}
// ---- the actions surface (what the Vite plugin emits calls into) ----------------------
let sharedOpts = {};
let shared = null;
// Optional page-level configuration (url, exec for browser-pinned resources). Call before
// the first action fires; the first bindActions() call materializes the connection.
export function configureTierless(opts) { sharedOpts = opts || {}; shared = null; }
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

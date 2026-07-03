// Tierless — the Node host, assembled. Two calls cover the deployment shapes:
//
//   attachTierless(httpServer, opts)   mount the session endpoint on an EXISTING http
//                                      server (Express/Fastify/vite-dev — anything that
//                                      emits 'upgrade'); returns { close }.
//   serveApp(opts)                     a complete app server: static files + a page +
//                                      the session endpoint; returns { server, port, close }.
//
// Per-connection, `session(req)` decides what this socket may do — typically: log in,
// hold the session token, and return the monitor-backed exec (makeApiExec) plus an
// optional `entry` to start a session server-side immediately (the full-tierless mode).
// Actions-mode sockets return just { exec }; the browser then start()s entries itself.
//
// `bundle` is the compiled module for this app, or an async resolver
// `(moduleId) => bundle` when several mix-modules share the endpoint (the Vite plugin).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { makeHost, answerWith } from "./host.mjs";
import { makePeer, wsPort } from "./transport.mjs";
import { WS_PATH } from "./ws-path.mjs";
const { WebSocketServer } = createRequire(import.meta.url)("ws");
export { WS_PATH };
// Mount the session endpoint on an EXISTING http server (Express/Fastify/Vite — anything
// that emits 'upgrade'); co-mountable with other websocket handlers.
export function attachTierless(httpServer, { bundle, tier = "server", session, path: wsPath = WS_PATH }) {
    const wss = new WebSocketServer({ noServer: true });
    const resolveBundle = typeof bundle === "function" ? bundle : () => bundle;
    const onUpgrade = (req, socket, head) => {
        let pathname = "";
        try {
            pathname = new URL(req.url, "http://localhost").pathname;
        }
        catch { /* not ours */ }
        if (pathname !== wsPath) {
            // not our endpoint: leave it for a co-mounted handler (e.g. Vite's HMR socket); if
            // we are the only upgrade listener, nobody else will — close it instead of hanging.
            if (httpServer.listeners("upgrade").length === 1)
                socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    };
    httpServer.on("upgrade", onUpgrade);
    wss.on("connection", async (ws, req) => {
        ws.on("error", () => { }); // a client socket error (reset, etc.) must not throw out of the emitter and crash the host
        try {
            const { exec, entry, args = [], onDone } = await session(req);
            const peer = makePeer(wsPort(ws));
            const hosts = new Map(); // moduleId -> host (stateless; cached per socket)
            const hostFor = async (id) => {
                if (!hosts.has(id))
                    hosts.set(id, makeHost({ bundle: await resolveBundle(id), tier, exec, meta: id ? { module: id } : {} }));
                return hosts.get(id);
            };
            answerWith(peer, hostFor); // browser-started sessions (actions) + bounces
            if (entry) { // full-tierless mode: the server starts the session
                const value = await (await hostFor("")).run(peer, entry, args);
                if (onDone)
                    onDone(value);
            }
        }
        catch (e) {
            try {
                ws.close(1011, String((e && e.message) || e).slice(0, 100));
            }
            catch { /* already gone */ }
        }
    });
    return { close: () => { httpServer.off("upgrade", onUpgrade); wss.close(); } };
}
// ---------------------------------------------------------------- serveApp ------------
const MIME = {
    ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".map": "application/json; charset=utf-8",
};
// A complete app server: static files + a page + the session endpoint.
export async function serveApp({ port = 0, page, staticRoot, ...attachOpts }) {
    const root = staticRoot ? path.resolve(staticRoot) + path.sep : null;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (page && (url.pathname === "/" || url.pathname === "/index.html")) {
            res.writeHead(200, { "Content-Type": MIME[".html"] });
            return res.end(page);
        }
        if (!root) {
            res.writeHead(404);
            return res.end("not found");
        }
        const abs = path.join(root, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
        if (!abs.startsWith(root)) {
            res.writeHead(403);
            return res.end("forbidden");
        } // no traversal outside the root
        fs.readFile(abs, (err, data) => {
            if (err) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                return res.end("not found: " + url.pathname);
            }
            res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] || "application/octet-stream" });
            res.end(data);
        });
    });
    const attached = attachTierless(server, attachOpts);
    await new Promise((r) => server.listen(port, r));
    return {
        server,
        port: server.address().port,
        close: () => { attached.close(); server.close(); },
    };
}

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
import { makeCoherence } from "./coherence.mjs";
import { makePeer, wsPort } from "./transport.mjs";
import { WS_PATH } from "./ws-path.mjs";
import type { Bundle, Exec, ResourceRequest } from "./types.mjs";
import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const { WebSocketServer } = createRequire(import.meta.url)("ws");

export { WS_PATH };

export interface SessionSetup {
  exec: Exec;
  /** Set to start a session server-side on connection (the full-tierless mode). */
  entry?: string;
  args?: unknown[];
  onDone?: (value: unknown) => void;
}
export interface AttachOptions {
  /** The compiled bundle, or an async resolver by module id (multi-module endpoints). */
  bundle: Bundle | ((moduleId: string) => Bundle | Promise<Bundle>);
  tier?: string;
  path?: string;
  /** Per-connection: log in, hold the token, return the monitor-backed exec. */
  session: (req: IncomingMessage) => SessionSetup | Promise<SessionSetup>;
  /** §5 heap coherence (excision, deref and CAS write-back over the socket, bounded cache,
   *  per-continuation release). On by default; it takes effect per module — only bundles
   *  compiled with --auto-deref/--auto-writeback excise and service §5 ops, so ordinary
   *  bundles (including a resolver's) are unaffected. false disables it entirely. */
  heap?: boolean;
}

// Mount the session endpoint on an EXISTING http server (Express/Fastify/Vite — anything
// that emits 'upgrade'); co-mountable with other websocket handlers.
export function attachTierless(httpServer: HttpServer, { bundle, tier = "server", session, path: wsPath = WS_PATH, heap = true }: AttachOptions): { close(): void } {
  const wss = new WebSocketServer({ noServer: true });
  const resolveBundle = typeof bundle === "function" ? bundle : () => bundle;

  const onUpgrade = (req: IncomingMessage, socket: any, head: any): void => {
    let pathname = "";
    try { pathname = new URL(req.url!, "http://localhost").pathname; } catch { /* not ours */ }
    if (pathname !== wsPath) {
      // not our endpoint: leave it for a co-mounted handler (e.g. Vite's HMR socket); if
      // we are the only upgrade listener, nobody else will — close it instead of hanging.
      if (httpServer.listeners("upgrade").length === 1) socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: any) => wss.emit("connection", ws, req));
  };
  httpServer.on("upgrade", onUpgrade);

  wss.on("connection", async (ws: any, req: IncomingMessage) => {
    ws.on("error", () => {});                                    // a client socket error (reset, etc.) must not throw out of the emitter and crash the host
    try {
      const { exec, entry, args = [], onDone } = await session(req);
      const peer = makePeer(wsPort(ws));
      // §5 heap coherence is per-connection: one heap for excised locals, one bounded
      // reader cache, shared across this socket's module-hosts (each host applies it only
      // if its own bundle is heap-compiled). serve() answers the other tier's fetch,
      // write-back, and release requests against that heap.
      const coherence = heap ? makeCoherence(tier) : undefined;
      if (coherence) coherence.serve(peer);
      const hosts = new Map<string, import("./types.mjs").Host>();  // moduleId -> host (stateless; cached per socket)
      const hostFor = async (id: string) => {
        if (!hosts.has(id)) hosts.set(id, makeHost({ bundle: await resolveBundle(id), tier, exec, meta: id ? { module: id } : {}, coherence }));
        return hosts.get(id)!;
      };
      answerWith(peer, hostFor);                                   // browser-started sessions (actions) + bounces
      if (entry) {                                                 // full-tierless mode: the server starts the session
        const value = await (await hostFor("")).run(peer, entry, args);
        if (onDone) onDone(value);
      }
    } catch (e: any) {
      try { ws.close(1011, String((e && e.message) || e).slice(0, 100)); } catch { /* already gone */ }
    }
  });

  return { close: () => { httpServer.off("upgrade", onUpgrade); wss.close(); } };
}

// ---------------------------------------------------------------- serveApp ------------
const MIME: Record<string, string> = {
  ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".map": "application/json; charset=utf-8",
};

export interface ServeAppOpts extends AttachOptions {
  port?: number;
  page?: string;
  staticRoot?: string;
}
// A complete app server: static files + a page + the session endpoint.
export async function serveApp({ port = 0, page, staticRoot, ...attachOpts }: ServeAppOpts): Promise<{ server: HttpServer; port: number; close(): void }> {
  const root = staticRoot ? path.resolve(staticRoot) + path.sep : null;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL, pathname: string;
    try { url = new URL(req.url!, "http://localhost"); pathname = decodeURIComponent(url.pathname); }
    catch { res.writeHead(400); return res.end("bad request"); }   // malformed URL / percent-encoding from an untrusted client — don't crash the process
    if (page && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(page);
    }
    if (!root) { res.writeHead(404); return res.end("not found"); }
    const abs = path.join(root, pathname.replace(/^\/+/, ""));
    if (!abs.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }   // no traversal outside the root
    fs.readFile(abs, (err, data) => {
      if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found: " + url.pathname); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] || "application/octet-stream" });
      res.end(data);
    });
  });
  const attached = attachTierless(server, attachOpts);
  await new Promise<void>((r) => server.listen(port, r));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () => { attached.close(); server.close(); },
  };
}

export type { Bundle, Exec, ResourceRequest };

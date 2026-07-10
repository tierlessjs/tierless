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
import { pathToFileURL } from "node:url";
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
  /** Session twin registry (docs/migrate-arm.md slice 3): resolve a class-stamped §5
   *  handle to a LOCAL instance — typically the app's own service class constructed
   *  with this session's credentials. Opt-in per class; scoped to this connection.
   *  `handle` is the receiver's identity (owner tier + heap id) — key on it for
   *  stateful per-instance classes; class-only keying is right only for singletons. */
  twins?: (cls: string, handle?: { id: string; owner: string }) => object | undefined;
}
export interface AttachOptions {
  /** The compiled bundle, or an async resolver by module id (multi-module endpoints). */
  bundle: Bundle | ((moduleId: string) => Bundle | Promise<Bundle>);
  tier?: string;
  path?: string;
  /** Per-connection: log in, hold the token, return the monitor-backed exec. */
  session: (req: IncomingMessage) => SessionSetup | Promise<SessionSetup>;
  /** Count session-socket bytes at the TCP level (deflate included) — see makeWireStats. */
  wire?: WireStats;
  /** §5 heap coherence (excision, deref and CAS write-back over the socket, bounded cache,
   *  per-continuation release). On by default; it takes effect per module — only bundles
   *  compiled with --auto-deref/--auto-writeback excise and service §5 ops, so ordinary
   *  bundles (including a resolver's) are unaffected. false disables it entirely. */
  heap?: boolean;
  /** Live-connection cap. The count is PER PROCESS — every tierless endpoint in the
   *  process draws from one pool — so per-connection budgets (the §5 cache, socket
   *  buffers) have a finite process-wide ceiling. A connection beyond the cap is refused
   *  at the upgrade with 503; established sessions are untouched. Default
   *  DEFAULT_MAX_CONNECTIONS (100). */
  maxConnections?: number;
}

// TCP-true session byte accounting. CDP and 'message' handlers both see ws frames
// AFTER inflate, so any instrument above the socket over-reports a compressed session.
// socket.bytesRead/bytesWritten are what actually crossed the wire; closed sockets'
// totals are folded in so read() is monotonic across reconnects.
export interface WireStats { track(socket: { bytesRead: number; bytesWritten: number; once(ev: "close", fn: () => void): void }): void; read(): { wsIn: number; wsOut: number } }
export function makeWireStats(): WireStats {
  let closedIn = 0, closedOut = 0;
  const live = new Set<{ bytesRead: number; bytesWritten: number }>();
  return {
    track(s) {
      live.add(s);
      s.once("close", () => { closedIn += s.bytesRead; closedOut += s.bytesWritten; live.delete(s); });
    },
    read() {
      let wsIn = closedIn, wsOut = closedOut;
      for (const s of live) { wsIn += s.bytesRead; wsOut += s.bytesWritten; }
      return { wsIn, wsOut };
    },
  };
}

// Default per-process connection cap. Each connection carries per-connection budgets (the
// §5 cache is up to 64 MiB, plus socket buffers), so the process ceiling is cap x budget —
// pick maxConnections to fit the deployment's memory, not the OS's file-descriptor limit.
export const DEFAULT_MAX_CONNECTIONS = 100;
let liveConnections = 0;   // process-wide: every attachTierless endpoint draws from one pool

// Mount the session endpoint on an EXISTING http server (Express/Fastify/Vite — anything
// that emits 'upgrade'); co-mountable with other websocket handlers.
export function attachTierless(httpServer: HttpServer, { bundle, tier = "server", session, path: wsPath = WS_PATH, wire, heap = true, maxConnections = DEFAULT_MAX_CONNECTIONS }: AttachOptions): { close(): void } {
  // STREAMING compression, not per-message: with context takeover the deflate window
  // persists across messages, so every exec's headers, URL prefixes, and JSON field
  // names compress against the whole session's history — cross-request redundancy that
  // per-response HTTP gzip structurally cannot reach. Each message still SYNC_FLUSHes at
  // its boundary: no buffering latency, only ~µs of CPU. Low threshold on purpose: the
  // shared window makes even small messages worth compressing.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: {
    threshold: 64,
    serverNoContextTakeover: false, clientNoContextTakeover: false,
    zlibDeflateOptions: { level: 6 },
  } });
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
    if (liveConnections >= maxConnections) {                       // over the cap: refuse THIS upgrade, leave established sessions alone
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    liveConnections++;
    socket.on("close", () => { liveConnections--; });              // the raw TCP close fires once, whatever the ws handshake did
    wss.handleUpgrade(req, socket, head, (ws: any) => wss.emit("connection", ws, req));
  };
  httpServer.on("upgrade", onUpgrade);

  wss.on("connection", async (ws: any, req: IncomingMessage) => {
    ws.on("error", () => {});                                    // a client socket error (reset, etc.) must not throw out of the emitter and crash the host
    // the session multiplexes MANY small frames on one TCP stream — Nagle + the peer's
    // delayed ACK would stall each one ~40 ms; browsers set NODELAY on their end, we
    // must match on ours (this is a deployment property, not just a benchmark one)
    if (ws._socket?.setNoDelay) ws._socket.setNoDelay(true);
    if (wire && ws._socket) wire.track(ws._socket);
    try {
      const { exec, entry, args = [], onDone, twins } = await session(req);
      const peer = makePeer(wsPort(ws));
      // §5 heap coherence is per-connection: one heap for excised locals, one bounded
      // reader cache, shared across this socket's module-hosts (each host applies it only
      // if its own bundle is heap-compiled). serve() answers the other tier's fetch,
      // write-back, and release requests against that heap.
      const coherence = heap ? makeCoherence(tier) : undefined;
      if (coherence) coherence.serve(peer);
      const hosts = new Map<string, import("./types.mjs").Host>();  // moduleId -> host (stateless; cached per socket)
      const hostFor = async (id: string) => {
        if (!hosts.has(id)) hosts.set(id, makeHost({ bundle: await resolveBundle(id), tier, exec, meta: id ? { module: id } : {}, coherence, twins }));
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

// ---------------------------------------------------------------- prod build ----------
// Consume the manifest the Vite plugin emits at `vite build` (see vite.mts writeBundle): a
// `(moduleId) => Bundle` resolver ready to hand straight to `attachTierless`/`serveApp` as
// its `bundle`. This is the whole server side of a Vite prod deployment — no second
// `tierless build` pass, no hand-written module dispatch. The browser stamps each action's
// build-time module id onto the wire; that key is looked up here (exact, with a suffix
// fallback for a client built under a different absolute root), and the matched server
// bundle is imported once and cached.
export async function bundleResolverFromManifest(manifestPath: string): Promise<(moduleId: string) => Promise<Bundle>> {
  const dir = path.dirname(path.resolve(manifestPath));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { modules: Record<string, string> };
  const cache = new Map<string, Bundle>();
  const load = async (file: string): Promise<Bundle> => {
    if (!cache.has(file)) {
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      cache.set(file, { PROGRAMS: mod.PROGRAMS, __unwind: mod.__unwind, ...(mod.__slots ? { __slots: mod.__slots } : {}) });   // __slots: the §5 stop-rule table a migrated method needs
    }
    return cache.get(file)!;
  };
  // compiled APP modules (m:<hash> ids) run in ONE merged machine world, exactly like
  // the browser's bindMethods merge and the preview server: a migrated continuation can
  // dynamically enter a method compiled from a DIFFERENT app module, so resolving only
  // the named module would miss programs preview finds. Same collision rule too.
  let appMerged: Bundle | null | undefined;
  const mergedApp = async (): Promise<Bundle | null> => {
    if (appMerged !== undefined) return appMerged;
    const merged = { PROGRAMS: {} as Record<string, (f: never) => unknown>, __unwind: null as unknown, __slots: {} as Record<string, unknown> };
    for (const id of Object.keys(manifest.modules)) {
      if (!id.startsWith("m:")) continue;
      const b = await load(manifest.modules[id]);
      for (const [k, v] of Object.entries(b.PROGRAMS)) {
        if (merged.PROGRAMS[k] && merged.PROGRAMS[k] !== v) throw new Error("tierless: program name collision across compiled app modules: " + k);
        merged.PROGRAMS[k] = v as (f: never) => unknown;
      }
      if (b.__slots) Object.assign(merged.__slots, b.__slots as Record<string, unknown>);
      if (!merged.__unwind) merged.__unwind = b.__unwind;
    }
    return (appMerged = merged.__unwind ? (merged as unknown as Bundle) : null);
  };
  return async (moduleId: string): Promise<Bundle> => {
    if (!moduleId) throw new Error("tierless: empty module id on the wire — a malformed client would suffix-match anything");
    if (moduleId.startsWith("m:")) { const m = await mergedApp(); if (m) return m; }
    let file = manifest.modules[moduleId];
    if (!file) {                                                 // client built under a different root: match by path suffix
      // the match must be UNIQUE — resolving an ambiguous id by insertion order could
      // dispatch a stale client into an unrelated module's machine
      const hits = Object.keys(manifest.modules).filter((k) => k.endsWith(moduleId) || moduleId.endsWith(k));
      if (hits.length > 1) throw new Error("tierless: module id " + JSON.stringify(moduleId) + " suffix-matches " + hits.length + " bundles: " + hits.join(", "));
      if (hits.length === 1) file = manifest.modules[hits[0]];
    }
    if (!file) throw new Error("tierless: no server bundle for module " + JSON.stringify(moduleId));
    return load(file);
  };
}

export type { Bundle, Exec, ResourceRequest };

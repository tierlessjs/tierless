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
import { makePeer, wsPort, type Peer, type Port } from "./transport.mjs";
import { decodeArgs } from "./wire-binary.mjs";
import { h2Port, isWebSocketConnect } from "./transport-h2.mjs";
import { WS_PATH } from "./ws-path.mjs";
import type { Http2SecureServer, ServerHttp2Stream } from "node:http2";
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
  /** Sent to the browser as an unsolicited "hello" the instant the socket is up — the
   *  place to fold a startup round trip INTO the ws upgrade: a sealed auth blob (no reseal
   *  fetch) and/or GET envelopes pre-fetched from the upgrade's own credentials (boot
   *  preboot). Computed in `session(req)`, which holds the upgrade request's cookie.
   *  `sealed` declares whether this gateway mediates cookie authority (cookieAuthority's
   *  hello says true even blob-less — pre-login); a session that returns NO hello gets a
   *  default `{ blob: null, sealed: false }` sent for it, so adapt-auto's auth:"auto"
   *  resolves at socket-open instead of a safety-net timeout. */
  hello?: { blob?: string | null; sealed?: boolean; preboot?: Record<string, unknown> };
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
/** The session token from an upgrade request's subprotocol list. Browsers cannot set
 *  handshake headers, so the shim offers the credential as "bearer.<base64url(token)>"
 *  alongside the plain protocol — this reads it back without it ever touching a URL
 *  (where reverse-proxy access logs capture query strings) or the echoed protocol. */
export function bearerFromUpgrade(req: IncomingMessage): string | undefined {
  const offered = String(req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim());
  const b = offered.find((p) => p.startsWith("bearer."));
  if (!b) return undefined;
  try { return Buffer.from(b.slice(7).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") || undefined; } catch { return undefined; }
}

// The per-connection session setup, shared by every transport (plain ws, ws-over-H2, and a
// WebTransport adapter): given a Peer over whatever byte pipe and the handshake request,
// fire the hello, wire §5 coherence, build the module-host map, and answer. The transport
// differs only in how the Peer's Port is made — the session logic is identical.
async function serveSessionOn(peer: Peer, req: IncomingMessage, cfg: { resolveBundle: (id: string) => Bundle | Promise<Bundle>; session: (req: IncomingMessage) => SessionSetup | Promise<SessionSetup>; heap: boolean; tier: string }): Promise<void> {
  const { exec, entry, args = [], onDone, twins, hello } = await cfg.session(req);
  // fold a startup round trip into the handshake: fire the hello the instant the pipe is
  // up — ALWAYS, defaulting to "no cookie authority here" so the browser's auth wrapper
  // (auth:"auto") settles at socket-open instead of its 5s no-hello safety net.
  peer.request({ type: "hello", blob: null, sealed: false, ...hello }).catch(() => {});
  const coherence = cfg.heap ? makeCoherence(cfg.tier) : undefined;
  if (coherence) coherence.serve(peer);
  const hosts = new Map<string, import("./types.mjs").Host>();     // moduleId -> host (stateless; cached per connection)
  const hostFor = async (id: string) => {
    if (!hosts.has(id)) hosts.set(id, makeHost({ bundle: await cfg.resolveBundle(id), tier: cfg.tier, exec, meta: id ? { module: id } : {}, coherence, twins }));
    return hosts.get(id)!;
  };
  answerWith(peer, hostFor);                                        // browser-started sessions (actions) + bounces
  if (entry) { const value = await (await hostFor("")).run(peer, entry, args); if (onDone) onDone(value); }   // full-tierless mode: the server starts the session
}

// TIERLESS_WIRE_LOG=<file>: per-message wire anatomy, appended as JSON lines
// {d:in|out, n:<plaintext frame bytes>, k:kind, t:payload type, p:<api path>}. Byte
// counts are PRE-deflate (the shared compression window makes true per-message
// compressed sizes unobservable); pair with the TCP-true totals from --wire-truth to
// see what content a session's bytes actually are. Debug instrument: measurable
// decode cost per message, so it stays behind the env gate.
const wireLogPort = (port: Port): Port => {
  const file = typeof process !== "undefined" ? process.env?.TIERLESS_WIRE_LOG : undefined;
  if (!file) return port;
  const paths = new Map<unknown, string>();                     // request id -> api path, labels the reply
  const line = (d: "in" | "out", obj: any, bin: Uint8Array | null): void => {
    let p: string | undefined;
    try {
      if (obj?.payload?.type === "exec" && bin) {
        const [name, args] = decodeArgs(bin) as [string, unknown[]];
        if (typeof name === "string" && name.startsWith("api.")) p = String((args ?? [])[0] ?? "");
        if (p !== undefined) paths.set(obj.id, p);
      } else if (obj?.kind === "reply") { p = paths.get(obj.id); paths.delete(obj.id); }
    } catch { /* anatomy only — never let the instrument drop a frame */ }
    const n = 8 + Buffer.byteLength(JSON.stringify(obj)) + (bin?.length ?? 0);
    try { fs.appendFileSync(file, JSON.stringify({ d, n, k: obj?.kind, t: obj?.payload?.type, ...(p !== undefined ? { p } : {}) }) + "\n"); } catch { /* full disk etc. */ }
  };
  return {
    send: (obj, bin) => { line("out", obj, bin ?? null); port.send(obj, bin); },
    onMessage: (cb) => port.onMessage((obj, bin) => { line("in", obj, bin); cb(obj, bin); }),
    onClose: (cb) => port.onClose(cb),
    close: () => port.close(),
  };
};

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
  },
    // A client that offers subprotocols must have one echoed or the browser fails the
    // handshake. Echo the plain protocol, never a bearer.<token> — a credential offered
    // there (see bearerFromUpgrade) must not reflect into the response headers.
    handleProtocols: (ps: Set<string>) => {
      for (const p of ps) if (!p.startsWith("bearer.")) return p;
      return ps.values().next().value ?? false;
    },
  });
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
      await serveSessionOn(makePeer(wireLogPort(wsPort(ws))), req, { resolveBundle, session, heap, tier });
    } catch (e: any) {
      try { ws.close(1011, String((e && e.message) || e).slice(0, 100)); } catch { /* already gone */ }
    }
  });

  return { close: () => { httpServer.off("upgrade", onUpgrade); wss.close(); } };
}

// ---------------------------------------------------------------- ws-over-H2 -----------
// Mount the session endpoint on an HTTP/2 server as WebSocket-over-H2 (RFC 8441 Extended
// CONNECT). The whole point: a plain websocket is a SEPARATE connection whose TCP+upgrade
// handshake (~2 RTT) lands on the boot critical path; ws-over-H2 rides the page's EXISTING
// H2 connection as a new stream — no new handshake. The browser negotiates it transparently,
// so this is a pure server/deployment addition; the client code is unchanged.
//
// The H2 server MUST be created with `settings: { enableConnectProtocol: true }` (advertise
// RFC 8441 so browsers coalesce the ws onto the H2 connection) and, to also serve the plain-ws
// fallback and the app's own H2 requests, `allowHTTP1: true`. Co-mount `attachTierless` on the
// same server for the H1.1 'upgrade' path; this handles the H2 'stream' path. Requires TLS
// (browsers do H2 only over ALPN `h2`) and the SAME origin as the page (so the browser reuses
// its connection). Verify it actually rode H2, not a silent fallback: check the client's
// `performance…nextHopProtocol === 'h2'` and/or log the stream type here.
export function attachTierlessH2(h2server: Http2SecureServer, { bundle, tier = "server", session, path: wsPath = WS_PATH, heap = true, maxConnections = DEFAULT_MAX_CONNECTIONS }: AttachOptions): { close(): void } {
  const resolveBundle = typeof bundle === "function" ? bundle : () => bundle;
  const onStream = (stream: ServerHttp2Stream, headers: Record<string, unknown>): void => {
    if (!isWebSocketConnect(headers)) return;                      // an ordinary H2 request — not our ws endpoint
    const path = String(headers[":path"] ?? "");
    if (path.split("?")[0] !== wsPath) { try { stream.respond({ ":status": 404 }); stream.end(); } catch { /* gone */ } return; }
    if (liveConnections >= maxConnections) { try { stream.respond({ ":status": 503 }); stream.end(); } catch { /* gone */ } return; }
    liveConnections++;
    stream.on("close", () => { liveConnections--; });
    try {
      stream.respond({ ":status": 200 });                          // Extended CONNECT: a 200 (no 101), then RFC 6455 frames flow in the stream's DATA
      // (No setNoDelay here: Http2Session.socket is a guarded proxy that throws on socket
      // manipulation. NODELAY for H2 is a server-socket-level concern — set it when creating
      // the http2 server if the deployment needs it — not per stream.)
      // session() reads req.headers.origin / .cookie and req.url — the H2 pseudo/normal
      // headers carry both (origin, cookie are normal lowercase headers; :path is the url).
      const req = { headers, url: path } as unknown as IncomingMessage;
      serveSessionOn(makePeer(h2Port(stream)), req, { resolveBundle, session, heap, tier }).catch((e) => { if (process.env.TIERLESS_DEBUG) console.error("[attachTierlessH2] session error:", e); try { stream.close(); } catch { /* gone */ } });
    } catch { try { stream.close(); } catch { /* gone */ } }
  };
  h2server.on("stream", onStream);
  return { close: () => { h2server.off("stream", onStream); } };
}

export { h2Port, isWebSocketConnect } from "./transport-h2.mjs";

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
    if (!file) {
      // client built under a different absolute root (/build-a/... vs /build-b/...):
      // whole-string endsWith can never relate those, so compare PATH-SEGMENT suffixes —
      // the shorter side's full segment list must equal the longer side's tail. The match
      // must be UNIQUE: resolving an ambiguous id by insertion order could dispatch a
      // stale client into an unrelated module's machine.
      const segs = moduleId.split("/").filter(Boolean);
      const tailMatches = (k: string): boolean => {
        const ks = k.split("/").filter(Boolean);
        const n = Math.min(ks.length, segs.length);
        if (!n) return false;
        for (let i = 1; i <= n; i++) if (ks[ks.length - i] !== segs[segs.length - i]) return false;
        return true;
      };
      const hits = Object.keys(manifest.modules).filter(tailMatches);
      if (hits.length > 1) throw new Error("tierless: module id " + JSON.stringify(moduleId) + " suffix-matches " + hits.length + " bundles: " + hits.join(", "));
      if (hits.length === 1) file = manifest.modules[hits[0]];
    }
    if (!file) throw new Error("tierless: no server bundle for module " + JSON.stringify(moduleId));
    return load(file);
  };
}

export type { Bundle, Exec, ResourceRequest };

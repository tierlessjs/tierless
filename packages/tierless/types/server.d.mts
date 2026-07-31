import { WS_PATH } from "./ws-path.mjs";
import type { Http2SecureServer } from "node:http2";
import type { Bundle, Exec, ResourceRequest } from "./types.mjs";
import type { Server as HttpServer, IncomingMessage } from "node:http";
export { WS_PATH };
export interface SessionSetup {
    exec: Exec;
    /** Set to start a session server-side on connection (the full-tierless mode). */
    entry?: string;
    args?: unknown[];
    onDone?: (value: unknown) => void;
    /** Called once the session's pipe is up, with a push for SERVER-INITIATED frames to
     *  THIS session. The browse advisory needs it: a path is learned from the first
     *  oversize/fresh reply, and without a push only sessions that connect AFTERWARDS ever
     *  hear about it — every session already open keeps crossing it. Measured on n8n: 3
     *  crossings of a 12.9 MB catalogue, 41% of the ported arm's session plaintext, all by
     *  sessions that had already sent their hello when the first reply completed. */
    onOpen?: (session: {
        push(msg: object): void;
    }) => void;
    /** Session twin registry (docs/migrate-arm.md slice 3): resolve a class-stamped §5
     *  handle to a LOCAL instance — typically the app's own service class constructed
     *  with this session's credentials. Opt-in per class; scoped to this connection.
     *  `handle` is the receiver's identity (owner tier + heap id) — key on it for
     *  stateful per-instance classes; class-only keying is right only for singletons. */
    twins?: (cls: string, handle?: {
        id: string;
        owner: string;
    }) => object | undefined;
    /** Sent to the browser as an unsolicited "hello" the instant the socket is up — the
     *  place to fold a startup round trip INTO the ws upgrade: a sealed auth blob (no reseal
     *  fetch) and/or GET envelopes pre-fetched from the upgrade's own credentials (boot
     *  preboot). Computed in `session(req)`, which holds the upgrade request's cookie.
     *  `sealed` declares whether this gateway mediates cookie authority (cookieAuthority's
     *  hello says true even blob-less — pre-login); a session that returns NO hello gets a
     *  default `{ blob: null, sealed: false }` sent for it, so adapt-auto's auth:"auto"
     *  resolves at socket-open instead of a safety-net timeout. */
    hello?: {
        blob?: string | null;
        sealed?: boolean;
        preboot?: Record<string, unknown>;
        /** Paths the gateway measured oversize (TIERLESS_BROWSE_OVER): adapt-auto returns
         *  them to stock browser fetch — huge bodies stream better over HTTP than as one
         *  main-thread ws frame. */
        forceBrowser?: string[];
    };
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
export interface WireStats {
    track(socket: {
        bytesRead: number;
        bytesWritten: number;
        once(ev: "close", fn: () => void): void;
    }): void;
    read(): {
        wsIn: number;
        wsOut: number;
    };
}
export declare function makeWireStats(): WireStats;
export declare const DEFAULT_MAX_CONNECTIONS = 100;
/** The session token from an upgrade request's subprotocol list. Browsers cannot set
 *  handshake headers, so the shim offers the credential as "bearer.<base64url(token)>"
 *  alongside the plain protocol — this reads it back without it ever touching a URL
 *  (where reverse-proxy access logs capture query strings) or the echoed protocol. */
export declare function bearerFromUpgrade(req: IncomingMessage): string | undefined;
export declare function attachTierless(httpServer: HttpServer, { bundle, tier, session, path: wsPath, wire, heap, maxConnections }: AttachOptions): {
    close(): void;
};
export declare function attachTierlessH2(h2server: Http2SecureServer, { bundle, tier, session, path: wsPath, heap, maxConnections }: AttachOptions): {
    close(): void;
};
export { h2Port, isWebSocketConnect } from "./transport-h2.mjs";
export interface ServeAppOpts extends AttachOptions {
    port?: number;
    page?: string;
    staticRoot?: string;
}
export declare function serveApp({ port, page, staticRoot, ...attachOpts }: ServeAppOpts): Promise<{
    server: HttpServer;
    port: number;
    close(): void;
}>;
export declare function bundleResolverFromManifest(manifestPath: string): Promise<(moduleId: string) => Promise<Bundle>>;
export type { Bundle, Exec, ResourceRequest };

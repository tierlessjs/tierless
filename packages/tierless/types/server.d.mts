import { WS_PATH } from "./ws-path.mjs";
import type { Bundle, Exec, ResourceRequest } from "./types.mjs";
import type { Server as HttpServer, IncomingMessage } from "node:http";
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
    /** Enable §5 heap coherence (excision, deref and CAS write-back over the socket, bounded
     *  cache, per-continuation release). Defaults to on when the bundle was compiled with
     *  --auto-deref/--auto-writeback and off otherwise, so ordinary apps are unaffected. */
    heap?: boolean;
}
export declare function attachTierless(httpServer: HttpServer, { bundle, tier, session, path: wsPath, heap }: AttachOptions): {
    close(): void;
};
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
export type { Bundle, Exec, ResourceRequest };

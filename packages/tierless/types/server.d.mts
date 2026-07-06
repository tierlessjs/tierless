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
    /** Count session-socket bytes at the TCP level (deflate included) — see makeWireStats. */
    wire?: WireStats;
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
export declare function attachTierless(httpServer: HttpServer, { bundle, tier, session, path: wsPath, wire }: AttachOptions): {
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
export declare function bundleResolverFromManifest(manifestPath: string): Promise<(moduleId: string) => Promise<Bundle>>;
export type { Bundle, Exec, ResourceRequest };

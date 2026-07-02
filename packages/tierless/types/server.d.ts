// tierless/server — the Node host, assembled.
import type { Bundle, Exec, ResourceRequest } from "./index.js";
import type { Server as HttpServer, IncomingMessage } from "node:http";

export const WS_PATH: string;

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
}

/** Mount the session endpoint on an EXISTING http server (Express/Fastify/Vite — anything
 *  that emits 'upgrade'); co-mountable with other websocket handlers. */
export function attachTierless(httpServer: HttpServer, opts: AttachOptions): { close(): void };

/** A complete app server: static files + a page + the session endpoint. */
export function serveApp(opts: AttachOptions & {
  port?: number;
  page?: string;
  staticRoot?: string;
}): Promise<{ server: HttpServer; port: number; close(): void }>;

export type { Bundle, Exec, ResourceRequest };

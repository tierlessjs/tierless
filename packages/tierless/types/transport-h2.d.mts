import { type Port } from "./transport.mjs";
import type { ServerHttp2Stream } from "node:http2";
/** True for an inbound http2 stream that is a ws-over-H2 handshake (Extended CONNECT). The
 *  server advertises `enableConnectProtocol`; a conforming client (every modern browser)
 *  opens `:method CONNECT, :protocol websocket`. Everything else is an ordinary H2 request. */
export declare function isWebSocketConnect(headers: Record<string, unknown>): boolean;
/** Adapt an accepted ws-over-H2 stream to a tierless Port. Call AFTER `stream.respond({
 *  ':status': 200 })` (Extended CONNECT has no 101). The tierless message codec rides INSIDE
 *  each binary ws frame, exactly as it does over a plain websocket — only the byte pipe under
 *  the frames is an H2 stream instead of a TCP socket. */
export declare function h2Port(stream: ServerHttp2Stream): Port;

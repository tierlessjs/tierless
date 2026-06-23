// Stackmix — server-side WebSocket binder. Stands up a `ws` server and gives
// each connection its own server tier + heap, serving migrations and on-demand
// §5 fetches over that socket. Server-only (imports `ws`); the browser uses
// wss.mjs directly with its native WebSocket, so this module is never reachable
// from a browser bundle.

import { WebSocketServer } from "ws";
import { wsPort, makePeer, serve, makeWssHost } from "./wss.mjs";

// serveWss(opts, makeSession): bind a WebSocket endpoint. `makeSession(socket)`
// returns { rt, tier, host? } and is called once per connection, so each client
// gets a fresh server tier (its own resources + heap) and never shares state with
// another. Returns the WebSocketServer (call `.address().port` / `.close()`).
export function serveWss({ port, server, path } = {}, makeSession) {
  const wss = new WebSocketServer(server ? { server, path } : { port, path });
  wss.on("connection", (socket) => {
    const { rt, tier, host } = makeSession(socket);
    serve(rt, tier, makePeer(wsPort(socket)), { host: host || makeWssHost(tier) });
  });
  return wss;
}

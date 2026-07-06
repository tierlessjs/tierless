// Real RTT injection without kernel privileges: a raw TCP relay that delivers every
// chunk a fixed one-way delay late, both directions. Unlike CDP throttling it shapes
// websockets and CORS preflights identically to plain HTTP — the whole reason latency
// had to be modeled until now. Bandwidth is NOT shaped; timing claims from a shaped
// run are "elapsed under injected RTT, unbounded bandwidth" and say so.
//
// setTimeout with a constant delay preserves per-socket FIFO ordering, so the stream
// arrives intact, just late. Chunks buffer in memory during the delay window — fine at
// e2e-suite volumes.
import net from "node:net";

export interface WireCounter { toServer: number; toClient: number }

/** onWire, when given, receives every relayed chunk's TRUE byte count. This is the
 *  ground-truth instrument for compressed transports: CDP reports websocket frames
 *  post-inflate, so permessage-deflate's wire savings are invisible to it — only a
 *  socket-level count shows what actually traveled. */
export function delayProxy(listen: number, target: number, oneWayMs: number, onWire?: WireCounter): net.Server {
  const srv = net.createServer((cli) => {
    const up = net.connect(target, "127.0.0.1");
    const relay = (from: net.Socket, to: net.Socket, dir: "toServer" | "toClient"): void => {
      from.on("data", (chunk) => {
        if (onWire) onWire[dir] += chunk.length;
        if (oneWayMs) setTimeout(() => { if (to.writable) to.write(chunk); }, oneWayMs);
        else if (to.writable) to.write(chunk);
      });
      from.on("end", () => (oneWayMs ? setTimeout(() => to.end(), oneWayMs) : to.end()));
      from.on("error", () => to.destroy());
    };
    relay(cli, up, "toServer");
    relay(up, cli, "toClient");
    up.on("error", () => cli.destroy());
  });
  srv.listen(listen, "127.0.0.1");
  return srv;
}

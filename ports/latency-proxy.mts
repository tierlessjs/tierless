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
/** bps, when given, models LINK BANDWIDTH per direction: each chunk occupies the wire
 *  for len*8/bps before the propagation delay, and chunks queue behind each other
 *  (serialization delay, the real thing a byte reduction buys back on slow links). At
 *  1 Gbps this app's payloads cost microseconds — the option exists to show that
 *  honestly, and to model the 10-50 Mbps links where 35% fewer bytes IS wall time. */
export function delayProxy(listen: number, target: number, oneWayMs: number, onWire?: WireCounter, bps?: number): net.Server {
  const srv = net.createServer((cli) => {
    const up = net.connect(target, "127.0.0.1");
    // Nagle would coalesce our small relayed writes against the peer's delayed ACK —
    // ~40 ms stalls PER MESSAGE that shaped runs would misread as round trips. The relay
    // must add exactly the modeled delays and nothing else.
    cli.setNoDelay(true); up.setNoDelay(true);
    const relay = (from: net.Socket, to: net.Socket, dir: "toServer" | "toClient"): void => {
      let wireFree = 0;                                  // per-direction: when the modeled link is next idle
      from.on("data", (chunk) => {
        if (onWire) onWire[dir] += chunk.length;
        const now = Date.now();
        const serializeMs = bps ? (chunk.length * 8 * 1000) / bps : 0;
        wireFree = Math.max(wireFree, now) + serializeMs;                // chunks queue on the link
        const wait = wireFree - now + oneWayMs;                          // finish serializing, then propagate
        if (wait > 0) setTimeout(() => { if (to.writable) to.write(chunk); }, wait);
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

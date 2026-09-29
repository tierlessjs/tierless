// Real RTT injection without kernel privileges: a raw TCP relay that delivers every
// chunk a fixed one-way delay late, both directions. Unlike CDP throttling it shapes
// websockets and CORS preflights identically to plain HTTP — the whole reason latency
// had to be modeled until now. Bandwidth is shaped only when a Link is passed; timing
// claims from a run without one are "elapsed under injected RTT, unbounded bandwidth"
// and say so.
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
/** A modeled access link: bps per direction, and when each direction is next idle. ONE
 *  link is shared by every connection behind it — and by every relay given it — as a
 *  user's line is: stock HTTP's six parallel connections must not get six links while a
 *  session rides one socket. */
export interface Link { bps: number; toServer: number; toClient: number }
export const makeLink = (bps: number): Link => ({ bps, toServer: 0, toClient: 0 });
/** link, when given, models LINK BANDWIDTH per direction: each chunk occupies the wire
 *  for len*8/bps before the propagation delay, and chunks queue behind each other
 *  (serialization delay, the real thing a byte reduction buys back on slow links). */
// tap (optional): a per-connection observer of the relayed bytes — wsIoTap from
// tierless/playwright times session crossings at the network level here, where a
// browser-side frame event would wait for the page's main thread.
type Tap = { up(chunk: Buffer, at: number): void; down(chunk: Buffer, at: number): void } | null;
export function delayProxy(listen: number, target: number, oneWayMs: number, onWire?: WireCounter, link?: Link, tap?: () => Tap): net.Server {
  const srv = net.createServer((cli) => {
    const up = net.connect(target, "127.0.0.1");
    const t = tap?.() ?? null;
    // Nagle would coalesce our small relayed writes against the peer's delayed ACK —
    // ~40 ms stalls PER MESSAGE that shaped runs would misread as round trips. The relay
    // must add exactly the modeled delays and nothing else.
    cli.setNoDelay(true); up.setNoDelay(true);
    const relay = (from: net.Socket, to: net.Socket, dir: "toServer" | "toClient"): void => {
      from.on("data", (chunk: Buffer) => {
        if (onWire) onWire[dir] += chunk.length;
        const now = Date.now();
        let wait = oneWayMs;
        if (link) {                                                      // chunks queue on the shared link
          link[dir] = Math.max(link[dir], now) + (chunk.length * 8 * 1000) / link.bps;
          wait += link[dir] - now;                                       // finish serializing, then propagate
        }
        if (t) { if (dir === "toServer") t.up(chunk, now); else t.down(chunk, now + Math.max(wait, 0)); }   // down: when the browser gets it
        if (wait > 0) setTimeout(() => { if (to.writable) to.write(chunk); }, wait);
        else if (to.writable) to.write(chunk);
      });
      from.on("end", () => {
        // EOF rides behind any chunks still serializing on the modeled link — ending
        // after only the propagation delay would truncate a bps-shaped stream.
        const wait = Math.max((link ? link[dir] : 0) - Date.now(), 0) + oneWayMs;
        if (wait > 0) setTimeout(() => to.end(), wait);
        else to.end();
      });
      from.on("error", () => to.destroy());
    };
    relay(cli, up, "toServer");
    relay(up, cli, "toClient");
    up.on("error", () => cli.destroy());
  });
  srv.listen(listen, "127.0.0.1");
  return srv;
}

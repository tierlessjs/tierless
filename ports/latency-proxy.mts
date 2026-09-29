// Real RTT injection without kernel privileges: a raw TCP relay that delivers every
// chunk a fixed one-way delay late, both directions. Unlike CDP throttling it shapes
// websockets and CORS preflights identically to plain HTTP — the whole reason latency
// had to be modeled until now. Bandwidth is shaped only when a Link is passed; timing
// claims from a run without one are "elapsed under injected RTT, unbounded bandwidth"
// and say so.
//
// Each direction delivers through one ordered queue, so the stream arrives intact, just
// late. Chunks buffer in memory during the delay window — fine at e2e-suite volumes.
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
type Tap = { up(chunk: Buffer, at: number): void; down(chunk: Buffer, at: number): void; close(at: number): void } | null;
export function delayProxy(listen: number, target: number, oneWayMs: number, onWire?: WireCounter, link?: Link, tap?: () => Tap): net.Server {
  const srv = net.createServer((cli) => {
    const up = net.connect(target, "127.0.0.1");
    const t = tap?.() ?? null;
    // Nagle would coalesce our small relayed writes against the peer's delayed ACK —
    // ~40 ms stalls PER MESSAGE that shaped runs would misread as round trips. The relay
    // must add exactly the modeled delays and nothing else.
    cli.setNoDelay(true); up.setNoDelay(true);
    const relay = (from: net.Socket, to: net.Socket, dir: "toServer" | "toClient"): void => {
      // ONE ordered delivery queue per direction, drained by one timer: a setTimeout per
      // chunk keeps a stream in order only while every chunk has the same delay — with a
      // bandwidth link, delays differ per chunk, and timers of different durations don't
      // fire in submission order (a shared link reordered thousands of small writes and
      // truncated streams). EOF queues behind the data.
      const q: { due: number; chunk: Buffer | null }[] = [];     // null = end
      let timer: NodeJS.Timeout | null = null;
      const drain = (): void => {
        timer = null;
        const now = Date.now();
        while (q.length && q[0].due <= now) {
          const { chunk } = q.shift()!;
          if (chunk === null) to.end();
          else if (to.writable) to.write(chunk);
        }
        if (q.length) timer = setTimeout(drain, q[0].due - now);
      };
      const deliver = (due: number, chunk: Buffer | null): void => {
        q.push({ due: Math.max(due, q.length ? q[q.length - 1].due : 0), chunk });   // never before an earlier chunk
        if (!timer) drain();
      };
      from.on("data", (chunk: Buffer) => {
        if (onWire) onWire[dir] += chunk.length;
        const now = Date.now();
        let due = now + oneWayMs;
        if (link) {                                                      // chunks queue on the shared link
          link[dir] = Math.max(link[dir], now) + (chunk.length * 8 * 1000) / link.bps;
          due = link[dir] + oneWayMs;                                    // finish serializing, then propagate
        }
        due = Math.max(due, q.length ? q[q.length - 1].due : 0);
        if (t) { if (dir === "toServer") t.up(chunk, now); else t.down(chunk, due); }   // down: when the browser gets it
        deliver(due, chunk);
      });
      from.on("end", () => deliver(Date.now() + oneWayMs, null));
      from.on("error", () => to.destroy());
    };
    if (t) cli.on("close", () => t.close(Date.now()));
    relay(cli, up, "toServer");
    relay(up, cli, "toClient");
    up.on("error", () => cli.destroy());
  });
  srv.listen(listen, "127.0.0.1");
  return srv;
}

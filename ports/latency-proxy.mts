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

export function delayProxy(listen: number, target: number, oneWayMs: number): net.Server {
  const srv = net.createServer((cli) => {
    const up = net.connect(target, "127.0.0.1");
    const relay = (from: net.Socket, to: net.Socket): void => {
      from.on("data", (chunk) => setTimeout(() => { if (to.writable) to.write(chunk); }, oneWayMs));
      from.on("end", () => setTimeout(() => to.end(), oneWayMs));
      from.on("error", () => to.destroy());
    };
    relay(cli, up);
    relay(up, cli);
    up.on("error", () => cli.destroy());
  });
  srv.listen(listen, "127.0.0.1");
  return srv;
}

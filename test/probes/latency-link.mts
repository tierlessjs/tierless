// Probe: the ports' latency relay (ports/latency-proxy.mts) models ONE access link shared
// by every connection behind it. Stock HTTP opens several connections while a session
// rides one socket; a per-connection cap would hand stock several links.
//
//   two connections each pulling 250 KB at 10 Mbit/s, shared link   -> ~400 ms for both
//   the same on separate links                                       -> ~200 ms
//   one connection alone on the link                                 -> ~200 ms
//
// Run:  node test/probes/latency-link.mts
import net from "node:net";
import { delayProxy, makeLink, type Link } from "../../ports/latency-proxy.mts";
import { makeCheck } from "../lib/check.mts";

const { check, ok } = makeCheck();
const BODY = Buffer.alloc(250_000, 120);
const origin = net.createServer((s) => { s.once("data", () => s.end(BODY)); });
await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
const target = (origin.address() as net.AddressInfo).port;

let port = 0;
const relay = (link?: Link): Promise<number> => new Promise((r) => {
  const srv = delayProxy(0, target, 0, undefined, link);
  srv.once("listening", () => { port = (srv.address() as net.AddressInfo).port; r(port); });
});
const pull = (p: number): Promise<number> => new Promise((resolve) => {
  const t = Date.now(); let n = 0;
  const c = net.connect(p, "127.0.0.1", () => c.write("go"));
  c.on("data", (d) => { n += d.length; });
  c.on("end", () => resolve(n === BODY.length ? Date.now() - t : -1));
});

const shared = makeLink(10e6);
const p1 = await relay(shared), p2 = await relay(shared);
const both = Math.max(...await Promise.all([pull(p1), pull(p2)]));
check("two connections on one shared 10 Mbit/s link take ~400 ms together", both >= 380 && both <= 520, both + " ms");

const q1 = await relay(makeLink(10e6)), q2 = await relay(makeLink(10e6));
const apart = Math.max(...await Promise.all([pull(q1), pull(q2)]));
check("on separate links they take ~200 ms (the model isn't per connection by accident)", apart >= 180 && apart <= 300, apart + " ms");

await new Promise((r) => setTimeout(r, 50));
const alone = await pull(p1);
check("one connection alone on the shared link: ~200 ms", alone >= 180 && alone <= 300, alone + " ms");

origin.close();
console.log(`\n${ok() ? "PASS" : "FAIL"} — the relay's bandwidth cap is one link shared by every connection behind it`);
process.exit(ok() ? 0 : 1);

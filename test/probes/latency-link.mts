// Probe: the ports' latency relay (ports/latency-proxy.mts) models ONE access link shared
// by every connection behind it. Stock HTTP opens several connections while a session
// rides one socket; a per-connection cap would hand stock several links.
//
//   two connections each pulling 250 KB at 10 Mbit/s, shared link   -> ~400 ms for both
//   the same on separate links                                       -> ~200 ms
//   one connection alone on the link                                 -> ~200 ms
//   3,000 small writes beside a bulk stream on the same link: all arrive, in order
//   (per-chunk timers reordered thousands of them and truncated the stream)
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

{
  const N = 3000;
  const small = net.createServer((s) => {
    s.setNoDelay(true);
    let i = 0;
    const tick = (): void => { for (let k = 0; k < 20 && i < N; k++, i++) s.write(i + ","); if (i < N) setImmediate(tick); else s.end(); };
    s.once("data", tick);
  });
  const bulk = net.createServer((s) => { s.once("data", () => { let n = 0; const go = (): void => { if (n++ < 60) { s.write(Buffer.alloc(65536, 1)); setTimeout(go, 3); } else s.end(); }; go(); }); });
  await new Promise<void>((r) => small.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => bulk.listen(0, "127.0.0.1", r));
  const link = makeLink(20e6);
  const via = (srv: net.Server): Promise<number> => new Promise((r) => { const p = delayProxy(0, (srv.address() as net.AddressInfo).port, 40, undefined, link); p.once("listening", () => r((p.address() as net.AddressInfo).port)); });
  const [ps, pb] = [await via(small), await via(bulk)];
  const b = net.connect(pb, "127.0.0.1", () => b.write("go")); b.on("data", () => {});
  const got = await new Promise<string>((r) => { let buf = ""; const c = net.connect(ps, "127.0.0.1", () => c.write("go")); c.on("data", (d) => { buf += d; }); c.on("end", () => r(buf)); });
  const xs = got.split(",").filter(Boolean).map(Number);
  const bad = xs.filter((x, i) => x !== i).length;
  check("3,000 small writes beside a bulk stream on one link: all delivered, in order", xs.length === N && bad === 0, `${xs.length}/${N}, ${bad} out of order`);
  small.close(); bulk.close(); b.destroy();
}

origin.close();
console.log(`\n${ok() ? "PASS" : "FAIL"} — the relay's bandwidth cap is one link shared by every connection behind it`);
process.exit(ok() ? 0 : 1);

// Probe: with a Link, the ports' latency relay (ports/latency-proxy.mts) runs the TCP sender
// a real line has. Checked against kernel TCP on one 20 Mbit/s link, 40 ms one way, cubic,
// unbounded queue (median ms, request -> last byte; a new connection's time includes connect):
//
//   412,845 B reply: new connection 567, after 1 s idle 487, hot (5 ms after a 322,877 B reply) 253
//   websocket, gateway deflate settings: open 163, first 47 KB reply 248,
//     47 KB after 350 ms idle 172, after 3 s idle 247
//   6 x 4.8 KB on 6 new connections: 169
//   4.8 KB reply on a warm connection written as a 413 KB reply starts on a new one: +5.9 ms
//   3 x 1.17 MB in parallel after 1 s idle: median 1519, slowest 1722
//
// Two Linux rules without a kernel run of their own: cwnd is kept while ACKs keep arriving
// (tcp_cong_avoid restamps it), so 47 KB after small crossings takes what it takes 100 ms
// after a reply (kernel 104); and an aborted download's sender stops only when the RST
// reaches it, one way later.
//
// Without a Link the relay stays RTT-only: every chunk exactly one way late, no handshake,
// no slow start, no bandwidth. TIERLESS_LINK_STATS logs what the link did per connection.
//
// Run:  node test/probes/tcp-link.mts
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { delayProxy, makeLink, type Link, type WireCounter } from "../../ports/latency-proxy.mts";
import { makeCheck } from "../lib/check.mts";

const { WebSocket, WebSocketServer } = createRequire(import.meta.url)("ws");
const hr = (): number => Number(process.hrtime.bigint()) / 1e6;   // CLOCK_MONOTONIC: shared with the origin process
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const BUNDLE = 412845, SERVERINFO = 322877, REALM = 4800, SI = 47000;

if (process.argv[2] === "origin") {
  // the origin, in its own process (as the ports' servers are): GET /b?n=N -> N bytes in one
  // write; tags B and R are held until both are in, then written back to back (the boot race).
  // ws: {rid, n} -> n incompressible bytes. Every write time goes to the parent.
  process.on("disconnect", () => process.exit(0));              // a probe that throws must not leave us holding its stdout
  const ZERO = Buffer.alloc(2 << 20, 0x61), RAND = crypto.randomBytes(1 << 20);
  const wrote = (rid: string): void => { process.send!({ rid, t: hr() }); };
  const reply = (r: { res: http.ServerResponse; n: number; rid: string }): void => {
    wrote(r.rid);
    r.res.writeHead(200, { "content-type": "application/octet-stream", "content-length": r.n }).end(ZERO.subarray(0, r.n));
  };
  let held: Record<string, { res: http.ServerResponse; n: number; rid: string }> = {};
  const web = http.createServer({ noDelay: true, keepAliveTimeout: 60000 }, (req, res) => {
    const u = new URL(req.url!, "http://x"), tag = u.searchParams.get("tag");
    const r = { res, n: Number(u.searchParams.get("n")), rid: u.searchParams.get("rid")! };
    req.resume();
    if (!tag) return reply(r);
    held[tag] = r;
    if (held.B && held.R) { reply(held.B); reply(held.R); held = {}; }
  });
  const wsHttp = http.createServer();
  const wss = new WebSocketServer({ server: wsHttp, perMessageDeflate: {   // as packages/tierless/src/server.mts
    threshold: 64, serverNoContextTakeover: false, clientNoContextTakeover: false, zlibDeflateOptions: { level: 6 },
  } });
  let off = 0;
  wss.on("connection", (ws: { _socket: net.Socket; on(e: string, f: (m: Buffer) => void): void; send(b: Buffer): void }) => {
    ws._socket.setNoDelay(true);
    ws.on("message", (m) => {
      const { rid, n } = JSON.parse(String(m));
      if (off + n > RAND.length) off = 0;
      wrote(rid); ws.send(RAND.subarray(off, (off += n)));
    });
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => wsHttp.listen(0, "127.0.0.1", r));
  process.send!({ web: (web.address() as net.AddressInfo).port, ws: (wsHttp.address() as net.AddressInfo).port });
} else {
  const { check, ok } = makeCheck();
  const origin = fork(fileURLToPath(import.meta.url), ["origin"]);
  const wrote = new Map<string, number>();
  const ports: { web: number; ws: number } = await new Promise((r) => origin.on("message", (m: { web?: number; ws?: number; rid?: string; t?: number }) => {
    if (m.rid) wrote.set(m.rid, m.t!); else r(m as { web: number; ws: number });
  }));
  const writeTime = async (rid: string): Promise<number> => { while (!wrote.has(rid)) await sleep(1); return wrote.get(rid)!; };
  const relay = (target: number, oneWay: number, link?: Link, onWire?: WireCounter): Promise<number> => new Promise((r) => {
    const s = delayProxy(0, target, oneWay, onWire, link);
    s.once("listening", () => r((s.address() as net.AddressInfo).port));
  });
  const med = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const f1 = (xs: number[]): string => `median ${med(xs).toFixed(1)} of [${xs.map((x) => x.toFixed(0)).join(", ")}]`;

  let seq = 0;
  const PAD = "p".repeat(850);                                   // a ~1 KB request, as a browser's
  const agent = (): http.Agent => new http.Agent({ keepAlive: true, maxSockets: 1 });
  const get = (port: number, ag: http.Agent, n: number, tag = ""): Promise<{ ms: number; end: number; rid: string }> => new Promise((resolve, reject) => {
    const rid = "r" + seq++, t0 = hr();
    http.get({ host: "127.0.0.1", port, path: `/b?n=${n}&rid=${rid}${tag && "&tag=" + tag}`, agent: ag, headers: { "x-pad": PAD } }, (res) => {
      let got = 0, last = 0;
      res.on("data", (d: Buffer) => { got += d.length; last = hr(); });
      res.on("end", () => (got === n ? resolve({ ms: last - t0, end: last, rid }) : reject(new Error(`got ${got} of ${n}`))));
    }).on("error", reject);
  });
  type Ws = { ws: { _socket: net.Socket; once(e: string, f: () => void): void; send(s: string): void; terminate(): void }; openMs: number };
  const wsOpen = (port: number): Promise<Ws> => new Promise((resolve, reject) => {
    const t0 = hr(), ws = new WebSocket(`ws://127.0.0.1:${port}/`, { perMessageDeflate: true });
    ws.on("open", () => { ws._socket.setNoDelay(true); resolve({ ws, openMs: hr() - t0 }); });
    ws.on("error", reject);
  });
  const wsReq = (c: Ws, n: number): Promise<number> => new Promise((resolve) => {
    let last = 0;
    const sock = c.ws._socket, onData = (): void => { last = hr(); };
    sock.on("data", onData);
    const t0 = hr();
    c.ws.once("message", () => { sock.off("data", onData); resolve(last - t0); });
    c.ws.send(JSON.stringify({ rid: "w" + seq++, n, pad: "p".repeat(200) }));
  });
  // |median - kernel| within tol
  const near = (name: string, xs: number[], kernel: number, tol: number): void =>
    check(`${name}: kernel ${kernel} ms ± ${tol}`, Math.abs(med(xs) - kernel) <= tol, f1(xs));

  // the page relay and the session relay share ONE link, as in ports/keycloak/suite.mts
  const link = makeLink(20e6), statsFile = path.join(mkdtempSync(path.join(tmpdir(), "tierless-link-")), "stats.jsonl");
  process.env.TIERLESS_LINK_STATS = statsFile;
  const web = await relay(ports.web, 40, link), sock = await relay(ports.ws, 40, link);
  for (let k = 0; k < 2; k++) {                                   // warm-up: JIT the http, ws and deflate paths
    const a = agent(); await get(web, a, 200); await get(web, a, BUNDLE); a.destroy();
    const c = await wsOpen(sock); await wsReq(c, SI); c.ws.terminate(); await sleep(300);
  }

  const T = 3, fresh: number[] = [], idle: number[] = [], hot: number[] = [], si: number[] = [];
  for (let k = 0; k < T; k++) {
    let a = agent();
    fresh.push((await get(web, a, BUNDLE)).ms); a.destroy(); await sleep(300);
    a = agent(); await get(web, a, 200); await sleep(1000);
    idle.push((await get(web, a, BUNDLE)).ms); a.destroy(); await sleep(300);
    a = agent(); si.push((await get(web, a, SERVERINFO)).ms); await sleep(5);
    hot.push((await get(web, a, BUNDLE)).ms); a.destroy(); await sleep(300);
  }
  near("413 KB on a new connection", fresh, 567, 15);
  near("413 KB after 1 s idle (slow start restarts)", idle, 487, 15);
  near("323 KB on a new connection", si, 530, 15);
  near("413 KB right after it (hot: no restart)", hot, 253, 12);

  const opens: number[] = [], firsts: number[] = [], after: Record<number, number[]> = { 350: [], 3000: [] };
  for (const gap of [350, 3000]) for (let k = 0; k < T; k++) {
    const c = await wsOpen(sock);
    opens.push(c.openMs); firsts.push(await wsReq(c, SI));
    await sleep(gap);
    after[gap].push(await wsReq(c, SI)); c.ws.terminate(); await sleep(300);
  }
  near("websocket open (handshake + upgrade)", opens, 163, 10);
  near("first 47 KB reply on a new websocket (3 flights)", firsts, 248, 12);
  near("47 KB after 350 ms idle (cwnd halved once)", after[350], 172, 15);
  near("47 KB after 3 s idle (back to the initial window)", after[3000], 247, 12);

  // the port's session pattern: small crossings 50-180 ms apart never leave the sender idle
  // for an RTO, and each ACK restamps cwnd, so the next 47 KB reply keeps the grown window
  const GAPS = [150, 100, 180, 50, 120, 160, 90, 140, 180, 60, 130, 170], kept: number[] = [];
  for (let k = 0; k < T; k++) {
    const c = await wsOpen(sock); await wsReq(c, SI);
    for (const g of GAPS) { await sleep(g); await wsReq(c, 300); }
    await sleep(150); kept.push(await wsReq(c, SI)); c.ws.terminate(); await sleep(300);
  }
  check("47 KB after 12 small crossings 50-180 ms apart: cwnd kept, as 100 ms after a reply (kernel 104) ± 12",
    Math.abs(med(kept) - 104) <= 12, f1(kept));

  const six: number[] = [];
  for (let k = 0; k < T; k++) {
    const as = Array.from({ length: 6 }, agent);
    six.push(...(await Promise.all(as.map((a) => get(web, a, REALM)))).map((r) => r.ms));
    as.forEach((a) => a.destroy()); await sleep(300);
  }
  near("6 x 4.8 KB on 6 new connections", six, 169, 12);

  // parallel bulk downloads: after slow start, cubic grows cwnd 5% per RTT (Reno's +1 per
  // RTT left the median connection 220 ms late). The fastest finishes ~90 ms early (documented).
  const BULK = 1166667, parMed: number[] = [], parSlow: number[] = [];
  for (let k = 0; k < T; k++) {
    const as = Array.from({ length: 3 }, agent);
    await Promise.all(as.map((a) => get(web, a, BULK))); await sleep(1000);
    const ms = (await Promise.all(as.map((a) => get(web, a, BULK)))).map((r) => r.ms).sort((u, v) => u - v);
    parMed.push(ms[1]); parSlow.push(ms[2]);
    as.forEach((a) => a.destroy()); await sleep(300);
  }
  near("3 x 1.17 MB in parallel after 1 s idle, median connection", parMed, 1519, 60);
  near("3 x 1.17 MB in parallel after 1 s idle, slowest connection", parSlow, 1722, 60);

  // boot race: a 4.8 KB reply on warm connection X, written right after a 413 KB reply starts
  // on new connection Y. A new connection's initial window queues 10 segments ahead of it, not
  // the whole reply (the FIFO link without TCP made it wait ~165 ms).
  const X = agent(), base: number[] = [];
  await get(web, X, 200);
  for (let k = 0; k < 5; k++) { await sleep(100); const r = await get(web, X, REALM); base.push(r.end - await writeTime(r.rid)); }
  X.destroy();
  const extra: number[] = [];
  for (let k = 0; k < T; k++) {
    const x = agent(), y = agent();
    await get(web, x, 200);
    const [, rr] = await Promise.all([get(web, y, BUNDLE, "B"), get(web, x, REALM, "R")]);
    extra.push(rr.end - await writeTime(rr.rid) - med(base));
    x.destroy(); y.destroy(); await sleep(300);
  }
  check("cold boot race: the small reply waits <= 10 ms extra (kernel 5.9)", med(extra) <= 10, f1(extra) + `, unloaded ${med(base).toFixed(1)} ms`);

  // abort: the client drops a 1.17 MB download at 450 ms; its RST takes one way to reach the
  // sender, which until then keeps sending on the ACKs in flight. A small reply right after
  // waits behind those segments (stopping the sender at once gave ~0 ms extra).
  const aborted: number[] = [];
  for (let k = 0; k < T; k++) {
    const x = agent(), y = agent();
    await get(web, x, 200); await sleep(400);
    const req = http.get({ host: "127.0.0.1", port: web, path: `/b?n=${BULK}&rid=r${seq++}`, agent: y, headers: { "x-pad": PAD } }, (res) => res.resume().on("error", () => {}));
    req.on("error", () => {});
    await sleep(450); req.destroy(); await sleep(2);
    const r = await get(web, x, REALM);
    aborted.push(r.end - await writeTime(r.rid) - med(base));
    x.destroy(); y.destroy(); await sleep(500);
  }
  check("a download aborted at 450 ms holds the link one more way: a small reply after it waits 25-55 ms extra",
    med(aborted) >= 25 && med(aborted) <= 55, f1(aborted));

  // TIERLESS_LINK_STATS: one line per closed connection direction of the link relays
  const rows = readFileSync(statsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const down = rows.filter((x) => x.port === web && x.dir === "toClient");
  check("TIERLESS_LINK_STATS: new connections show the 80 ms handshake, the idle one a restart, bulk ones a grown cwnd",
    rows.some((x) => x.port === web && x.dir === "toServer" && x.handshakeMs >= 75) && rows.some((x) => x.port === sock) &&
    down.some((x) => x.idleRestarts >= 1) && down.some((x) => x.bytes > BUNDLE && x.segments > BUNDLE / 1448 && x.maxCwnd > 100),
    `${rows.length} lines, e.g. ${JSON.stringify(down.find((x) => x.idleRestarts))}`);

  // no Link: RTT only, as before this model existed
  const web0 = await relay(ports.web, 40), sock0 = await relay(ports.ws, 40);
  const n0: number[] = [], w0: number[] = [], o0: number[] = [], f0: number[] = [];
  for (let k = 0; k < T; k++) {
    const a = agent();
    n0.push((await get(web0, a, BUNDLE)).ms);
    const r = await get(web0, a, REALM); w0.push(r.end - await writeTime(r.rid)); a.destroy();
    const c = await wsOpen(sock0); o0.push(c.openMs); f0.push(await wsReq(c, SI)); c.ws.terminate(); await sleep(100);
  }
  check("no Link: a reply arrives one way (40 ms) after the server wrote it", med(w0) >= 40 && med(w0) <= 45, f1(w0));
  check("no Link: 413 KB on a new connection is one RTT, no handshake or bandwidth", med(n0) >= 80 && med(n0) <= 100, f1(n0));
  check("no Link: websocket open is one RTT", med(o0) >= 80 && med(o0) <= 95, f1(o0));
  check("no Link: first 47 KB websocket reply is one RTT", med(f0) >= 80 && med(f0) <= 95, f1(f0));
  const count: WireCounter = { toServer: 0, toClient: 0 }, web00 = await relay(ports.web, 0, undefined, count);
  const a = agent(), r = await get(web00, a, BUNDLE); a.destroy();
  check("no Link, no delay (the counting relay): bytes pass straight through and are counted", r.ms < 30 && count.toClient > BUNDLE && count.toServer > PAD.length, `${r.ms.toFixed(1)} ms, ${count.toClient} B down, ${count.toServer} B up`);

  origin.kill();
  console.log(`\n${ok() ? "PASS" : "FAIL"} — with a Link the relay runs TCP as a kernel sender would; without one it is RTT-only`);
  process.exit(ok() ? 0 : 1);
}

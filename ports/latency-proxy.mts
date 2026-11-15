// Real RTT injection without kernel privileges: a raw TCP relay that delivers every
// chunk a fixed one-way delay late, both directions. Unlike CDP throttling it shapes
// websockets and CORS preflights identically to plain HTTP — the whole reason latency
// had to be modeled until now. Bandwidth is shaped only when a Link is passed; timing
// claims from a run without one are "elapsed under injected RTT, unbounded bandwidth"
// and say so.
//
// Each direction delivers through one ordered queue, so the stream arrives intact, just
// late. Chunks buffer in memory during the delay window — fine at e2e-suite volumes.
//
// With a Link, each connection direction also runs the TCP sender a real line has
// (TcpSender): the upstream is localhost, so without it a whole response would enter the
// link the instant the server wrote it — no handshake, no slow start, no restart after
// idle. Checked against kernel TCP on a 20 Mbit/s, 40 ms one-way link (cubic, unbounded
// queue; test/probes/tcp-link.mts): 413 KB on a new connection 567 ms here vs 567 kernel,
// first 47 KB reply on a new websocket 249 vs 248, 47 KB after 350 ms idle 173 vs 172.
// Left out: loss and retransmission (the link queue is unbounded), the receive window,
// TLS (handshake round trips, record overhead), BBR's pacing, delayed ACKs, and HyStart's
// ACK-train exit, which ends the kernel's slow start at cwnd ~150 when ACKs arrive evenly.
// Known deviations from that kernel link:
// - After a 323 KB reply the kernel's cwnd is ~150 segments with even ACKs and 240-480
//   under CPU load or batched ACKs; here it is ~230. A small reply written just behind a
//   large one on such a hot connection waits 128-138 ms here, 82-92 ms on an idle kernel
//   host, 130-140 on a loaded one.
// - A long transfer keeps a larger standing queue: slow start ends at cwnd ~329 here, so
//   after 5 MB on one connection srtt is 277 ms here, 179 kernel (both take 2388 ms).
// - Parallel bulk downloads: 3 x 1.17 MB after 1 s idle, fastest/median/slowest
//   1069/1552/1704 ms here, 1159/1519/1722 kernel; the first of 6 x 1.17 MB ends at
//   2005 here, 2532 kernel.
import net from "node:net";
import { appendFileSync } from "node:fs";

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
type Dir = "toServer" | "toClient";

// The sender of one connection direction, with Linux's defaults (cubic,
// tcp_slow_start_after_idle=1). Each segment occupies the shared link for its bytes plus
// headers, queues behind earlier ones (FIFO, unbounded), then propagates one way; its ACK
// returns one way after delivery and uses no link time. Every segment is ACKed.
const MSS = 1448, HDR = 52, IW = 10, RTO_MIN = 200;   // 1500 MTU; IPv4 + TCP with timestamps
class TcpSender {
  cwnd = IW; ssthresh = Infinity;                    // initial window 10 segments (RFC 6928)
  buf: Buffer[] = []; bufN = 0; fin = false; dead = false;
  flight: { end: number; sent: number; ack: number }[] = [];   // unacked segments, oldest first
  nxt = 0; una = 0; srtt: number; minRtt: number; lastSend: number;
  stamp: number; used = 0; usageSeq = 0; maxOut = 0; limited = false;   // cwnd validation
  roundEnd = 0; roundRtt = Infinity; samples = 0; found = false;        // HyStart rounds
  segs = 0; restarts = 0; maxCwnd = IW; handshakeMs = 0;               // TIERLESS_LINK_STATS
  timer: NodeJS.Timeout | null = null; timerAt = Infinity;
  oneWay: number; dir: Dir; link: Link; ready: number; emit: (due: number, c: Buffer | null) => number;
  // ready: when this direction may first send. The client's first byte waits for the
  // handshake (SYN, SYN-ACK: one RTT), which also gives the first RTT sample.
  constructor(oneWay: number, dir: Dir, link: Link, ready: number, emit: (due: number, c: Buffer | null) => number) {
    this.oneWay = oneWay; this.dir = dir; this.link = link; this.ready = ready; this.emit = emit;
    this.srtt = this.minRtt = 2 * oneWay; this.stamp = this.lastSend = ready;
  }
  write(c: Buffer | null, now: number): void {
    this.acks(now);
    if (c && !this.nxt && !this.bufN) this.handshakeMs = Math.max(0, this.ready - now);
    if (c) { this.buf.push(c); this.bufN += c.length; } else this.fin = true;
    this.send(now); this.wake();
  }
  close(): void { this.dead = true; this.buf = []; this.bufN = 0; if (this.timer) clearTimeout(this.timer); }
  rto(): number { return this.srtt + RTO_MIN; }                 // Linux floors rttvar at rto_min (200 ms)
  // tcp_is_cwnd_limited: cwnd grows only while it limits sending — in slow start, until
  // it is twice the most packets the window actually held
  cwndLimited(): boolean { return this.limited || (this.cwnd < this.ssthresh && this.cwnd < 2 * this.maxOut); }
  // the next segment: up to MSS bytes, packed across write boundaries as the kernel's send queue packs them
  take(): Buffer {
    const n = Math.min(MSS, this.bufN), parts: Buffer[] = [];
    for (let k = n; k > 0;) {
      const b = this.buf[0];
      if (b.length > k) { parts.push(b.subarray(0, k)); this.buf[0] = b.subarray(k); break; }
      parts.push(b); this.buf.shift(); k -= b.length;
    }
    this.bufN -= n;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, n);
  }
  send(t: number): void {                                        // tcp_write_xmit at time t
    if (this.dead || t < this.ready) return;
    // tcp_cwnd_restart (tcp_slow_start_after_idle=1): nothing in flight and idle > RTO
    // restarts at min(IW, cwnd), halving cwnd once per RTO of idle down to that
    if (this.bufN && !this.flight.length && t - this.lastSend > this.rto()) {
      let idle = t - this.lastSend, w = this.cwnd; const r = Math.min(IW, w);
      this.ssthresh = Math.max(this.ssthresh, Math.floor(0.75 * w));
      while ((idle -= this.rto()) > 0 && w > r) w = Math.floor(w / 2);
      this.cwnd = Math.max(w, r); this.stamp = t; this.used = 0; this.restarts++;
    }
    let sent = 0;
    while (this.bufN && this.flight.length < Math.floor(this.cwnd)) {
      const seg = this.take();
      this.nxt += seg.length; sent++; this.segs++;
      this.link[this.dir] = Math.max(this.link[this.dir], t) + ((seg.length + HDR) * 8000) / this.link.bps;
      const due = this.emit(this.link[this.dir] + this.oneWay, seg);   // serialize, then propagate
      this.flight.push({ end: this.nxt, sent: t, ack: due + this.oneWay });
    }
    if (sent) this.lastSend = t;
    if (this.fin && !this.bufN) { this.fin = false; this.emit(t + this.oneWay, null); }
    if (!sent && !this.bufN) return;
    // tcp_cwnd_validate: remember whether this window was cwnd-limited, else its peak use
    const blocked = this.bufN > 0;
    if (this.una >= this.usageSeq || blocked || (!this.limited && this.flight.length > this.maxOut)) { this.limited = blocked; this.maxOut = this.flight.length; this.usageSeq = this.nxt; }
    if (this.cwndLimited()) { this.used = 0; this.stamp = t; return; }
    this.used = Math.max(this.used, this.flight.length);
    // tcp_cwnd_application_limited: an RTO of sending below cwnd decays it to (cwnd + used) / 2
    if (t - this.stamp >= this.rto()) {
      const w = Math.max(this.used, IW);
      if (w < this.cwnd) { this.ssthresh = Math.max(this.ssthresh, Math.floor(0.75 * this.cwnd)); this.cwnd = Math.floor((this.cwnd + w) / 2); }
      this.used = 0; this.stamp = t;
    }
  }
  acks(now: number): void {                                      // every ACK due by now, in order, each at its own time
    while (this.flight.length && this.flight[0].ack <= now) {
      const p = this.flight.shift()!, rtt = p.ack - p.sent;
      this.una = p.end; this.srtt += (rtt - this.srtt) / 8; this.minRtt = Math.min(this.minRtt, rtt);
      // CUBIC's HyStart delay exit (hystart_update): from cwnd 16, once 8 samples of a
      // round all exceed the minimum RTT by clamp(min/8, 4..16 ms), slow start ends
      if (!this.found && this.cwnd < this.ssthresh && this.cwnd >= 16) {
        this.roundRtt = Math.min(this.roundRtt, rtt);
        if (this.samples < 8) this.samples++;
        else if (this.roundRtt > this.minRtt + Math.min(16, Math.max(4, this.minRtt / 8))) { this.found = true; this.ssthresh = this.cwnd; }
      }
      if (p.end > this.roundEnd) { this.roundEnd = this.nxt; this.roundRtt = Infinity; this.samples = 0; }
      // slow start: +1 segment per segment ACKed (ABC); after it, cubic before any loss
      // (last_max_cwnd 0) caps cnt at 20: +1 per 20 ACKed, 5% per RTT
      if (this.cwndLimited()) { this.cwnd += this.cwnd < this.ssthresh ? 1 : 1 / 20; this.maxCwnd = Math.max(this.maxCwnd, this.cwnd); }
      this.stamp = p.ack;                                        // tcp_cong_avoid: every ACK of new data restamps cwnd
      this.send(p.ack);
    }
  }
  wake(): void {                                                 // one timer: the next ACK, or the handshake's end
    const at = this.dead ? Infinity : this.flight.length ? this.flight[0].ack : this.bufN || this.fin ? this.ready : Infinity;
    if (at === this.timerAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.timerAt = at;
    if (at === Infinity) return;
    this.timer = setTimeout(() => { this.timer = null; this.timerAt = Infinity; const now = Date.now(); this.acks(now); this.send(now); this.wake(); }, Math.max(0, at - Date.now()));
  }
}

/** link, when given, models the line: bandwidth per direction (each segment occupies the
 *  wire for its bytes before the propagation delay, queued behind earlier ones — the
 *  serialization delay a byte reduction buys back on slow links) and the TCP sender above.
 *  TIERLESS_LINK_STATS=<file> appends one JSON line per closed connection direction, one
 *  way after its receiver closed: relay port, dir, bytes, segments, handshakeMs (how long
 *  the handshake held its first byte), idleRestarts, maxCwnd. */
// tap (optional): a per-connection observer of the relayed bytes — wsIoTap from
// tierless/playwright times session crossings at the network level here, where a
// browser-side frame event would wait for the page's main thread.
type Tap = { up(chunk: Buffer, at: number): void; down(chunk: Buffer, at: number): void; close(at: number): void } | null;
export function delayProxy(listen: number, target: number, oneWayMs: number, onWire?: WireCounter, link?: Link, tap?: () => Tap): net.Server {
  const stats = link && process.env.TIERLESS_LINK_STATS;
  const srv = net.createServer((cli) => {
    const up = net.connect(target, "127.0.0.1");
    const t = tap?.() ?? null;
    const accepted = Date.now(), port = cli.localPort;           // the relay's port, for TIERLESS_LINK_STATS
    // Nagle would coalesce our small relayed writes against the peer's delayed ACK —
    // ~40 ms stalls PER MESSAGE that shaped runs would misread as round trips. The relay
    // must add exactly the modeled delays and nothing else.
    cli.setNoDelay(true); up.setNoDelay(true);
    const relay = (from: net.Socket, to: net.Socket, dir: Dir): void => {
      // ONE ordered delivery queue per direction, drained by one timer: a setTimeout per
      // chunk keeps a stream in order only while every chunk has the same delay — with a
      // bandwidth link, delays differ per chunk, and timers of different durations don't
      // fire in submission order (a shared link reordered thousands of small writes and
      // truncated streams). EOF queues behind the data.
      const q: { due: number; chunk: Buffer | null }[] = [];     // null = end
      let timer: NodeJS.Timeout | null = null;
      const drain = (): void => {
        timer = null;
        // with a Link, the segments due together go out in one write (at 1 Gbit/s a drain
        // holds many); without one, one write per chunk as read. EOF is always last.
        const now = Date.now(), out: Buffer[] = [];
        let end = false;
        while (q.length && q[0].due <= now) {
          const { chunk } = q.shift()!;
          if (chunk === null) end = true;
          else if (link) out.push(chunk);
          else if (to.writable) to.write(chunk);
        }
        if (out.length && to.writable) to.write(out.length === 1 ? out[0] : Buffer.concat(out));
        if (end) to.end();
        if (q.length) timer = setTimeout(drain, q[0].due - now);
      };
      const deliver = (due: number, chunk: Buffer | null): number => {
        due = Math.max(due, q.length ? q[q.length - 1].due : 0);   // never before an earlier chunk
        q.push({ due, chunk });
        if (t && chunk && dir === "toClient") t.down(chunk, due);   // down: when the browser gets it
        if (!timer) drain();
        return due;
      };
      const tcp = link ? new TcpSender(oneWayMs, dir, link, dir === "toServer" ? accepted + 2 * oneWayMs : accepted, deliver) : null;
      // a gone receiver stops its sender one way later, when its FIN or RST arrives; until
      // then the sender keeps sending on the ACKs in flight, and those segments use the link
      if (tcp) to.on("close", () => setTimeout(() => {
        tcp.close();
        if (stats) appendFileSync(stats, JSON.stringify({ port, dir, bytes: tcp.nxt, segments: tcp.segs,
          handshakeMs: tcp.handshakeMs, idleRestarts: tcp.restarts, maxCwnd: Math.floor(tcp.maxCwnd) }) + "\n");
      }, oneWayMs));
      from.on("data", (chunk: Buffer) => {
        if (onWire) onWire[dir] += chunk.length;
        const now = Date.now();
        if (t && dir === "toServer") t.up(chunk, now);
        if (tcp) tcp.write(chunk, now); else deliver(now + oneWayMs, chunk);
      });
      from.on("end", () => (tcp ? tcp.write(null, Date.now()) : deliver(Date.now() + oneWayMs, null)));
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

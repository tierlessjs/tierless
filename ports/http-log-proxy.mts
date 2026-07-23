// Per-request byte accounting for an HTTP origin — the decomposition half of the wire
// budget (ports/wire-budget.mts). The counting relay (latency-proxy.mts) gives the
// TCP-true TOTAL; this proxy assigns bytes to PATHS, so an arm-level delta can be read
// per endpoint instead of inferred from aggregates (the inference is what misattributed
// n8n's +8% — ports/n8n/README.md byte section).
//
// It forwards requests over node http and counts what it forwards: serialized header
// block + body bytes, both directions, response body AS TRANSFERRED (compressed when
// the origin compressed — Accept-Encoding passes through and the body is relayed raw).
// That is HTTP-message bytes, not TCP bytes (no TLS, no TCP framing, keep-alive shared
// overhead unassigned) — the budget's reconciliation row shows the difference against
// the relay's TCP total rather than pretending they're the same thing.
import http from "node:http";
import net from "node:net";
import { appendFileSync } from "node:fs";

export interface HttpLogLine {
  ts: number; method: string; path: string; status: number;
  reqBytes: number;    // request line + headers + body, as forwarded
  respBytes: number;   // status line + headers + body, as transferred
  enc?: string;        // response content-encoding, when present
}

const headerBlockSize = (firstLine: string, raw: string[]): number => {
  let n = firstLine.length + 2;
  for (let i = 0; i < raw.length; i += 2) n += raw[i].length + 2 + raw[i + 1].length + 2;
  return n + 2;   // terminating CRLF
};

/** Reverse-proxy 127.0.0.1:listen -> 127.0.0.1:target, appending one JSON line per
 *  request to `file`. Returns the server (unref it in drivers, close it in tests). */
export function httpLogProxy(listen: number, target: number, file: string): http.Server {
  const srv = http.createServer((req, res) => {
    let reqBytes = headerBlockSize(`${req.method} ${req.url} HTTP/1.1`, req.rawHeaders);
    const up = http.request({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      let respBytes = headerBlockSize(`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage ?? ""}`, ur.rawHeaders);
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.on("data", (c: Buffer) => { respBytes += c.length; res.write(c); });
      ur.on("end", () => {
        res.end();
        const line: HttpLogLine = {
          ts: Date.now(), method: req.method ?? "", path: req.url ?? "", status: ur.statusCode ?? 0,
          reqBytes, respBytes,
          ...(ur.headers["content-encoding"] ? { enc: String(ur.headers["content-encoding"]) } : {}),
        };
        try { appendFileSync(file, JSON.stringify(line) + "\n"); } catch { /* full disk: the totals reconciliation will show the gap */ }
      });
      ur.on("error", () => res.destroy());
    });
    req.on("data", (c: Buffer) => { reqBytes += c.length; up.write(c); });
    req.on("end", () => up.end());
    req.on("error", () => up.destroy());
    up.on("error", () => { if (!res.headersSent) { res.statusCode = 502; } res.end(); });
  });
  // websocket upgrades pass through untouched and UNCOUNTED (the session socket has its
  // own instrument — TIERLESS_WIRE_LOG); refusing them here would break the app
  srv.on("upgrade", (req, socket, head) => {
    const up = net.connect(target, "127.0.0.1", () => {
      let block = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) block += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(block + "\r\n");
      if (head?.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  srv.listen(listen, "127.0.0.1");
  return srv;
}

// Stock-arm compression as a RELAY, not an app patch (docs/corpus.md, the
// apples-to-apples lever): the gzip arm used to enable compression INSIDE each target's
// backend via a per-port patch; a compressing reverse proxy in front of the backend is
// the same fairness lever the way stock deployments actually get it (nginx), needs no
// tree change, and composes with the counting/RTT relays (latency-proxy.mts) in front
// of it. Compresses JSON/text bodies when the client offered gzip; passes streams,
// pre-encoded, and no-body statuses through untouched; splices websocket upgrades raw
// (socket.io rides the API origin).
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { createGzip, constants } from "node:zlib";

export function gzipProxy(listenPort: number, targetPort: number): Server {
  const srv = createServer((req, res) => {
    const up = request(
      // identity upstream: the backend never double-encodes, and WE decide compression
      { host: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: { ...req.headers, "accept-encoding": "identity" } },
      (ur) => {
        const status = ur.statusCode ?? 502;
        const type = String(ur.headers["content-type"] || "");
        const compressible =
          /\bgzip\b/i.test(String(req.headers["accept-encoding"] || "")) &&
          !ur.headers["content-encoding"] &&
          /json|text\/|javascript|\+xml|svg/.test(type) && !/event-stream/.test(type) &&
          status !== 204 && status !== 304;
        const headers: Record<string, string | string[] | number | undefined> = { ...ur.headers };
        if (compressible) {
          delete headers["content-length"];
          headers["content-encoding"] = "gzip";
          res.writeHead(status, headers);
          // SYNC_FLUSH: chunked responses keep flowing chunk by chunk, like nginx
          ur.pipe(createGzip({ flush: constants.Z_SYNC_FLUSH })).pipe(res);
        } else {
          res.writeHead(status, headers);
          ur.pipe(res);
        }
      },
    );
    up.on("error", () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
  srv.on("upgrade", (req, socket, head) => {
    const target = connect(targetPort, "127.0.0.1", () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += req.rawHeaders[i] + ": " + req.rawHeaders[i + 1] + "\r\n";
      target.write(raw + "\r\n");
      if (head && head.length) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
  });
  srv.listen(listenPort, "127.0.0.1");
  return srv;
}

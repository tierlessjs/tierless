// Verify the harness against GROUND TRUTH: a local server counts every byte on its own
// sockets (net.Socket bytesRead/bytesWritten — the wire, not an estimate) while a real
// Chromium runs a journey of known shape (N fetches of known sizes + M ws request/reply
// pairs). The harness's CDP-derived report must match the socket truth within declared
// tolerances. This is what makes before/after numbers from measure.mts trustworthy.
//
//   node bench/harness/verify.mts
import http from "node:http";
import { createRequire } from "node:module";
import { measureJourney, fmt } from "./measure.mts";
import { makeCheck } from "../../test/lib/check.mts";

const { WebSocketServer } = createRequire(import.meta.url)("ws");
const { check, ok } = makeCheck();

// ---- the server: known payloads, every socket byte counted -------------------------------
let httpRead = 0, httpWritten = 0, wsRead = 0, wsWritten = 0;
const PAGE = `<!doctype html><meta charset="utf-8"><title>t</title><body>ready`;
const blob = (n: number): string => JSON.stringify({ data: "x".repeat(n) });

const srv = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://x");
  if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE); }
  if (u.pathname === "/favicon.ico") { res.writeHead(404); return res.end(); }   // keep Chrome's favicon probe tiny and out of the data accounting
  const size = Number(u.searchParams.get("size") || 1000);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(blob(size));
});
srv.on("connection", (sock) => {
  // A socket that upgrades to ws stops being HTTP at the upgrade: its HTTP share is the
  // bytes UP TO the snapshot; everything after belongs to the ws accounting below.
  let upAt: { r: number; w: number } | null = null;
  sock.on("close", () => {
    httpRead += upAt ? upAt.r : sock.bytesRead;
    httpWritten += upAt ? upAt.w : sock.bytesWritten;
  });
  srv.on("upgrade", function onUp(_q, s) { if (s === sock) { upAt = { r: sock.bytesRead, w: sock.bytesWritten }; srv.off("upgrade", onUp); } });
});
const wss = new WebSocketServer({ server: srv });
wss.on("connection", (ws: any, req: any) => {
  const sock = req.socket;
  const r0 = sock.bytesRead, w0 = sock.bytesWritten;
  ws.on("message", (m: Buffer) => ws.send(blob(JSON.parse(m.toString()).reply)));
  ws.on("close", () => { wsRead += sock.bytesRead - r0; wsWritten += sock.bytesWritten - w0; });
});
await new Promise<void>((res) => srv.listen(0, res));
const PORT = (srv.address() as any).port;

console.log("Harness verification — CDP-derived bytes vs socket ground truth\n");

// ---- the journey: 3 fetches (1000/5000/20000) + 2 ws request/reply pairs ------------------
const report = await measureJourney(`http://localhost:${PORT}/`, async (page) => {
  await page.evaluate(async () => {
    for (const size of [1000, 5000, 20000]) await (await fetch(`/data?size=${size}`)).text();
    const ws = new WebSocket(`ws://${location.host}`);
    await new Promise((r) => { ws.onopen = r; });
    for (const reply of [2000, 8000]) {
      ws.send(JSON.stringify({ reply }));
      await new Promise((r) => { ws.onmessage = r; });
    }
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});

// let the sockets close so the server-side counters settle
await new Promise((r) => setTimeout(r, 300));
srv.close(); wss.close();

// The socket truth includes the navigation exchange (the report deliberately doesn't —
// journeys measure interaction), so the HTTP comparison subtracts the known page bytes.
console.log(`harness:  HTTP ${report.http.requests} req, ${fmt(report.http.bytesOut)} out / ${fmt(report.http.bytesIn)} in · WS ${report.ws.framesOut}->/${report.ws.framesIn}<- ${fmt(report.ws.bytesOut)} out / ${fmt(report.ws.bytesIn)} in`);
console.log(`sockets:  HTTP ${fmt(httpRead)} in / ${fmt(httpWritten)} out (incl. navigation) · WS ${fmt(wsRead)} in / ${fmt(wsWritten)} out\n`);

check("the journey's 3 fetches are all seen (and only them)", report.http.requests === 3, report.http.requests);
check("ws frames counted exactly: 2 sent, 2 received", report.ws.framesOut === 2 && report.ws.framesIn === 2, report.ws);

// response side: payloads are 1000+5000+20000 (+json wrapper) + headers; encodedDataLength is
// Chrome's actual wire accounting, so it must be >= payload sum and within ~1KB/req of truth
const payloadSum = [1000, 5000, 20000].reduce((a, n) => a + blob(n).length, 0);
check("HTTP bytes-in >= the known payloads (headers ride on top)", report.http.bytesIn >= payloadSum, `${report.http.bytesIn} vs ${payloadSum}`);
const truthDataWritten = httpWritten - PAGE.length;                // server wrote page + data responses (+headers)
check("HTTP bytes-in within 5% + 1KB of socket truth for the data responses",
  Math.abs(report.http.bytesIn - truthDataWritten) <= truthDataWritten * 0.05 + 1024, `${report.http.bytesIn} vs ~${truthDataWritten}`);

// ws: harness estimate (payload + RFC6455 framing) vs socket truth, minus the HTTP upgrade
// exchange (~200-400B) that rides the ws socket before frames flow
check("ws bytes-in within 5% + 1KB of socket truth", Math.abs(report.ws.bytesIn - wsWritten) <= wsWritten * 0.05 + 1024, `${report.ws.bytesIn} vs ${wsWritten}`);
check("ws bytes-out within 5% + 1KB of socket truth", Math.abs(report.ws.bytesOut - wsRead) <= wsRead * 0.05 + 1024, `${report.ws.bytesOut} vs ${wsRead}`);
check("trips = 3 http + 2 ws requests", report.trips === 5, report.trips);

console.log(ok()
  ? "\nPASS — the harness's CDP accounting matches socket ground truth within tolerance; before/after reports are trustworthy"
  : "\nFAIL");
process.exit(ok() ? 0 : 1);

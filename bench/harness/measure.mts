// The journey measurement harness — rung 1 of the corpus program (docs/corpus.md).
//
// Given a running web app and a scripted user JOURNEY (a Playwright function — existing
// Playwright/Cypress e2e tests adapt in minutes), measure the journey's real network
// behavior in a real Chromium via CDP:
//
//   HTTP   per request: encodedDataLength (actual bytes on the wire, headers included,
//          as Chrome accounts them) + our estimate of request-side bytes (request line
//          + headers + body — Chrome does not expose request wire bytes).
//   WS     per frame, both directions: payload bytes + frame overhead estimate.
//   trips  HTTP requests + client-initiated ws frames (the request half of each
//          request/response pair on a Tierless-style RPC socket).
//
// Run the same journey against the app before and after a port and diff the reports.
//
// HONESTY NOTES (also in README.md):
// - Bytes and trips are MEASURED. Wall-clock is reported raw (no throttling); latency
//   claims should be computed from (trips, bytes) under a DECLARED network model, the
//   same pattern as bench/conduit.mts — because CDP's emulateNetworkConditions does not
//   apply to websockets (long-standing Chromium limitation), so real throttling would
//   bias exactly the comparison this harness exists to make.
// - HTTP request bytes and ws frame overhead are estimates (Chrome exposes neither);
//   verify.mts checks the totals against a byte-counting server: see the tolerances there.
import { createRequire } from "node:module";

// playwright: loaded via createRequire (no @types/playwright wired into this tsconfig) — same
// resolution as test/e2e/demo.mts; chromium, browser, page are all any.
const { chromium } = createRequire(process.env.PLAYWRIGHT_REQUIRE || "/opt/node22/lib/node_modules/")("playwright");

export interface RequestRecord {
  kind: "http";
  url: string;
  method: string;
  bytesOut: number;                 // estimated: request line + headers + body
  bytesIn: number;                  // measured: encodedDataLength at loadingFinished
  tStart: number;                   // ms since journey start (negative = pre-journey)
  tEnd: number;
}
export interface WsRecord {
  kind: "ws";
  url: string;
  framesOut: number;
  framesIn: number;
  bytesOut: number;                 // payload + per-frame overhead estimate
  bytesIn: number;
  frames: { dir: "out" | "in"; t: number; bytes: number }[];   // per-frame timeline
}
export interface JourneyReport {
  http: { requests: number; bytesOut: number; bytesIn: number };
  ws: { framesOut: number; framesIn: number; bytesOut: number; bytesIn: number };
  totalBytes: number;
  trips: number;                    // HTTP requests + client-initiated ws frames
  wallMs: number;                   // raw, unthrottled — see honesty notes
  requests: RequestRecord[];
  sockets: WsRecord[];
}

// A client->server ws frame's wire cost: payload + 2..14B header; client frames are
// always masked (+4). We estimate header from payload length (RFC 6455 framing).
const wsFrameBytes = (payloadLen: number, masked: boolean): number =>
  payloadLen + 2 + (payloadLen >= 65536 ? 8 : payloadLen >= 126 ? 2 : 0) + (masked ? 4 : 0);

const headerBytes = (headers: Record<string, string>): number =>
  Object.entries(headers).reduce((a, [k, v]) => a + k.length + v.length + 4, 0);   // "k: v\r\n"

export interface MeasureOpts {
  /** Ignore requests whose URL matches (static assets, favicons, analytics). */
  ignore?: (url: string) => boolean;
  /** Also measure the initial page load (default false: journeys measure INTERACTION). */
  includeNavigation?: boolean;
  /** Runs before the initial navigation — auth setup (addInitScript with a token, cookies). */
  prepare?: (page: any) => Promise<void>;
  headless?: boolean;
}

export async function measureJourney(
  url: string,
  journey: (page: any) => Promise<void>,
  { ignore = () => false, includeNavigation = false, prepare, headless = true }: MeasureOpts = {},
): Promise<JourneyReport> {
  const browser = await chromium.launch({ headless });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");

    const reqs = new Map<string, RequestRecord>();
    const sockets = new Map<string, WsRecord>();
    let recording = includeNavigation;
    let t0 = Date.now();                                           // reset when the journey starts
    const now = (): number => Date.now() - t0;

    let redirSeq = 0;
    cdp.on("Network.requestWillBeSent", (e: any) => {
      if (!recording || ignore(e.request.url)) return;
      // CDP reuses the requestId across a redirect chain — finalize the prior leg as its
      // own record (its bytes ride redirectResponse) or every earlier leg vanishes
      if (e.redirectResponse) {
        const prev = reqs.get(e.requestId);
        if (prev) { prev.bytesIn = e.redirectResponse.encodedDataLength ?? 0; prev.tEnd = now(); reqs.set(e.requestId + "#redirect" + redirSeq++, prev); }
      }
      const body = e.request.postData ? Buffer.byteLength(e.request.postData) : 0;
      const u = new URL(e.request.url);
      reqs.set(e.requestId, {
        kind: "http", url: e.request.url, method: e.request.method,
        // the request target includes the query string on the wire
        bytesOut: Buffer.byteLength(`${e.request.method} ${u.pathname}${u.search} HTTP/1.1\r\n`) + headerBytes(e.request.headers) + 2 + body,
        bytesIn: 0,
        tStart: now(), tEnd: 0,
      });
    });
    cdp.on("Network.loadingFinished", (e: any) => {
      const r = reqs.get(e.requestId);
      if (r) { r.bytesIn = e.encodedDataLength; r.tEnd = now(); }   // actual wire bytes, headers included
    });
    cdp.on("Network.webSocketCreated", (e: any) => {
      if (ignore(e.url)) return;
      sockets.set(e.requestId, { kind: "ws", url: e.url, framesOut: 0, framesIn: 0, bytesOut: 0, bytesIn: 0, frames: [] });
    });
    cdp.on("Network.webSocketFrameSent", (e: any) => {
      const s = sockets.get(e.requestId);
      if (!s || !recording) return;
      // binary frames arrive base64-encoded in CDP; text frames as-is (same as receive)
      const len = e.response.opcode === 2 ? Buffer.from(e.response.payloadData, "base64").length : Buffer.byteLength(e.response.payloadData);
      const bytes = wsFrameBytes(len, true);
      s.framesOut++; s.bytesOut += bytes; s.frames.push({ dir: "out", t: now(), bytes });
    });
    cdp.on("Network.webSocketFrameReceived", (e: any) => {
      const s = sockets.get(e.requestId);
      if (!s || !recording) return;
      // binary frames arrive base64-encoded in CDP; text frames as-is
      const len = e.response.opcode === 2 ? Buffer.from(e.response.payloadData, "base64").length : Buffer.byteLength(e.response.payloadData);
      const bytes = wsFrameBytes(len, false);
      s.framesIn++; s.bytesIn += bytes; s.frames.push({ dir: "in", t: now(), bytes });
    });

    if (prepare) await prepare(page);
    await page.goto(url, { waitUntil: "networkidle" });
    recording = true;
    t0 = Date.now();
    await journey(page);
    const wallMs = Date.now() - t0;

    const requests = [...reqs.values()].filter((r) => r.bytesIn > 0 || r.bytesOut > 0);
    const socks = [...sockets.values()].filter((s) => s.framesOut + s.framesIn > 0);
    const http = {
      requests: requests.length,
      bytesOut: requests.reduce((a, r) => a + r.bytesOut, 0),
      bytesIn: requests.reduce((a, r) => a + r.bytesIn, 0),
    };
    const ws = {
      framesOut: socks.reduce((a, s) => a + s.framesOut, 0),
      framesIn: socks.reduce((a, s) => a + s.framesIn, 0),
      bytesOut: socks.reduce((a, s) => a + s.bytesOut, 0),
      bytesIn: socks.reduce((a, s) => a + s.bytesIn, 0),
    };
    return {
      http, ws,
      totalBytes: http.bytesOut + http.bytesIn + ws.bytesOut + ws.bytesIn,
      trips: http.requests + ws.framesOut,
      wallMs,
      requests, sockets: socks,
    };
  } finally {
    await browser.close();
  }
}

export const fmt = (n: number): string => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB");

export function printReport(label: string, r: JourneyReport): void {
  console.log(`${label}`);
  console.log(`  HTTP  ${r.http.requests} requests   ${fmt(r.http.bytesOut)} out / ${fmt(r.http.bytesIn)} in`);
  console.log(`  WS    ${r.ws.framesOut}->/${r.ws.framesIn}<- frames   ${fmt(r.ws.bytesOut)} out / ${fmt(r.ws.bytesIn)} in`);
  console.log(`  total ${fmt(r.totalBytes)} · ${r.trips} trips · ${r.wallMs} ms raw wall`);
}

/** Modeled network wait for a measured journey under a declared model — the honest way to
 *  turn (trips, bytes) into a latency claim (see honesty notes; same pattern as bench/conduit). */
export const modelWallMs = (r: JourneyReport, { rttMs = 80, bps = 10e6 } = {}): number =>
  r.trips * rttMs + (r.totalBytes * 8 / bps) * 1000;

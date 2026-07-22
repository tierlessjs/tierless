// Per-payload wire-cost decomposition for the n8n boot GETs (task: the truth arms show
// the session ws carries ~2.2x the bytes the same fetches cost stock HTTP). Three
// measurements per manifest path, same live backend:
//   http-gzip   what the stock arm pays (curl, Accept-Encoding: gzip)
//   http-raw    the uncompressed entity (identity)
//   session     TCP bytes of the exec crossing through the real gateway, counted by a
//               relay in front of :5780 (per-message delta, shared-deflate-window session)
// Plus an offline codec split on each payload: the binary graph codec's pre-deflate size
// vs the JSON text it replaces (restResources parses bodies; replies re-encode through
// the codec — the suspected inflation).
//   node ports/n8n/measure-wire-cost.mts
import { bootN8n, APP } from "./boot.mts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync, gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { delayProxy, type WireCounter } from "../latency-proxy.mts";

process.env.TIERLESS_PREBOOT = "0";   // each GET crosses individually: clean per-message deltas
const { WebSocket } = createRequire(import.meta.url)("ws");
const { makePeer, wsPort } = await import("tierless/transport");
const { execOver } = await import("tierless");
const { encodeArgs } = await import("tierless/wire");

const MANIFEST = fileURLToPath(new URL("./results/preboot-manifest.txt", import.meta.url));
const OWNER = { email: "nathan@n8n.io", password: "PlaywrightTest123", firstName: "N", lastName: "R", mfaEnabled: false };
const paths = readFileSync(MANIFEST, "utf8").split("\n").filter(Boolean).filter((p) => p !== "/rest/login");

const boot = await bootN8n();
const counter: WireCounter = { toServer: 0, toClient: 0 };
delayProxy(15780, 5780, 0, counter).unref();
try {
  // owner + cookie, the capture-manifest flow
  await fetch(APP + "/rest/e2e/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: OWNER, members: [], admin: { email: "admin@n8n.io", password: "PlaywrightTest123", firstName: "A", lastName: "D" }, chat: { email: "chat@n8n.io", password: "PlaywrightTest123" } }) });
  await new Promise((r) => setTimeout(r, 800));
  const login = await fetch(APP + "/rest/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ emailOrLdapLoginId: OWNER.email, password: OWNER.password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("no login cookie");

  // session socket through the counting relay, cookie on the upgrade (hello seals it)
  const ws = new WebSocket("ws://127.0.0.1:15780/__tierless", ["tierless"], { headers: { cookie, origin: "http://127.0.0.1:5680" } });
  await new Promise<void>((r, j) => { ws.on("open", r); ws.on("error", j); });
  const peer = makePeer(wsPort(ws as never));
  await new Promise((r) => setTimeout(r, 500));   // hello + any upgrade chatter settles

  const curl = (p: string, enc: string): number => Number(execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{size_download}", "-H", `cookie: ${cookie}`, "-H", `Accept-Encoding: ${enc}`, "--max-time", "30", APP + p]).toString().trim());

  console.log("path".padEnd(58) + "raw".padStart(9) + "gzip".padStart(9) + "session".padStart(9) + "codecPre".padStart(10) + "codecDefl".padStart(10));
  const tot = { raw: 0, gz: 0, sess: 0, pre: 0, defl: 0 };
  for (const p of paths) {
    const raw = curl(p, "identity");
    const gz = curl(p, "gzip");
    const before = counter.toServer + counter.toClient;
    let env: unknown;
    try { env = await execOver(peer, { op: "res", tier: "server", name: "api.get", args: [p] } as never); }
    catch (e) { console.log(p.padEnd(58) + " EXEC FAIL: " + (e as Error).message.slice(0, 80)); continue; }
    await new Promise((r) => setTimeout(r, 300));   // let frames flush through the relay
    const sess = counter.toServer + counter.toClient - before;
    // the codec split, offline: the envelope exactly as the reply carries it
    const encoded = encodeArgs([env]);
    const defl = deflateSync(encoded, { level: 6 }).length;   // fresh window: upper bound per message
    tot.raw += raw; tot.gz += gz; tot.sess += sess; tot.pre += encoded.length; tot.defl += defl;
    console.log(p.slice(0, 57).padEnd(58) + String(raw).padStart(9) + String(gz).padStart(9) + String(sess).padStart(9) + String(encoded.length).padStart(10) + String(defl).padStart(10));
  }
  console.log("TOTAL".padEnd(58) + String(tot.raw).padStart(9) + String(tot.gz).padStart(9) + String(tot.sess).padStart(9) + String(tot.pre).padStart(10) + String(tot.defl).padStart(10));
  console.log(`\nsession/gzip ratio: ${(tot.sess / tot.gz).toFixed(2)}  codecPre/raw: ${(tot.pre / tot.raw).toFixed(2)}  codecDefl/gzip: ${(tot.defl / tot.gz).toFixed(2)}`);
  // sanity: gzip of the raw text at level 6, for the biggest payload, vs its codec deflate
  ws.close();
} finally { boot.close(); }
process.exit(0);

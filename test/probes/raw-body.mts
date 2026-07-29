// Probe: NO UNNECESSARY SERDE on the fetch arm. A gateway used to parse every JSON
// response body and then hand it to the reply encoder, which stringified it straight
// back — 83 ms + 122 ms on an 8.9 MB reply, for bytes the gateway never inspects. Now
// handleExec asks for `raw`, restResources passes the text through as a RawJsonBody,
// and the text rides the frame's BINARY slot; execOver parses it once at the receiving
// edge — the same single parse the caller always paid when the body travelled inside
// the JSON header.
//
// The load-bearing constraint is WHERE the hint is set: only handleExec, whose reply
// goes straight out. The pump's own execHere makes continuation state, and the hello
// preboot rides a JSON message — a marker object on either path would serialize as
// data instead of the body (the trap that killed the earlier JsonText attempt).
//
// There is ONE wire protocol, not a negotiated pair: the frame carries a version and a
// skewed peer fails immediately (transport.mts PROTOCOL_VERSION). This shipped after a
// stale n8n bundle silently received bodyless envelopes from a newer gateway — the
// failure mode a compatibility branch would have preserved rather than removed.
//
// Run:  node test/probes/raw-body.mts
import { makeHost, execOver } from "tierless";
import { RawJsonBody } from "tierless/transport";
import { restResources } from "tierless/adapt";
import { createServer } from "node:http";
import type { ResourceRequest, Peer } from "../../packages/tierless/src/types.mjs";
import { makeCounter } from "../lib/check.mts";

const { check, counts } = makeCounter();
console.log("Probe: the fetch arm parses a body ONCE, at the receiving edge\n");

const payload = { rows: Array.from({ length: 500 }, (_, i) => ({ i, name: "row" + i })), nested: { deep: [1, 2, 3] } };
const payloadText = JSON.stringify(payload);

// ---- restResources honors the hint, and only the hint --------------------------------
const srv = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(payloadText); });
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + (srv.address() as { port: number }).port;
const rest = restResources(base, { envelopeErrors: true });
const rawEnv = await rest({ op: "resource", tier: "server", name: "api.get", args: ["/x"], raw: true }) as { body: unknown };
check("raw hint: the body comes back UNPARSED, as the original text", rawEnv.body instanceof RawJsonBody && (rawEnv.body as RawJsonBody).text === payloadText);
const plainEnv = await rest({ op: "resource", tier: "server", name: "api.get", args: ["/x"] } as ResourceRequest) as { body: { rows: unknown[] } };
check("no hint (pump path, preboot): the body is parsed as always", !(plainEnv.body instanceof RawJsonBody) && plainEnv.body.rows.length === 500);

// A GET carrying `data` is normal for an axios caller — XHR just drops the body — but
// fetch REJECTS such a Request. InvenTree's form layer sends `data` on every submit,
// its exports included, so the crossing threw where the stock adapter shrugged.
const getWithBody = await rest({ op: "resource", tier: "server", name: "api.get", args: ["/x", { export_format: "CSV" }] } as ResourceRequest) as { status: number };
check("a GET with a body drops it instead of throwing (XHR's own behavior)", getWithBody.status === 200);

// ---- handleExec splits it to the binary slot; execOver puts it back ------------------
const seen: ResourceRequest[] = [];
const host = makeHost({
  bundle: { PROGRAMS: {}, __unwind: () => false } as never,
  tier: "server",
  exec: async (r) => { seen.push(r as ResourceRequest); return rest(r); },
});

// the peer the browser side would talk to: hand execOver exactly what handleExec produced
const loopback = (reply: { obj: unknown; bin?: Uint8Array }): Peer => ({
  request: async () => ({ obj: reply.obj as never, bin: reply.bin ?? null }),
  on: () => {},
  close: () => {},
}) as unknown as Peer;

const { encodeArgs } = await import("tierless/wire");
const replied = await host.handleExec({ type: "exec", tier: "server" }, encodeArgs(["api.get", ["/x"]]));
check("handleExec asks the exec for a raw body", seen[0]?.raw === true);
check("the reply's JSON header carries NO body (it is not re-serialized there)", !/"body"/.test(JSON.stringify(replied.obj)) && (replied.obj as { rawBody?: boolean }).rawBody === true, JSON.stringify(replied.obj).slice(0, 120));
check("the body rides the frame's binary slot as the original text", !!replied.bin && new TextDecoder().decode(replied.bin) === payloadText);
check("the header stays small — the whole point (bytes: header vs body)", JSON.stringify(replied.obj).length < 200 && replied.bin!.length > 10_000, JSON.stringify({ header: JSON.stringify(replied.obj).length, bin: replied.bin!.length }));

const roundTripped = await execOver(loopback(replied), { op: "resource", tier: "server", name: "api.get", args: ["/x"] }) as { body: { rows: unknown[]; }; status: number };
check("execOver reassembles it into exactly the value the caller always got", roundTripped.status === 200 && JSON.stringify(roundTripped.body) === payloadText);

srv.close();

// ---- version skew FAILS, loudly and immediately --------------------------------------
// The only defence a single-protocol design needs: a peer built against another version
// cannot exchange a frame at all, and the error names the fault instead of reading as a
// codec bug. (A stale bundle silently receiving bodyless envelopes is what this replaced.)
{
  const { encodeMessage, decodeMessage, PROTOCOL_VERSION } = await import("tierless/transport");
  const good = encodeMessage({ kind: "reply", id: 1, payload: { ok: true } });
  check("a same-version frame round-trips", (decodeMessage(good).obj as { payload: { ok: boolean } }).payload.ok === true);
  const skewed = good.slice();
  skewed[3] = (skewed[3] + 1) & 0xff;                       // the version byte of the frame magic
  let err = "";
  try { decodeMessage(skewed); } catch (e) { err = String((e as Error).message); }
  check("a version-skewed frame is refused, naming both versions and the fix", /wire protocol mismatch/.test(err) && err.includes("v" + PROTOCOL_VERSION) && /rebuild the client/.test(err), err);
  let err2 = "";
  try { decodeMessage(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 1, 0, 0, 0, 0, 123])); } catch (e) { err2 = String((e as Error).message); }
  check("a non-tierless frame is refused too", /wire protocol mismatch/.test(err2));
}

// ---- a malformed upstream body fails at the edge, and says where ---------------------
const bad = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end("{not json"); });
await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
const badBase = "http://127.0.0.1:" + (bad.address() as { port: number }).port;
const badHost = makeHost({ bundle: { PROGRAMS: {}, __unwind: () => false } as never, tier: "server", exec: restResources(badBase, { envelopeErrors: true }) });
const badReply = await badHost.handleExec({ type: "exec", tier: "server" }, encodeArgs(["api.get", ["/broken"]]));
let msg = "";
try { await execOver(loopback(badReply), { op: "resource", tier: "server", name: "api.get", args: ["/broken"] }); }
catch (e) { msg = String((e as Error).message); }
check("malformed upstream JSON throws at the edge, naming the path", /malformed JSON body from \/broken/.test(msg), msg);
bad.close();

const { pass, fail } = counts();
console.log(fail === 0
  ? `\nOK — the fetch arm does no redundant serde: the gateway passes JSON text through untouched, it rides the binary slot, and the receiving edge parses it once (${pass} checks)`
  : `\nFAIL (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

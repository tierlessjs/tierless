// The many-small-requests comparison for n8n, measured rather than inferred.
//
// Baseline pays small /rest/* calls as individual HTTP requests: a request line, a full
// header block (cookies, UA, accept) and a compressed body, per call. The ported arm
// carries them as frames on one deflate-compressed session. With the browse advisory in
// place the >1 MB catalogue is back on browser HTTP, so the session's TCP-true counter
// (wireWs*) contains ONLY these small calls — which is what makes the comparison
// possible at all: per-message compressed sizes are unobservable through a shared
// deflate window, so while the catalogue rode the socket its 99.1% share of the
// plaintext could not be separated out.
//
//   node ports/n8n/report-smallslice.mts
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readJsonl } from "../read-jsonl.mts";

const DIR = fileURLToPath(new URL("./results/smallslice/", import.meta.url));
interface Hit { path: string; status: number; respBytes: number; reqBytes: number }
interface Row { status: string; retry: number; wireWsIn?: number; wireWsOut?: number; wireApiIn?: number; wireApiOut?: number; wireError?: boolean }

const need = ["baseline-measure.jsonl", "ported-measure.jsonl", "baseline-http.jsonl.gz"];
for (const f of need) if (!existsSync(DIR + f)) { console.error(`missing ${f} — run ports/n8n/drive-smallslice.sh`); process.exit(1); }

const BULK = 1e6;
const small = (r: Hit): boolean => r.path.startsWith("/rest/") && r.respBytes < BULK;

const bh = readJsonl<Hit>(DIR + "baseline-http.jsonl");
let bBytes = 0, bReq = 0, bHdr = 0, bBody = 0;
for (const r of bh) if (small(r)) { bBytes += (r.respBytes || 0) + (r.reqBytes || 0); bReq++; bHdr += r.reqBytes || 0; bBody += r.respBytes || 0; }

// ported: the session counter PLUS the small calls that stayed on browser HTTP.
// Counting only the session compares baseline's whole small-API against a fraction of
// the ported one — 592 of n8n's small /rest/* calls never cross (force-browser seam,
// mocked routes), worth 1.74 MB, and omitting them overstated the win by 14 points.
const pm = readJsonl<Row>(DIR + "ported-measure.jsonl").filter((r) => r.retry === 0 && !r.wireError);
const pWs = pm.reduce((a, r) => a + (r.wireWsIn || 0) + (r.wireWsOut || 0), 0);
const phits = readJsonl<Hit>(DIR + "ported-http.jsonl");
let pHttp = 0, pHttpN = 0;
for (const r of phits) if (small(r)) { pHttp += (r.respBytes || 0) + (r.reqBytes || 0); pHttpN++; }
const pTotal = pWs + pHttp;
// crossings + browser-HTTP small calls: the ported arm's total small-API call count
const sess = existsSync(DIR + "ported-session.jsonl.gz") || existsSync(DIR + "ported-session.jsonl")
  ? readJsonl<{ d?: string; t?: string; ph?: string }>(DIR + "ported-session.jsonl") : [];
const pCalls = sess.filter((r) => !r.ph && r.d === "in" && r.t === "exec").length + pHttpN;

// guard: if a >1 MB payload still crossed, the counter is contaminated and the number is void
let bulkFrames = 0;
if (existsSync(DIR + "ported-session.jsonl.gz") || existsSync(DIR + "ported-session.jsonl")) {
  for (const r of readJsonl<{ n?: number; ph?: string }>(DIR + "ported-session.jsonl")) if (!r.ph && (r.n ?? 0) > BULK) bulkFrames++;
}

const MB = (n: number): string => (n / 1e6).toFixed(2) + " MB";
console.log("n8n many-small slice — editor chunk, budget mode, advisory ON\n");
console.log(`  baseline, small /rest/* over HTTP   ${MB(bBytes)}  in ${bReq} requests`);
console.log(`    of which request headers          ${MB(bHdr)}  (${(100 * bHdr / bBytes).toFixed(1)}% — the overhead a socket removes outright)`);
console.log(`    of which response bodies          ${MB(bBody)}`);
console.log(`  ported, same traffic:                 ${MB(pTotal)}`);
console.log(`    over the session                    ${MB(pWs)}  (TCP-true, deflate included)`);
console.log(`    still on browser HTTP               ${MB(pHttp)}  in ${pHttpN} requests`);
console.log(`\n  CALL COUNTS: baseline ${bReq}, ported ${pCalls} — the ported arm makes ${(100 * (1 - pCalls / bReq)).toFixed(0)}% FEWER`);
console.log(`  small-API calls (conditional crossings serve repeats from the session's own`);
console.log(`  cache). So this delta is call ELIMINATION plus per-call cost, not per-call alone.`);
const delta = (pTotal - bBytes) / bBytes;
if (bulkFrames > 0) {
  // The advisory is LEARNED: it is declared in hellos AFTER the first oversize reply,
  // so sessions opening inside that window still carry the payload. Measured here as 5
  // crossings in the run's first 13 seconds. They only ADD to the session's bytes, so
  // the delta below is a conservative BOUND, not a void result: the true small-slice
  // cost is strictly lower and the true win strictly larger.
  console.log(`\n  ${bulkFrames} oversize frames crossed before the advisory was learned — they inflate`);
  console.log(`  the ported side only, so this is a BOUND:`);
  console.log(`\n  many-small delta: AT LEAST ${(100 * -delta).toFixed(1)}% cheaper on the session`);
  console.log(`  (true figure better; a pre-seeded advisory would measure it exactly)`);
} else {
  console.log(`\n  many-small delta: ${(100 * delta).toFixed(1)}%  (${delta < 0 ? "session cheaper" : "session dearer"})`);
}
console.log("\nThis is the number the request-shape predictor is about: docs/corpus.md claims a");
console.log("session wins where traffic is many small responses, because per-request overhead");
console.log("disappears and bodies compress against a shared window. The suite-wide byte");
console.log("headline cannot show it — this slice is ~46 MB of n8n's 934 MB marginal.");

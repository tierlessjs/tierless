// MARGINAL BYTES — the byte headline a real session would see, not the harness's.
//
// A Playwright suite gives every test a fresh context, so each test re-downloads the
// app's bundles, fonts and icons from cold. A real user pays that once and then talks
// API for hours. Suite-total bytes therefore SYSTEMATICALLY understate what a transport
// can reach: on grafana the session carried 13.4 MB of 3.9 GB (0.34%), almost all of the
// rest being the same bundles fetched hundreds of times.
//
// This report re-derives the comparison over the bytes a WARM browser cache would still
// have to fetch:
//
//     marginal = total − (repeat fetches a real cache would serve for free)
//
// A response counts as cache-eliminable when the same (method, path, status, respBytes)
// tuple was already seen in this run AND the path is a static asset by shape
// (content-hashed filename or a static extension). Requiring identical BYTE COUNT is the
// conservative part: a path whose body varies between fetches is never eliminated.
//
// ONLY assets get eliminated, and that restriction is load-bearing for the COMPARISON:
// the ported arm's addressable traffic left HTTP for the socket, where this log cannot
// see it, so repeats inside it cannot be elided symmetrically. Assets never cross the
// session, so eliding them touches both arms the same way. Eliding repeated API
// responses too would subtract from the baseline what the ported arm still pays in full
// — a nonsense delta. The non-asset repeat volume is printed as a BASELINE-ONLY
// diagnostic, never as an arm comparison.
//
// Data-shaped payloads with stable URLs (n8n's /types/nodes.json, a 12 MB catalogue)
// are deliberately NOT counted as assets: without cache headers in the log we cannot
// prove a real browser would reuse them. They stay in marginal for both arms, so the
// ratio is unaffected and the marginal totals are, if anything, conservative.
//
// Both arms are measured by the same instrument (ports/http-log-proxy.mts: HTTP-message
// bytes behind the counting relay), so the RATIO is sound even though these are not TCP
// bytes. The ported arm's session traffic never appears in an HTTP log — it rides the
// socket — so it is added back from the measure rows' TCP-true wireWs* counters.
//
//   node ports/report-marginal.mts <results-dir>
// e.g. node ports/report-marginal.mts ports/n8n/results/remeasure
import { readdirSync } from "node:fs";
import { readJsonl, jsonlNames } from "./read-jsonl.mts";

const DIR = process.argv[2];
if (!DIR) { console.error("usage: node ports/report-marginal.mts <results-dir>"); process.exit(2); }
const dir = DIR.endsWith("/") ? DIR : DIR + "/";

interface Hit { method: string; path: string; status: number; respBytes: number; reqBytes: number }
interface Row { status: string; retry: number; wireWsIn?: number; wireWsOut?: number; wireError?: boolean }

// A path whose content is addressed by its own hash (or a fingerprinted static asset)
// cannot change under its URL: a warm cache serves every repeat for free.
const STATIC_EXT = /\.(js|mjs|cjs|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|ico|map)(\?|$)/i;
const HASHED = /[-.][A-Za-z0-9_-]{8,}\.(js|mjs|css|woff2?)(\?|$)/;
const isAsset = (p: string): boolean => STATIC_EXT.test(p) || HASHED.test(p);

function analyze(files: string[]): { total: number; assetRepeat: number; anyRepeat: number; n: number } {
  const seen = new Map<string, number>();          // key -> times seen
  let total = 0, assetRepeat = 0, anyRepeat = 0, n = 0;
  for (const f of files) {
    for (const r of readJsonl<Hit>(dir + f)) {
      const bytes = (r.respBytes || 0) + (r.reqBytes || 0);
      total += bytes; n++;
      const key = `${r.method} ${r.path} ${r.status} ${r.respBytes}`;
      const before = seen.get(key) ?? 0;
      seen.set(key, before + 1);
      if (before > 0) {
        anyRepeat += bytes;
        if (isAsset(r.path)) assetRepeat += bytes;
      }
    }
  }
  return { total, assetRepeat, anyRepeat, n };
}

/** TCP-true session bytes for an arm, from the measure rows the reporter chained. */
function sessionBytes(files: string[]): number {
  let ws = 0;
  for (const f of files) {
    for (const r of readJsonl<Row>(dir + f)) {
      if (r.retry !== 0 || r.wireError) continue;
      ws += (r.wireWsIn || 0) + (r.wireWsOut || 0);
    }
  }
  return ws;
}

const all = readdirSync(dir);
const httpFiles = (arm: string) => jsonlNames(all, "-http.jsonl").filter((f) => f.startsWith(arm + "-"));
const measureFiles = (arm: string) => jsonlNames(all, "-measure.jsonl").filter((f) => f.startsWith(arm + "-"))
  .concat(jsonlNames(all, "-measure-truth.jsonl").filter((f) => f.startsWith(arm + "-")));

const B = analyze(httpFiles("baseline")), P = analyze(httpFiles("ported"));
const bWs = sessionBytes(measureFiles("baseline")), pWs = sessionBytes(measureFiles("ported"));
if (!B.n || !P.n) { console.error(`no -http.jsonl logs for both arms in ${dir}`); process.exit(1); }

const MB = (n: number): string => (n / 1e6).toFixed(0).padStart(6) + " MB";
const pct = (b: number, p: number): string => ((p - b) / b * 100).toFixed(1).padStart(6) + "%";

const bTotal = B.total + bWs, pTotal = P.total + pWs;
const bMarg = B.total - B.assetRepeat + bWs, pMarg = P.total - P.assetRepeat + pWs;

console.log(`${dir}   ${B.n} baseline requests, ${P.n} ported\n`);
console.log("                                   baseline      ported     delta");
console.log(`  suite total (what we publish)   ${MB(bTotal)}   ${MB(pTotal)}   ${pct(bTotal, pTotal)}`);
console.log(`  marginal, warm asset cache      ${MB(bMarg)}   ${MB(pMarg)}   ${pct(bMarg, pMarg)}`);
console.log(`\n  repeat asset bytes elided:      baseline ${MB(B.assetRepeat)}   ported ${MB(P.assetRepeat)}`);
console.log(`  (diagnostic, NOT an arm delta)  baseline non-asset repeats ${MB(B.anyRepeat - B.assetRepeat)}`);
console.log(`\n  session carried (ported):       ${MB(pWs)}  = ${(100 * pWs / pTotal).toFixed(2)}% of suite total, ${(100 * pWs / pMarg).toFixed(2)}% of MARGINAL`);

// the decomposition's own consistency check: byte win ~= addressable share x per-slice win
const addressable = pWs / pMarg;
const measured = (pMarg - bMarg) / bMarg;
console.log(`\n  decomposition: addressable ${(100 * addressable).toFixed(1)}% x per-slice win ${(100 * -measured / addressable).toFixed(1)}% = ${(100 * measured).toFixed(1)}% measured`);
console.log("\nread: the suite-total row is diluted by bundles a real session downloads ONCE.");
console.log("The marginal row is the transport-relevant comparison; the session share is the");
console.log("ceiling on any byte win (docs/corpus.md, 'What a byte headline actually reports').");

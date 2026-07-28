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
// A repeat is elidable when BOTH hold:
//
//   1. STATIC BY EVIDENCE — every fetch of that path in the run returned the same byte
//      count. Not a guess from the file extension: n8n serves /types/nodes.json, a
//      12 MB catalogue, as a static file with no extension hint that it never varies,
//      while a dynamic endpoint's size moves between calls. Identical bytes on every
//      one of 694 fetches IS the evidence.
//
//   2. ON HTTP IN BOTH ARMS — the path was not moved onto the session by the port.
//      This is what keeps the comparison honest: the ported arm's addressable traffic
//      left HTTP for the socket, where this log cannot see it, so repeats inside it
//      cannot be elided symmetrically. Eliding a path the baseline fetches over HTTP
//      but the ported arm carries over the socket would subtract from one arm what the
//      other still pays in full. n8n's /rest/community-node-types is exactly that case
//      and stays counted at full price on both sides.
//
// Rule 1 subsumes the asset shapes (bundles, fonts, icons all repeat byte-identically)
// and also catches static DATA — which was the point: n8n's marginal was 53% two static
// /types/*.json catalogues that are byte-identical in both arms.
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

// Content-hashed bundle names differ BETWEEN BUILDS (baseline's
// ParameterInputList-5alCjoJ5.js is ported's ParameterInputList-_jA7ScSj.js), so the
// two arms must be compared on the hash-stripped name or rule 2 rejects every bundle —
// exactly the traffic it is meant to elide.
const stem = (p: string): string => p.split("?")[0];
const unhashed = (p: string): string => stem(p).replace(/-[A-Za-z0-9_-]{8,}(\.[a-z0-9]+)$/i, "-*$1");

/** Per-path evidence for one arm: distinct 2xx body sizes. Non-2xx is ignored — one
 *  stray 401 on n8n's /types/nodes.json otherwise gave the path "two sizes" and
 *  disqualified a 12 MB catalogue fetched identically 694 times. */
function survey(files: string[]): { exact: Map<string, Set<number>>; seenUnhashed: Set<string> } {
  const exact = new Map<string, Set<number>>();
  const seenUnhashed = new Set<string>();
  for (const f of files) {
    for (const r of readJsonl<Hit>(dir + f)) {
      if (r.status < 200 || r.status >= 300) continue;
      let e = exact.get(stem(r.path));
      if (!e) exact.set(stem(r.path), (e = new Set()));
      e.add(r.respBytes || 0);
      seenUnhashed.add(unhashed(r.path));
    }
  }
  return { exact, seenUnhashed };
}

function analyze(files: string[], elidable: (p: string) => boolean): { total: number; repeat: number; n: number; byPath: Map<string, number> } {
  const seen = new Set<string>();
  const byPath = new Map<string, number>();
  let total = 0, repeat = 0, n = 0;
  for (const f of files) {
    for (const r of readJsonl<Hit>(dir + f)) {
      const bytes = (r.respBytes || 0) + (r.reqBytes || 0);
      total += bytes; n++;
      const key = `${r.method} ${r.path} ${r.status} ${r.respBytes}`;
      const dup = seen.has(key);
      seen.add(key);
      if (dup && elidable(stem(r.path))) { repeat += bytes; continue; }
      byPath.set(stem(r.path), (byPath.get(stem(r.path)) ?? 0) + bytes);
    }
  }
  return { total, repeat, n, byPath };
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

const bS = survey(httpFiles("baseline")), pS = survey(httpFiles("ported"));
if (!bS.exact.size || !pS.exact.size) { console.error(`no -http.jsonl logs for both arms in ${dir}`); process.exit(1); }

// rule 1 on the EXACT path (distinct chunks sharing a basename prefix are different
// files: /assets/src-XWsjz-dU.js and /assets/src-CeRFmSp9.js must be judged apart),
// rule 2 on the hash-stripped name (the same chunk is renamed between builds).
// "same size" allows 1% spread: an on-the-fly compressor is not byte-deterministic —
// n8n's /types/nodes.json came back at 1456264 B on 677 of 694 fetches and 1456842 B on
// 16 (0.04%), which is brotli variance on one unchanging file, not changing content.
// A genuinely dynamic endpoint moves far more than 1% across 694 calls.
const STATIC_SPREAD = 0.01;
const tight = (sizes: Set<number>): boolean => {
  const a = [...sizes];
  if (a.length === 1) return true;
  const lo = Math.min(...a), hi = Math.max(...a);
  return hi > 0 && (hi - lo) / hi <= STATIC_SPREAD;
};
const elidable = (exact: string): boolean => {
  const sizes = bS.exact.get(exact) ?? pS.exact.get(exact);
  if (!sizes || !tight(sizes)) return false;
  const u = unhashed(exact);
  return bS.seenUnhashed.has(u) && pS.seenUnhashed.has(u);
};

const B = analyze(httpFiles("baseline"), elidable), P = analyze(httpFiles("ported"), elidable);
const bWs = sessionBytes(measureFiles("baseline")), pWs = sessionBytes(measureFiles("ported"));

const MB = (n: number): string => (n / 1e6).toFixed(0).padStart(6) + " MB";
const pct = (b: number, p: number): string => ((p - b) / b * 100).toFixed(1).padStart(6) + "%";

const bTotal = B.total + bWs, pTotal = P.total + pWs;
const bMarg = B.total - B.repeat + bWs, pMarg = P.total - P.repeat + pWs;

console.log(`${dir}   ${B.n} baseline requests, ${P.n} ported\n`);
console.log("                                   baseline      ported     delta");
console.log(`  suite total (what we publish)   ${MB(bTotal)}   ${MB(pTotal)}   ${pct(bTotal, pTotal)}`);
console.log(`  marginal (warm cache)           ${MB(bMarg)}   ${MB(pMarg)}   ${pct(bMarg, pMarg)}`);
console.log(`  elided as static repeats        ${MB(B.repeat)}   ${MB(P.repeat)}`);
console.log(`\n  session carried (ported):       ${MB(pWs)}  = ${(100 * pWs / pTotal).toFixed(2)}% of suite total, ${(100 * pWs / pMarg).toFixed(2)}% of MARGINAL`);

const addressable = pWs / pMarg, measured = (pMarg - bMarg) / bMarg;
console.log(`  decomposition: addressable ${(100 * addressable).toFixed(1)}% x per-slice ${(100 * -measured / addressable).toFixed(1)}% = ${(100 * measured).toFixed(1)}% measured`);

// A path that is static BY THE SAME EVIDENCE but was moved onto the session keeps its
// repeats above only because the session counter is one number, not a per-path log:
// eliding them on the baseline side alone would flatter the port. Size the effect so
// the marginal row cannot be read as if it were free of it.
let movedStatic = 0; const movedPaths: [string, number][] = [];
for (const [p, v] of B.byPath) {
  const sizes = bS.exact.get(p);
  if (!sizes || !tight(sizes)) continue;            // genuinely varying: not cacheable
  if (pS.seenUnhashed.has(unhashed(p))) continue;   // still on HTTP in both arms
  movedStatic += v; movedPaths.push([p, v]);
}
if (movedStatic > 0) {
  console.log(`\n  STATIC BUT MOVED TO THE SESSION — repeats NOT elided (see header):`);
  for (const [p, v] of movedPaths.sort((a, b) => b[1] - a[1]).slice(0, 4)) console.log(`    ${MB(v)}  ${(100 * v / bMarg).toFixed(1).padStart(5)}% of baseline marginal  ${p.slice(0, 52)}`);
  console.log(`    a warm cache would fetch these ONCE in BOTH arms. Excluding them entirely:`);
  console.log(`      baseline marginal without them  ${MB(bMarg - movedStatic)}`);
  console.log(`      ported equivalent               NOT DERIVABLE — session bytes are a single`);
  console.log(`      counter; per-path session logs (TIERLESS_WIRE_LOG) are needed to split them.`);
  console.log(`    That residual is the many-small-requests slice, i.e. the number that would`);
  console.log(`    actually test the request-shape model. It is not measured yet.`);
}

// auditability: what survived the elision, and what was thrown away
const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
console.log("\n  what remains in baseline marginal (top paths):");
for (const [p, v] of top(B.byPath, 8)) console.log(`    ${MB(v)}  ${(100 * v / bMarg).toFixed(1).padStart(5)}%  ${p.slice(0, 62)}`);
console.log("  what remains in ported marginal HTTP (top paths):");
for (const [p, v] of top(P.byPath, 5)) console.log(`    ${MB(v)}  ${(100 * v / pMarg).toFixed(1).padStart(5)}%  ${p.slice(0, 62)}`);
console.log("\nread: static repeats (bundles AND static data) are elided only where the path stays");
console.log("on HTTP in both arms; a path the port moved onto the session keeps its full price on");
console.log("both sides. The session share is the ceiling on any byte win (docs/corpus.md).");

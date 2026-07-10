// Join two TIERLESS_MEASURE_OUT runs of the SAME suite — baseline (stock + measurement
// patches) vs ported — into the per-test improvement distribution. This is the corpus
// program's benchmark unit (docs/corpus.md): the app's own e2e suite is the workload,
// so the distribution is over interactions the app's authors considered worth testing,
// not over journeys we picked.
//
//   node ports/report.mts <baseline.jsonl> <ported.jsonl>
//
// Rules (stated in the output, enforced here):
//   - Pairing is by test id (file:line › title path). Tests present in only one run
//     are listed, never silently dropped.
//   - Pass-parity gate: a pair counts only if BOTH attempts passed. Pairs failing it
//     are listed with both statuses — a port that breaks a test doesn't get to keep
//     its bytes number.
//   - Retries: only retry 0 counts (a retried attempt re-navigates and double-counts
//     wire traffic); retried tests are reported.
//   - Bytes = HTTP wire bytes (headers included) + ws payload + RFC 6455 framing,
//     data-path origins only. Trips = HTTP requests + ws request/response crossings
//     (framesOut, a send that gets replies is one trip out). Wall time is NOT measured
//     or reported — latency is a modeled quantity elsewhere, never a suite claim.
import { readFileSync } from "node:fs";

interface Rec {
  id: string; status: string; retry: number;
  durationMs?: number;                // wall clock; meaningful only under injected RTT
  requests: number; httpBytes: number;
  wsFramesOut: number; wsFramesIn: number; wsBytesOut: number; wsBytesIn: number;
  // TCP-true counters (TIERLESS_WIRE_TRUTH runs) — deflate included; the byte
  // measurement of record when present (CDP reports ws frames post-inflate)
  wireWsIn?: number; wireWsOut?: number; wireApiIn?: number; wireApiOut?: number;
  wireError?: boolean;   // a counter endpoint failed around this attempt — its deltas would be garbage
}

const [baseFile, portFile] = process.argv.slice(2);
if (!baseFile || !portFile) { console.error("usage: node ports/report.mts <baseline.jsonl> <ported.jsonl>"); process.exit(2); }

function load(file: string): Map<string, Rec> {
  const out = new Map<string, Rec>();
  const retried: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const r: Rec = JSON.parse(line);
    if (r.retry > 0) { retried.push(r.id); continue; }   // attempt 0 only
    out.set(r.id, r);
  }
  if (retried.length) console.log(`note: ${file} had ${retried.length} retried attempt(s), ignored`);
  return out;
}

const hasWire = (r: Rec): boolean => r.wireApiIn !== undefined;
const bytes = (r: Rec): number => hasWire(r)
  ? (r.wireApiIn! + r.wireApiOut! + r.wireWsIn! + r.wireWsOut!)
  : r.httpBytes + r.wsBytesOut + r.wsBytesIn;
const trips = (r: Rec): number => r.requests + r.wsFramesOut;
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const pct = (before: number, after: number): string => before === 0 ? "n/a" : `${(100 * (before - after) / before).toFixed(0)}%`;
// median of per-test savings fractions (0 when the test had no baseline traffic)
const medianSaved = (ps: { b: Rec; p: Rec }[], f: (r: Rec) => number): string =>
  `${(100 * median(ps.map(({ b, p }) => f(b) === 0 ? 0 : (f(b) - f(p)) / f(b)))).toFixed(0)}%`;

const base = load(baseFile);
const port = load(portFile);

const onlyBase = [...base.keys()].filter((id) => !port.has(id));
const onlyPort = [...port.keys()].filter((id) => !base.has(id));
const allPairs = [...base.keys()].filter((id) => port.has(id)).map((id) => ({ id, b: base.get(id)!, p: port.get(id)! }));
// a row whose counter read failed carries no valid deltas — the pair is excluded rather
// than polluting totals (the reporter flags it instead of shipping wrong numbers)
const wireDropped = allPairs.filter(({ b, p }) => b.wireError || p.wireError);
const pairs = allPairs.filter(({ b, p }) => !b.wireError && !p.wireError);
if (wireDropped.length) console.log(`wire-counter failure EXCLUDED (${wireDropped.length}): ${wireDropped.slice(0, 5).map(({ id }) => id).join("; ")}${wireDropped.length > 5 ? " …" : ""}`);

const parityFail = pairs.filter(({ b, p }) => b.status !== "passed" || p.status !== "passed");
const counted = pairs.filter(({ b, p }) => b.status === "passed" && p.status === "passed");
// a pair is COVERED if the ported run actually used the session socket — the port
// touched this interaction. Uncovered pairs measure noise, not the port.
const covered = counted.filter(({ p }) => p.wsFramesOut > 0);

console.log(`\npaired ${pairs.length} tests (${base.size} baseline, ${port.size} ported)`);
const wireTrue = pairs.length > 0 && pairs.every(({ b, p }) => hasWire(b) && hasWire(p));
console.log(wireTrue
  ? "bytes are TCP-TRUE (socket-level, compression included; browser data path only — node-side seeding excluded)"
  : "bytes are CDP-level (ws frames counted post-inflate — OVERSTATES a deflate-compressed arm's wire bytes)");
if (onlyBase.length) console.log(`  only in baseline (${onlyBase.length}): ${onlyBase.slice(0, 5).join("; ")}${onlyBase.length > 5 ? " …" : ""}`);
if (onlyPort.length) console.log(`  only in ported (${onlyPort.length}): ${onlyPort.slice(0, 5).join("; ")}${onlyPort.length > 5 ? " …" : ""}`);
if (parityFail.length) {
  console.log(`\npass-parity EXCLUDED (${parityFail.length}) — status baseline/ported:`);
  for (const { id, b, p } of parityFail) console.log(`  ${b.status}/${p.status}  ${id}`);
}

const sum = (xs: number[]): number => xs.reduce((a, x) => a + x, 0);
const totB = sum(counted.map(({ b }) => bytes(b))), totP = sum(counted.map(({ p }) => bytes(p)));
const trpB = sum(counted.map(({ b }) => trips(b))), trpP = sum(counted.map(({ p }) => trips(p)));

console.log(`\n== suite-wide (${counted.length} pass-parity pairs; ${covered.length} touch the port) ==`);
console.log(`  total bytes   ${(totB / 1024).toFixed(1)} KB -> ${(totP / 1024).toFixed(1)} KB   (${pct(totB, totP)} less IO)`);
console.log(`  total trips   ${trpB} -> ${trpP}   (${pct(trpB, trpP)} fewer)`);
console.log(`  median per-test bytes saved   ${medianSaved(counted, bytes)}`);

// timing is asserted only when BOTH arms measured under the same conditions worth
// asserting — i.e. an injected-RTT run where durationMs reflects network wait, not
// localhost noise. The suite driver only produces paired -rtt<N> files, so presence
// of durationMs on both sides is that signal.
if (counted.length && counted.every(({ b, p }) => b.durationMs !== undefined && p.durationMs !== undefined)) {
  const db = sum(counted.map(({ b }) => b.durationMs!)), dp = sum(counted.map(({ p }) => p.durationMs!));
  console.log(`\n== elapsed time (real, wall clock of each test; compare only same-RTT runs) ==`);
  console.log(`  total   ${(db / 60000).toFixed(1)} min -> ${(dp / 60000).toFixed(1)} min   (${pct(db, dp)} less)`);
  console.log(`  median per-test time saved   ${medianSaved(counted, (r) => r.durationMs!)}`);
  if (covered.length) {
    const cdb = sum(covered.map(({ b }) => b.durationMs!)), cdp = sum(covered.map(({ p }) => p.durationMs!));
    console.log(`  covered subset: total ${(cdb / 60000).toFixed(1)} -> ${(cdp / 60000).toFixed(1)} min (${pct(cdb, cdp)} less), median per-test ${medianSaved(covered, (r) => r.durationMs!)} less`);
  }
}

if (covered.length) {
  const cb = sum(covered.map(({ b }) => bytes(b))), cp = sum(covered.map(({ p }) => bytes(p)));
  const ctb = sum(covered.map(({ b }) => trips(b))), ctp = sum(covered.map(({ p }) => trips(p)));
  console.log(`\n== covered subset (${covered.length} tests whose interaction the port serves) ==`);
  console.log(`  total bytes   ${(cb / 1024).toFixed(1)} KB -> ${(cp / 1024).toFixed(1)} KB   (${pct(cb, cp)} less IO)`);
  console.log(`  total trips   ${ctb} -> ${ctp}   (${pct(ctb, ctp)} fewer)`);
  console.log(`  median per-test: bytes ${medianSaved(covered, bytes)} less, trips ${medianSaved(covered, trips)} fewer`);
  console.log(`\n  per-test detail (bytes before -> after · trips before -> after):`);
  for (const { id, b, p } of [...covered].sort((x, y) => (bytes(x.b) - bytes(x.p)) < (bytes(y.b) - bytes(y.p)) ? 1 : -1)) {
    console.log(`    ${(bytes(b) / 1024).toFixed(1)} -> ${(bytes(p) / 1024).toFixed(1)} KB · ${trips(b)} -> ${trips(p)}  ${id.slice(0, 100)}`);
  }
}

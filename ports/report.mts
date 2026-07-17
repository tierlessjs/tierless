// Join TIERLESS_MEASURE_OUT runs of the SAME suite — baseline (stock + measurement
// patches) vs ported — into the per-test improvement distribution. This is the corpus
// program's benchmark unit (docs/corpus.md): the app's own e2e suite is the workload,
// so the distribution is over interactions the app's authors considered worth testing,
// not over journeys we picked.
//
//   node ports/report.mts <baseline.jsonl[,run2,…]> <ported.jsonl[,run2,…]>
//        [--floor-baseline <files>] [--floor-ported <files>]
//
// Rules (stated in the output, enforced here):
//   - Pairing is by test id (file:line › title path). Tests present in only one run
//     are listed, never silently dropped.
//   - Pass-parity gate: a pair counts only if EVERY run of both arms passed. Pairs
//     failing it are listed with their statuses — a port that breaks a test doesn't
//     get to keep its bytes number, and a flaky test doesn't get to vote.
//   - Retries: only retry 0 counts (a retried attempt re-navigates and double-counts
//     wire traffic); retried tests are reported.
//   - Multiple runs per arm: every per-test metric is the MEDIAN across that arm's
//     runs. Single runs on request-heavy tests swing by seconds (ports/vikunja,
//     2026-07-17) — one run is accepted but the report says so.
//   - Bytes = HTTP wire bytes (headers included) + ws payload + RFC 6455 framing,
//     data-path origins only. Trips = HTTP requests + ws request/response crossings
//     (framesOut, a send that gets replies is one trip out).
//   - Network-wait decomposition (only with --floor-* flags): wait = median RTT-run
//     duration minus median floor duration, and ONLY for tests whose REQUEST COUNT is
//     latency-stable per arm. A workload that changes with timing (vikunja's
//     comment-pagination: 117 stock requests at 0 ms, 15 at RTT 20) makes the
//     subtraction compare different workloads — those tests are listed, not counted.
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
interface Agg { id: string; statuses: string[]; recs: Rec[] }   // one per test, recs = one per run (passed runs only)

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && (i === 0 || args[i - 1] !== "--floor-baseline") && args[i - 1] !== "--floor-ported");
const [baseSpec, portSpec] = positional;
if (!baseSpec || !portSpec) { console.error("usage: node ports/report.mts <baseline.jsonl[,…]> <ported.jsonl[,…]> [--floor-baseline <files>] [--floor-ported <files>]"); process.exit(2); }

function loadRun(file: string): Map<string, Rec> {
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
// an arm = one or more runs; a test aggregates its per-run rows. Present = in EVERY run
// (a test missing from one run can't produce a median on that arm's conditions).
function loadArm(spec: string): { runs: number; tests: Map<string, Agg> } {
  const files = spec.split(",").filter(Boolean);
  const runs = files.map(loadRun);
  const tests = new Map<string, Agg>();
  for (const id of runs[0].keys()) {
    const rows = runs.map((m) => m.get(id)).filter((r): r is Rec => !!r);
    if (rows.length !== runs.length) continue;
    tests.set(id, { id, statuses: rows.map((r) => r.status), recs: rows });
  }
  return { runs: files.length, tests };
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const med = (a: Agg, f: (r: Rec) => number): number => median(a.recs.map(f));
const hasWire = (r: Rec): boolean => r.wireApiIn !== undefined;
const bytesOf = (r: Rec): number => hasWire(r)
  ? (r.wireApiIn! + r.wireApiOut! + r.wireWsIn! + r.wireWsOut!)
  : r.httpBytes + r.wsBytesOut + r.wsBytesIn;
const tripsOf = (r: Rec): number => r.requests + r.wsFramesOut;
const pct = (before: number, after: number): string => before === 0 ? "n/a" : `${(100 * (before - after) / before).toFixed(0)}%`;
// median of per-test savings fractions (0 when the test had no baseline traffic)
const medianSaved = (ps: { b: Agg; p: Agg }[], f: (r: Rec) => number): string =>
  `${(100 * median(ps.map(({ b, p }) => med(b, f) === 0 ? 0 : (med(b, f) - med(p, f)) / med(b, f)))).toFixed(0)}%`;

const base = loadArm(baseSpec);
const port = loadArm(portSpec);

const onlyBase = [...base.tests.keys()].filter((id) => !port.tests.has(id));
const onlyPort = [...port.tests.keys()].filter((id) => !base.tests.has(id));
const allPairs = [...base.tests.keys()].filter((id) => port.tests.has(id)).map((id) => ({ id, b: base.tests.get(id)!, p: port.tests.get(id)! }));
// a row whose counter read failed carries no valid deltas — the pair is excluded rather
// than polluting totals (the reporter flags it instead of shipping wrong numbers)
const anyWireError = (a: Agg): boolean => a.recs.some((r) => r.wireError);
const wireDropped = allPairs.filter(({ b, p }) => anyWireError(b) || anyWireError(p));
const pairs = allPairs.filter(({ b, p }) => !anyWireError(b) && !anyWireError(p));
if (wireDropped.length) console.log(`wire-counter failure EXCLUDED (${wireDropped.length}): ${wireDropped.slice(0, 5).map(({ id }) => id).join("; ")}${wireDropped.length > 5 ? " …" : ""}`);

const allPassed = (a: Agg): boolean => a.statuses.every((s) => s === "passed");
const parityFail = pairs.filter(({ b, p }) => !allPassed(b) || !allPassed(p));
const counted = pairs.filter(({ b, p }) => allPassed(b) && allPassed(p));
// wire-only rows (the NocoDB reporter) carry no CDP request/frame counts: trips are
// then unknowable, not zero — the trip lines are suppressed instead of printing NaN
const hasTrips = (a: Agg): boolean => a.recs.every((r) => r.requests !== undefined && r.wsFramesOut !== undefined);
const tripsKnown = counted.length > 0 && counted.every(({ b, p }) => hasTrips(b) && hasTrips(p));
// a pair is COVERED if the ported run actually used the session socket — the port
// touched this interaction. Uncovered pairs measure noise, not the port. Wire-only
// rows show socket use in the TCP ws counters instead of CDP frame counts.
const covered = counted.filter(({ p }) => p.recs.some((r) => (r.wsFramesOut ?? 0) > 0 || (r.wsFramesOut === undefined && ((r.wireWsOut ?? 0) > 0 || (r.wireWsIn ?? 0) > 0))));

console.log(`\npaired ${pairs.length} tests (${base.tests.size} baseline, ${port.tests.size} ported)`);
console.log(base.runs > 1 || port.runs > 1
  ? `per-test metrics are MEDIANS of ${base.runs} baseline run(s) and ${port.runs} ported run(s)`
  : "SINGLE run per arm — request-heavy tests swing by seconds run-to-run; prefer medians of 3 for timing claims");
const wireTrue = pairs.length > 0 && pairs.every(({ b, p }) => b.recs.every(hasWire) && p.recs.every(hasWire));
console.log(wireTrue
  ? "bytes are TCP-TRUE (socket-level, compression included; browser data path only — node-side seeding excluded)"
  : "bytes are CDP-level (ws frames counted post-inflate — OVERSTATES a deflate-compressed arm's wire bytes)");
if (onlyBase.length) console.log(`  only in baseline (${onlyBase.length}): ${onlyBase.slice(0, 5).join("; ")}${onlyBase.length > 5 ? " …" : ""}`);
if (onlyPort.length) console.log(`  only in ported (${onlyPort.length}): ${onlyPort.slice(0, 5).join("; ")}${onlyPort.length > 5 ? " …" : ""}`);
if (parityFail.length) {
  console.log(`\npass-parity EXCLUDED (${parityFail.length}) — statuses baseline/ported (all runs):`);
  for (const { id, b, p } of parityFail) console.log(`  ${b.statuses.join("|")} / ${p.statuses.join("|")}  ${id}`);
}

const sum = (xs: number[]): number => xs.reduce((a, x) => a + x, 0);
const totB = sum(counted.map(({ b }) => med(b, bytesOf))), totP = sum(counted.map(({ p }) => med(p, bytesOf)));

console.log(`\n== suite-wide (${counted.length} pass-parity pairs; ${covered.length} touch the port) ==`);
console.log(`  total bytes   ${(totB / 1024).toFixed(1)} KB -> ${(totP / 1024).toFixed(1)} KB   (${pct(totB, totP)} less IO)`);
if (tripsKnown) {
  const trpB = sum(counted.map(({ b }) => med(b, tripsOf))), trpP = sum(counted.map(({ p }) => med(p, tripsOf)));
  console.log(`  total trips   ${trpB} -> ${trpP}   (${pct(trpB, trpP)} fewer)`);
} else {
  console.log("  trips: n/a (wire-only rows carry no request/frame counts)");
}
console.log(`  median per-test bytes saved   ${medianSaved(counted, bytesOf)}`);

// timing is asserted only when BOTH arms measured under the same conditions worth
// asserting — i.e. an injected-RTT run where durationMs reflects network wait, not
// localhost noise. The suite driver only produces paired -rtt<N> files, so presence
// of durationMs on both sides is that signal.
const hasDur = (a: Agg): boolean => a.recs.every((r) => r.durationMs !== undefined);
if (counted.length && counted.every(({ b, p }) => hasDur(b) && hasDur(p))) {
  const dur = (r: Rec): number => r.durationMs!;
  const db = sum(counted.map(({ b }) => med(b, dur))), dp = sum(counted.map(({ p }) => med(p, dur)));
  console.log(`\n== elapsed time (real, wall clock of each test; compare only same-RTT runs) ==`);
  console.log(`  total   ${(db / 60000).toFixed(1)} min -> ${(dp / 60000).toFixed(1)} min   (${pct(db, dp)} less)`);
  console.log(`  median per-test time saved   ${medianSaved(counted, dur)}`);
  const deltas = counted.map(({ b, p }) => med(p, dur) - med(b, dur));
  console.log(`  per-test delta ported-stock: median ${median(deltas) >= 0 ? "+" : ""}${median(deltas).toFixed(0)} ms, total ${(sum(deltas) / 1000).toFixed(1)}s`);
  if (covered.length) {
    const cdb = sum(covered.map(({ b }) => med(b, dur))), cdp = sum(covered.map(({ p }) => med(p, dur)));
    console.log(`  covered subset: total ${(cdb / 60000).toFixed(1)} -> ${(cdp / 60000).toFixed(1)} min (${pct(cdb, cdp)} less), median per-test ${medianSaved(covered, dur)} less`);
  }
}

// ---- network-wait decomposition: RTT-run minus floor-run, latency-stable tests only ----
const floorBaseSpec = flag("--floor-baseline"), floorPortSpec = flag("--floor-ported");
if (floorBaseSpec && floorPortSpec) {
  const fb = loadArm(floorBaseSpec), fp = loadArm(floorPortSpec);
  const dur = (r: Rec): number => r.durationMs ?? NaN;
  const ok = counted.filter(({ id, b, p }) => {
    const xb = fb.tests.get(id), xp = fp.tests.get(id);
    return xb && xp && allPassed(xb) && allPassed(xp) && hasDur(b) && hasDur(p) && xb.recs.every((r) => r.durationMs !== undefined) && xp.recs.every((r) => r.durationMs !== undefined);
  });
  // latency-stable per arm: the request count barely moves between floor and RTT
  // conditions — otherwise the workload itself changed and the subtraction is void
  const stable = (rtt: Agg, floor: Agg): boolean => {
    const a = med(floor, (r) => r.requests), b2 = med(rtt, (r) => r.requests);
    return Math.abs(a - b2) <= Math.max(5, 0.15 * Math.max(a, b2));
  };
  const kept = ok.filter(({ id, b, p }) => stable(b, fb.tests.get(id)!) && stable(p, fp.tests.get(id)!));
  const dropped = ok.filter((x) => !kept.includes(x));
  const wb = kept.map(({ id, b }) => med(b, dur) - med(fb.tests.get(id)!, dur));
  const wp = kept.map(({ id, p }) => med(p, dur) - med(fp.tests.get(id)!, dur));
  console.log(`\n== network wait (RTT minus floor; ${fb.runs}/${fp.runs} floor run(s)) ==`);
  console.log(`  latency-stable tests only: ${kept.length} of ${ok.length} (${dropped.length} change their request count with timing — subtraction would compare different workloads)`);
  console.log(`  stock:  total ${(sum(wb) / 1000).toFixed(1)}s, median ${median(wb).toFixed(0)} ms`);
  console.log(`  ported: total ${(sum(wp) / 1000).toFixed(1)}s, median ${median(wp).toFixed(0)} ms`);
  if (dropped.length) {
    console.log(`  latency-SENSITIVE (excluded), stock requests floor -> RTT:`);
    for (const { id, b } of dropped.slice(0, 8)) console.log(`    ${med(fb.tests.get(id)!, (r) => r.requests).toFixed(0)} -> ${med(b, (r) => r.requests).toFixed(0)}  ${id.slice(0, 80)}`);
    if (dropped.length > 8) console.log(`    … and ${dropped.length - 8} more`);
  }
}

if (covered.length) {
  const cb = sum(covered.map(({ b }) => med(b, bytesOf))), cp = sum(covered.map(({ p }) => med(p, bytesOf)));
  console.log(`\n== covered subset (${covered.length} tests whose interaction the port serves) ==`);
  console.log(`  total bytes   ${(cb / 1024).toFixed(1)} KB -> ${(cp / 1024).toFixed(1)} KB   (${pct(cb, cp)} less IO)`);
  if (tripsKnown) {
    const ctb = sum(covered.map(({ b }) => med(b, tripsOf))), ctp = sum(covered.map(({ p }) => med(p, tripsOf)));
    console.log(`  total trips   ${ctb} -> ${ctp}   (${pct(ctb, ctp)} fewer)`);
    console.log(`  median per-test: bytes ${medianSaved(covered, bytesOf)} less, trips ${medianSaved(covered, tripsOf)} fewer`);
  } else {
    console.log(`  median per-test: bytes ${medianSaved(covered, bytesOf)} less (trips n/a)`);
  }
  console.log(`\n  per-test detail (bytes before -> after${tripsKnown ? " · trips before -> after" : ""}):`);
  for (const { id, b, p } of [...covered].sort((x, y) => (med(x.b, bytesOf) - med(x.p, bytesOf)) < (med(y.b, bytesOf) - med(y.p, bytesOf)) ? 1 : -1)) {
    console.log(`    ${(med(b, bytesOf) / 1024).toFixed(1)} -> ${(med(p, bytesOf) / 1024).toFixed(1)} KB${tripsKnown ? ` · ${med(b, tripsOf)} -> ${med(p, tripsOf)}` : ""}  ${id.slice(0, 100)}`);
  }
}

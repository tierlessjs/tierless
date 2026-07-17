// Time decomposition over the four measured runs (docs/corpus.md run protocol):
//
//   node ports/report-time.mts <floor-base[,run2,…]> <floor-ported[,…]> <rtt-base[,…]> <rtt-ported[,…]>
//
// Each position accepts one run or a comma-separated list; with lists, every per-test
// duration is the MEDIAN across that cell's runs and a pair counts only if the test
// passed in every run. Single runs on heavy tests swing by seconds (ports/vikunja,
// 2026-07-17) — one run per cell is accepted but the header says so.
//
// A test's durationMs sums four things: network waits (the ONLY part a flow rewrite can
// improve), browser render/JS, Playwright machinery (actionability/expect polling), and
// node-side fixture setup. The truth runs measured every test at localhost (RTT~0), the
// shaped runs at the injected RTT — so per test and per arm,
//
//     net = dur(RTT) - dur(RTT0)   ~= sequential round trips on the critical path x RTT
//
// isolates the improvable component; everything transport can't touch cancels out. The
// report compares that component across arms, per test, and states the pool honestly:
// how much conceivably-improvable time exists at all, and how much the port removes.
import { readFileSync } from "node:fs";

interface Rec { id: string; status: string; retry: number; durationMs?: number }
const loadRun = (f: string): Map<string, Rec> => {
  const out = new Map<string, Rec>();
  for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const r: Rec = JSON.parse(line);
    if (r.retry === 0) out.set(r.id, r);
  }
  return out;
};
const medianOf = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
// a cell = one or more runs of the same condition; per test, the duration is the
// median across runs, valid only if the test passed (with a duration) in EVERY run
interface Cell { runs: number; seen: number; dur: Map<string, number> }
const loadCell = (spec: string): Cell => {
  const files = spec.split(",").filter(Boolean);
  const runs = files.map(loadRun);
  const dur = new Map<string, number>();
  for (const id of runs[0].keys()) {
    const rows = runs.map((m) => m.get(id));
    if (rows.every((r) => r?.status === "passed" && r.durationMs !== undefined)) dur.set(id, medianOf(rows.map((r) => r!.durationMs!)));
  }
  return { runs: files.length, seen: runs[0].size, dur };
};

const specs = process.argv.slice(2);
if (specs.length !== 4) { console.error("usage: node ports/report-time.mts <floor-base[,…]> <floor-ported[,…]> <rtt-base[,…]> <rtt-ported[,…]>"); process.exit(2); }
const [tb, tp, rb, rp] = specs.map(loadCell);
const totalRuns = tb.runs + tp.runs + rb.runs + rp.runs;
// a pair counts only when the test PASSED (timed) in every run of all four cells
const ids = [...tb.dur.keys()].filter((id) => [tp, rb, rp].every((c) => c.dur.has(id)));
const dropped = tb.seen - ids.length;
// bail before medians over nothing print NaN as if it were a result
if (!ids.length) { console.error(`no test passed in all runs (${dropped} dropped) — nothing to decompose`); process.exit(1); }
if (totalRuns === 4) console.log("SINGLE run per cell — heavy tests swing by seconds run-to-run; prefer medians of 3 for timing claims");
else console.log(`per-test durations are MEDIANS: ${tb.runs}/${tp.runs} floor and ${rb.runs}/${rp.runs} RTT run(s) per arm`);

interface Row { id: string; netB: number; netP: number; base0: number; port0: number }
const rows: Row[] = ids.map((id) => ({
  id,
  netB: rb.dur.get(id)! - tb.dur.get(id)!,
  netP: rp.dur.get(id)! - tp.dur.get(id)!,
  base0: tb.dur.get(id)!,
  port0: tp.dur.get(id)!,
}));

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const ms = (x: number): string => (x / 1000).toFixed(1) + "s";

const totB = sum(rows.map((r) => r.netB)), totP = sum(rows.map((r) => r.netP));
const tot0B = sum(rows.map((r) => r.base0)), tot0P = sum(rows.map((r) => r.port0));

console.log(`\ntime decomposition over ${rows.length} tests passing in all four runs (${dropped} dropped)`);
console.log(`\n== the unimprovable floor (localhost: render + Playwright + fixtures; no meaningful network) ==`);
console.log(`  baseline ${ms(tot0B)}   ported ${ms(tot0P)}   — transport cannot move this`);
console.log(`\n== the improvable pool (network waits: dur@RTT - dur@RTT0, per test) ==`);
console.log(`  baseline total ${ms(totB)} -> ported ${ms(totP)}   (${(100 * (totB - totP) / totB).toFixed(0)}% of the POOL removed)`);
console.log(`  median per test ${median(rows.map((r) => r.netB)).toFixed(0)} ms -> ${median(rows.map((r) => r.netP)).toFixed(0)} ms`);
console.log(`  pool share of total wall time (baseline): ${(100 * totB / (totB + tot0B)).toFixed(0)}% — the ceiling any flow rewrite has to work with`);

// negative nets are run-to-run noise; report the noise level instead of hiding it
const noisy = rows.filter((r) => r.netB < 0 || r.netP < 0).length;
console.log(`  noise: ${noisy} test(s) with a negative net component (run variance; kept as-is, medians are robust)`);

// The network-bound decile: rank by BASELINE net wait — the workload's own measure of
// how network-heavy a test is, independent of the port — and cut the top 10%. Most of
// the suite is local-UI/compute with negligible network, which dilutes the aggregate
// pool; this slice shows the delta where transport can actually matter, on the app's
// OWN tests, selected by the baseline arm so it favors neither. Reported for every port.
const decileN = Math.max(1, Math.round(rows.length / 10));
const decile = [...rows].sort((a, b) => b.netB - a.netB).slice(0, decileN);
const p90 = decile[decile.length - 1].netB;
const decB = sum(decile.map((r) => r.netB)), decP = sum(decile.map((r) => r.netP));
console.log(`\n== the network-bound decile (top ${decileN} tests by baseline net wait, netB >= ${p90} ms) ==`);
console.log(`  baseline ${ms(decB)} -> ported ${ms(decP)}   (${(100 * (decB - decP) / decB).toFixed(0)}% of the decile pool removed)`);
console.log(`  median per test ${median(decile.map((r) => r.netB)).toFixed(0)} ms -> ${median(decile.map((r) => r.netP)).toFixed(0)} ms`);

console.log(`\n== per-test detail, ranked by network-wait delta (netB -> netP · localhost floor) ==`);
for (const r of [...rows].sort((a, b) => (b.netB - b.netP) - (a.netB - a.netP)).slice(0, 20)) {
  console.log(`  ${String(r.netB).padStart(6)} -> ${String(r.netP).padStart(6)} ms · floor ${String(r.base0).padStart(6)} ms  ${r.id.slice(0, 95)}`);
}
console.log(`\n== worst regressions (same ranking, bottom) ==`);
for (const r of [...rows].sort((a, b) => (a.netB - a.netP) - (b.netB - b.netP)).slice(0, 8)) {
  console.log(`  ${String(r.netB).padStart(6)} -> ${String(r.netP).padStart(6)} ms · floor ${String(r.base0).padStart(6)} ms  ${r.id.slice(0, 95)}`);
}

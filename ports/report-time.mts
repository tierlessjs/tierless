// Time decomposition over the four measured runs (docs/corpus.md run protocol):
//
//   node ports/report-time.mts <truth-base> <truth-ported> <rtt-base> <rtt-ported>
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
const load = (f: string): Map<string, Rec> => {
  const out = new Map<string, Rec>();
  for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const r: Rec = JSON.parse(line);
    if (r.retry === 0) out.set(r.id, r);
  }
  return out;
};

const files = process.argv.slice(2);
if (files.length !== 4) { console.error("usage: node ports/report-time.mts <floor-base> <floor-ported> <rtt-base> <rtt-ported>"); process.exit(2); }
const [tb, tp, rb, rp] = files.map(load);

// a pair counts only when the test PASSED in all four runs and every run timed it
const ids = [...tb.keys()].filter((id) =>
  [tb, tp, rb, rp].every((m) => m.get(id)?.status === "passed" && m.get(id)!.durationMs !== undefined));
const dropped = [...tb.keys()].length - ids.length;

interface Row { id: string; netB: number; netP: number; base0: number; port0: number }
const rows: Row[] = ids.map((id) => ({
  id,
  netB: rb.get(id)!.durationMs! - tb.get(id)!.durationMs!,
  netP: rp.get(id)!.durationMs! - tp.get(id)!.durationMs!,
  base0: tb.get(id)!.durationMs!,
  port0: tp.get(id)!.durationMs!,
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

console.log(`\n== per-test detail, ranked by network-wait delta (netB -> netP · localhost floor) ==`);
for (const r of [...rows].sort((a, b) => (b.netB - b.netP) - (a.netB - a.netP)).slice(0, 20)) {
  console.log(`  ${String(r.netB).padStart(6)} -> ${String(r.netP).padStart(6)} ms · floor ${String(r.base0).padStart(6)} ms  ${r.id.slice(0, 95)}`);
}
console.log(`\n== worst regressions (same ranking, bottom) ==`);
for (const r of [...rows].sort((a, b) => (a.netB - a.netP) - (b.netB - b.netP)).slice(0, 8)) {
  console.log(`  ${String(r.netB).padStart(6)} -> ${String(r.netP).padStart(6)} ms · floor ${String(r.base0).padStart(6)} ms  ${r.id.slice(0, 95)}`);
}

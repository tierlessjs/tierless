// Per-test I/O wait across arms (the measure reporter's ioWaitMs: the union of the page's
// in-flight fetches and session crossings inside each test's window — installIoWait).
//
//   node ports/report-io.mts <dir>        rows: <dir>/<arm>-r<n>.jsonl (drive-chains.sh)
//
// Per test and arm, the median over rounds; a test counts only if it passed in EVERY run
// of both arms compared. When a run's labelled intervals sit beside its rows
// (<arm>-r<n>.io), ioWaitMs is recomputed from them by the reporter's rule — the union of
// valid intervals inside the test's window — so a recorder fix applies to rows already on
// disk (rows recorded before the start-time guard counted a timing-less request, start 0,
// as waiting for the whole test). Wall clock (durationMs) is printed beside it for reference only:
// it also carries render, fixtures and Playwright's 100/250/500/1000 ms retry polling.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { unionMs } from "tierless/playwright";

interface Row { id: string; status: string; retry: number; durationMs: number; ioWaitMs?: number; startMs?: number }
const dir = process.argv[2];
if (!dir) { console.error("usage: node ports/report-io.mts <dir>"); process.exit(2); }

const runs: Record<string, Row[][]> = {};
for (const f of readdirSync(dir).filter((f) => /-r\d+\.jsonl$/.test(f)).sort()) {
  const rows = readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row).filter((r) => r.retry === 0);
  const ioFile = `${dir}/${f.replace(/\.jsonl$/, ".io")}`;
  if (existsSync(ioFile)) {
    const iv = readFileSync(ioFile, "utf8").trim().split("\n").map((l) => l.split(" ", 2).map(Number) as [number, number]).filter(([s, e]) => s > 0 && e > s);
    for (const r of rows) if (typeof r.startMs === "number") r.ioWaitMs = unionMs(iv, r.startMs, r.startMs + r.durationMs);
  }
  (runs[f.replace(/-r\d+\.jsonl$/, "")] ||= []).push(rows);
}
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const s1 = (ms: number): string => (ms / 1000).toFixed(1) + " s";

// arm -> test -> per-run rows; a test is usable when it passed with ioWaitMs in every run
const usable = (arm: string): Map<string, Row[]> => {
  const out = new Map<string, Row[]>();
  const all = runs[arm];
  for (const r of all[0]) {
    const rows = all.map((run) => run.find((x) => x.id === r.id));
    if (rows.every((x) => x?.status === "passed" && typeof x.ioWaitMs === "number")) out.set(r.id, rows as Row[]);
  }
  return out;
};

const compare = (a: string, b: string): void => {
  if (!runs[a] || !runs[b]) return;
  const A = usable(a), B = usable(b);
  const ids = [...A.keys()].filter((id) => B.has(id));
  const dropped = new Set([...runs[a][0], ...runs[b][0]].map((r) => r.id)).size - ids.length;
  const io = (m: Map<string, Row[]>, id: string): number => median(m.get(id)!.map((r) => r.ioWaitMs!));
  const wall = (m: Map<string, Row[]>, id: string): number => median(m.get(id)!.map((r) => r.durationMs));
  const ioA = ids.map((id) => io(A, id)), ioB = ids.map((id) => io(B, id));
  const sum = (xs: number[]): number => xs.reduce((x, y) => x + y, 0);
  const d = ids.map((_, i) => ioB[i] - ioA[i]);
  const wA = sum(ids.map((id) => wall(A, id))), wB = sum(ids.map((id) => wall(B, id)));
  console.log(`\n== ${a} -> ${b}: ${ids.length} tests passing in all ${runs[a].length}+${runs[b].length} runs (${dropped} dropped) ==`);
  console.log(`  I/O wait   ${s1(sum(ioA))} -> ${s1(sum(ioB))}  (${(100 * (sum(ioB) - sum(ioA)) / sum(ioA)).toFixed(1)}%)   ${d.filter((x) => x < 0).length} tests less, median ${median(d).toFixed(0)} ms per test`);
  console.log(`  wall       ${s1(wA)} -> ${s1(wB)}  (${(100 * (wB - wA) / wA).toFixed(1)}%)   reference only`);
  const ranked = ids.map((id, i) => ({ id, a: ioA[i], b: ioB[i] })).sort((x, y) => (x.b - x.a) - (y.b - y.a));
  for (const r of ranked.length <= 8 ? ranked : [...ranked.slice(0, 5), ...ranked.slice(-3)]) console.log(`  ${String(Math.round(r.a)).padStart(6)} -> ${String(Math.round(r.b)).padStart(6)} ms  ${r.id.slice(0, 90)}`);
};

for (const f of Object.keys(runs)) console.log(`${f}: ${runs[f].length} run(s)`);
compare("fetch", "profile");     // migration alone: same build, one variable
compare("baseline", "profile");  // against stock
compare("baseline", "fetch");    // the compiled build's own cost when nothing migrates

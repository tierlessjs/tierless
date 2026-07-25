// Did the nodes.json in-flight dedupe (commonPatches/0006) actually bite?
//
// The signature of the upstream race in the per-path HTTP log is two byte-identical
// full-size 200s for /types/nodes.json seconds apart: two callers both saw an empty
// store and both downloaded 1.46 MB. After the fix the second caller joins the first's
// promise, so close pairs should be ~0. This is an ABSOLUTE check — zero pairs where
// the code shape predicted many — not a before/after, because both trees now carry
// the patch.
//
//   node ports/n8n/report-dedupe.mts
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Hit { ts: number; method: string; path: string; status: number; respBytes: number }
const DIR = fileURLToPath(new URL("./results/dedupe-check/", import.meta.url));
const TARGET = "/types/nodes.json";
const PAIR_WINDOW_MS = 30_000;   // generous: the observed pairs sat 0.5-1.1 s apart

for (const arm of ["ported", "baseline"]) {
  const f = DIR + arm + "-http.jsonl";
  if (!existsSync(f)) { console.log(`${arm}: no log yet`); continue; }
  const rows = readFileSync(f, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as Hit; } catch { return null; } })
    .filter((r): r is Hit => !!r);
  const hits = rows.filter((r) => r.path === TARGET && r.status === 200).sort((a, b) => a.ts - b.ts);
  const full = hits.filter((r) => r.respBytes > 1e6);
  // a "pair" = a full 200 following another full 200 inside the window: the second
  // download the shared promise is supposed to eliminate
  let pairs = 0;
  const gaps: number[] = [];
  for (let i = 1; i < full.length; i++) {
    const gap = full[i].ts - full[i - 1].ts;
    if (gap <= PAIR_WINDOW_MS) { pairs++; gaps.push(gap); }
  }
  const bytes = full.reduce((a, r) => a + r.respBytes, 0);
  console.log(
    `${arm.padEnd(9)} ${TARGET}: ${full.length} full 200s (${(bytes / 1e6).toFixed(1)} MB), ` +
    `${pairs} close pair(s)${gaps.length ? ` [gaps ${gaps.slice(0, 6).map((g) => (g / 1000).toFixed(1) + "s").join(", ")}]` : ""}`,
  );
  console.log(`${" ".repeat(10)}total HTTP rows ${rows.length}`);
}
console.log(`\nBaseline for comparison (pre-fix, full-suite budget arm, ports/n8n/README.md):`);
console.log(`  stock 805 full 200s / 150 pairs (25% of pages) | ported 1,007 / 342 pairs (54%)`);

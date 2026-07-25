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

interface Hit { ts: number; startedAt?: number; method: string; path: string; status: number; respBytes: number }
const DIR = fileURLToPath(new URL("./results/dedupe-check/", import.meta.url));
const TARGET = "/types/nodes.json";

// OVERLAP, not a completion gap. Two fetches of one path are a double-fetch iff the
// second STARTS before the first ENDS — that is the state the emptiness guard misreads
// and the shared promise removes. Comparing completion gaps instead cannot tell one page
// fetching twice from two pages fetching once, which is why the original diagnosis had
// to rest on code shape; http-log-proxy now records startedAt so it does not have to.
for (const arm of ["ported", "baseline"]) {
  const f = DIR + arm + "-http.jsonl";
  if (!existsSync(f)) { console.log(`${arm}: no log yet`); continue; }
  const rows = readFileSync(f, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as Hit; } catch { return null; } })
    .filter((r): r is Hit => !!r);
  const full = rows.filter((r) => r.path === TARGET && r.status === 200 && r.respBytes > 1e6)
    .sort((a, b) => (a.startedAt ?? a.ts) - (b.startedAt ?? b.ts));
  if (full.some((r) => r.startedAt === undefined)) {
    console.log(`${arm}: log predates the startedAt field — re-run this arm (overlap is not derivable from completion times)`);
    continue;
  }
  let overlaps = 0;
  const detail: string[] = [];
  for (let i = 1; i < full.length; i++) {
    // compare against the widest still-open predecessor, not just the previous request
    const openEnd = Math.max(...full.slice(0, i).map((r) => r.ts));
    if (full[i].startedAt! < openEnd) { overlaps++; detail.push(`+${((openEnd - full[i].startedAt!) / 1000).toFixed(1)}s into a live fetch`); }
  }
  const bytes = full.reduce((a, r) => a + r.respBytes, 0);
  console.log(
    `${arm.padEnd(9)} ${TARGET}: ${full.length} full 200s (${(bytes / 1e6).toFixed(1)} MB), ` +
    `${overlaps} OVERLAPPING${detail.length ? ` [${detail.slice(0, 5).join("; ")}]` : ""}`,
  );
  console.log(`${" ".repeat(10)}total HTTP rows ${rows.length}`);
}
console.log(`\nPre-fix, for scale (full-suite budget arm, ports/n8n/README.md — completion-gap\npairing, so not directly comparable): stock 805 full 200s / 150 pairs, ported 1,007 / 342.`);
console.log(`What settles it here: overlapping fetches should be 0 once both callers share one promise.`);

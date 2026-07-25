// Concurrent /types/nodes.json fetches, with and without commonPatches/0006.
//
// The signature is a fetch that STARTS while the store is still empty from a previous
// one — measured as (this.startedAt - previous.ts), the idle interval between one
// download ending and the next beginning. It is NOT plain HTTP overlap: the second
// caller's guard typically runs AFTER the first download completes but DURING its ~12 MB
// parse+ingest, so the two requests are sequential and an overlap test misses them
// entirely (observed on workflows/editor/routing: pairs 154/205/129 ms apart, back to
// back). It is also not a completion-gap window, which cannot tell one page fetching
// twice from two pages fetching once. startedAt (http-log-proxy) is what makes the
// distinction measurable instead of inferred from code shape.
//
// The threshold is bounded by how long ingesting ~12 MB takes — a few hundred ms. The
// data is bimodal where the race actually happens (workflows/editor/routing: 85, 129,
// 154, 178, 205, 238 ms, then nothing until 4.3 s), so 500 ms sits in open space. A
// looser 1000 ms cutoff was tried first and was wrong: on workflows-list, where genuine
// page-to-page intervals run 710-1400 ms, it manufactured "double-fetches" on an arm
// that HAS the fix. The full distribution is printed so the cutoff stays auditable.
//
// ALWAYS read a "fixed" row against its "ablate" row. A spec that never double-fetches
// reports 0 either way — that is exactly how the workflows-list spec produced a
// meaningless confirmation (results/dedupe-check: 24/0 fixed vs 23/0 reverted).
//
//   node ports/n8n/report-dedupe.mts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Hit { ts: number; startedAt?: number; path: string; status: number; respBytes: number }
const TARGET = "/types/nodes.json";
const INGEST_WINDOW_MS = 500;
const RESULTS = fileURLToPath(new URL("./results/", import.meta.url));

interface Row { group: string; arm: string; fetches: number; mb: number; overlaps: number; detail: string[]; intervals: number[] }
const measure = (file: string): Omit<Row, "group" | "arm"> | string => {
  const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as Hit; } catch { return null; } })
    .filter((r): r is Hit => !!r);
  const full = rows.filter((r) => r.path === TARGET && r.status === 200 && r.respBytes > 1e6)
    .sort((a, b) => (a.startedAt ?? a.ts) - (b.startedAt ?? b.ts));
  if (full.some((r) => r.startedAt === undefined)) return "log predates startedAt — re-run (the interval is not derivable from completion times alone)";
  let overlaps = 0;
  const detail: string[] = [];
  const intervals: number[] = [];
  for (let i = 1; i < full.length; i++) {
    const idle = full[i].startedAt! - full[i - 1].ts;   // <0 = truly concurrent; small = inside the ingest window
    intervals.push(idle);
    if (idle < INGEST_WINDOW_MS) { overlaps++; detail.push(`${idle}ms after the previous download ended`); }
  }
  return { fetches: full.length, mb: full.reduce((a, r) => a + r.respBytes, 0) / 1e6, overlaps, detail, intervals };
};

const out: Row[] = [];
for (const dir of readdirSync(RESULTS).filter((d) => d.startsWith("dedupe-"))) {
  const base = RESULTS + dir + "/";
  if (!existsSync(base)) continue;
  for (const f of readdirSync(base).filter((f) => f.endsWith("-http.jsonl")).sort()) {
    const stem = f.replace(/-http\.jsonl$/, "");            // "<arm>" or "<label>-<arm>"
    const i = stem.lastIndexOf("-");
    const [group, arm] = i < 0 ? [dir, stem] : [`${dir}/${stem.slice(0, i)}`, stem.slice(i + 1)];
    const m = measure(base + f);
    if (typeof m === "string") { console.log(`${group} ${arm}: ${m}`); continue; }
    out.push({ group, arm, ...m });
  }
}
if (!out.length) { console.log("no dedupe logs yet"); process.exit(0); }

let width = 0;
for (const r of out) width = Math.max(width, (r.group + " " + r.arm).length);
for (const r of out) {
  console.log(
    `${(r.group + " " + r.arm).padEnd(width)}  ${String(r.fetches).padStart(4)} full 200s  ${r.mb.toFixed(1).padStart(6)} MB  ` +
    `${String(r.overlaps).padStart(4)} DOUBLE-FETCH${r.detail.length ? `  [${r.detail.slice(0, 3).join("; ")}]` : ""}`,
  );
}

// The verdict is a COMPARISON. Only a group whose ablate arm actually raced can say
// anything about the fix; one that did not simply lacked the power to test it.
const groups = [...new Set(out.map((r) => r.group.replace(/\/(fixed|ablate|ported|baseline)$/, "")))];
console.log(`\nintervals between consecutive fetches (ms) — the threshold is ${INGEST_WINDOW_MS}ms:`);
for (const r of out) console.log(`  ${(r.group + " " + r.arm).padEnd(width)} ${r.intervals.sort((a, b) => a - b).slice(0, 12).join(", ")}${r.intervals.length > 12 ? ", ..." : ""}`);
console.log();
for (const g of groups) {
  const rows = out.filter((r) => r.group === g);
  const ab = rows.find((r) => r.arm === "ablate");
  const fx = rows.find((r) => r.arm === "fixed" || r.arm === "ported");
  if (!ab || !fx) continue;
  console.log(ab.overlaps === 0
    ? `${g}: NO POWER — the reverted arm did not double-fetch either, so this spec set cannot test the fix.`
    : fx.overlaps === 0
      ? `${g}: FIX CONFIRMED — ${ab.overlaps} double-fetch(es) of ${ab.fetches} fetches without it, 0 with it (${(ab.overlaps * (ab.mb / ab.fetches)).toFixed(1)} MB of redundant download removed).`
      : `${g}: FIX INCOMPLETE — ${ab.overlaps} double-fetches without, still ${fx.overlaps} with.`);
}

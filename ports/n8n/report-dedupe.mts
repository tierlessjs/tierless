// Concurrent /types/nodes.json fetches, with and without commonPatches/0006.
//
// OVERLAP, not a completion gap. Two fetches of one path are a double-fetch iff the
// second STARTS before the first ENDS — the state the emptiness guard misreads and a
// shared in-flight promise removes. Completion gaps cannot distinguish one page fetching
// twice from two pages fetching once, which is why the original diagnosis rested on code
// shape; http-log-proxy records startedAt so it no longer has to.
//
// ALWAYS read a "fixed" row against its "ablate" row. A spec that never races reports 0
// overlapping either way — that is exactly how the workflows-list spec produced a
// meaningless confirmation (results/dedupe-check: 24/0 fixed vs 23/0 reverted).
//
//   node ports/n8n/report-dedupe.mts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Hit { ts: number; startedAt?: number; path: string; status: number; respBytes: number }
const TARGET = "/types/nodes.json";
const RESULTS = fileURLToPath(new URL("./results/", import.meta.url));

interface Row { group: string; arm: string; fetches: number; mb: number; overlaps: number; detail: string[] }
const measure = (file: string): Omit<Row, "group" | "arm"> | string => {
  const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as Hit; } catch { return null; } })
    .filter((r): r is Hit => !!r);
  const full = rows.filter((r) => r.path === TARGET && r.status === 200 && r.respBytes > 1e6)
    .sort((a, b) => (a.startedAt ?? a.ts) - (b.startedAt ?? b.ts));
  if (full.some((r) => r.startedAt === undefined)) return "log predates startedAt — re-run (overlap is not derivable from completion times)";
  let overlaps = 0;
  const detail: string[] = [];
  for (let i = 1; i < full.length; i++) {
    const openEnd = Math.max(...full.slice(0, i).map((r) => r.ts));   // widest still-open predecessor
    if (full[i].startedAt! < openEnd) { overlaps++; detail.push(`${((openEnd - full[i].startedAt!) / 1000).toFixed(1)}s into a live fetch`); }
  }
  return { fetches: full.length, mb: full.reduce((a, r) => a + r.respBytes, 0) / 1e6, overlaps, detail };
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
    `${String(r.overlaps).padStart(4)} OVERLAPPING${r.detail.length ? `  [${r.detail.slice(0, 4).join("; ")}]` : ""}`,
  );
}

// The verdict is a COMPARISON. Only a group whose ablate arm actually raced can say
// anything about the fix; one that did not simply lacked the power to test it.
const groups = [...new Set(out.map((r) => r.group.replace(/\/(fixed|ablate|ported|baseline)$/, "")))];
console.log();
for (const g of groups) {
  const rows = out.filter((r) => r.group === g);
  const ab = rows.find((r) => r.arm === "ablate");
  const fx = rows.find((r) => r.arm === "fixed" || r.arm === "ported");
  if (!ab || !fx) continue;
  console.log(ab.overlaps === 0
    ? `${g}: NO POWER — the reverted arm did not race either (0 overlapping), so this spec set cannot test the fix.`
    : fx.overlaps === 0
      ? `${g}: FIX CONFIRMED — ${ab.overlaps} overlapping fetch(es) without it, 0 with it (${(ab.mb - fx.mb).toFixed(1)} MB saved).`
      : `${g}: FIX INCOMPLETE — ${ab.overlaps} overlapping without, still ${fx.overlaps} with.`);
}

// THE ONE PAGE — every corpus app's numbers, generated from the committed artifacts.
//
// Why generated: InvenTree's README carried figures for a week that described a framework
// which no longer shipped, because a hand-written table cannot notice that the data under
// it changed. Anything here is computed by the SAME reporters that produce the detailed
// output (they now emit a SUMMARY_JSON line), so the page cannot drift from the artifacts
// and cannot disagree with the per-port reports.
//
//   node ports/summary.mts            print it
//   node ports/summary.mts --write    also write docs/results.md
//
// The manifest below is explicit ON PURPOSE. Six ports arrived over months with different
// result layouts, and a script that inferred "the current arms" from filenames would pick
// the wrong pair silently — the exact failure this page exists to prevent. If a port is
// not listed with a truth pair, it prints as not-measured rather than being guessed at.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Port {
  name: string;
  /** Directory of a truth/budget arm pair (report-marginal.mts reads it). */
  truth?: string;
  /** baseline,ported measure files for the wall-clock row (report.mts reads them). */
  floor?: [string, string];
  /** A port-specific slice reporter that OWNS that number, when one exists. Preferred over
   *  report-marginal's generic slice, which counts only fully-moved paths against the whole
   *  session and so omits what the ported arm still pays on browser HTTP — on n8n that is
   *  1.75 MB, and the difference is -61.5% (generic) against -50.7% (dedicated). */
  sliceCmd?: string[];
  /** What a reader must be told alongside the numbers. Kept WITH the data. */
  caveats?: string[];
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORTS: Port[] = [
  {
    name: "inventree",
    truth: "ports/inventree/results/truth",
    floor: ["ports/inventree/results/floor/baseline-measure.jsonl", "ports/inventree/results/floor/ported-measure.jsonl"],
    caveats: [
      "Suite is flaky at 3-9 failures per run in BOTH arms, failing sets disjoint between consecutive runs of the same arm.",
      "The floor (wall) pair predates the cacheability-keyed advisory; the truth pair does not.",
    ],
  },
  {
    name: "n8n",
    truth: "ports/n8n/results/smallslice",
    sliceCmd: ["ports/n8n/report-smallslice.mts"],
    caveats: [
      "Editor chunk only, not the whole suite — it is the largest chunk and the one every other n8n result used.",
      "The advisory is SEEDED for this run (TIERLESS_BROWSE_SEED), so the 12.9 MB catalogue crosses zero times and the slice is exact rather than a bound.",
    ],
  },
  {
    name: "grafana",
    truth: "ports/grafana/results/budget",
    caveats: [
      "Suite does not reach pass parity under the double-proxy budget instrumentation, so its SUITE-TOTAL row is not quotable; the slice is, because it barely moves while the pass set does.",
    ],
  },
];

const sh = (cmd: string, args: string[]): string => {
  try { return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] }); }
  catch (e) { return String((e as { stdout?: string }).stdout ?? ""); }
};
const summaryLine = (out: string): Record<string, unknown> | null => {
  const m = /^SUMMARY_JSON (.*)$/m.exec(out);
  return m ? JSON.parse(m[1]) as Record<string, unknown> : null;
};
const MB = (n: number): string => (n / 1e6).toFixed(0) + " MB";
const pct = (b: number, p: number): string => (p === b ? "0.0%" : ((p - b) / b * 100).toFixed(1) + "%");

const rows: string[] = [];
const notes: string[] = [];
for (const port of PORTS) {
  const marg = port.truth && existsSync(port.truth) ? summaryLine(sh(process.execPath, ["ports/report-marginal.mts", port.truth])) : null;
  const wall = port.floor && port.floor.every((f) => existsSync(f)) ? summaryLine(sh(process.execPath, ["ports/report.mts", ...port.floor])) : null;

  if (!marg) { rows.push(`| ${port.name} | _no truth pair committed_ | | | |`); continue; }
  const [bT, pT] = marg.suiteTotal as [number, number];
  const [bM, pM] = marg.marginal as [number, number];
  const moved = marg.moved as number, session = marg.session as number;
  const bulkShare = moved > 0 ? (marg.movedBulk as number) / moved : 0;
  // the slice is only a REQUEST-SHAPE result when the moved traffic is not bulk-dominated
  let slice = moved > 0 && bulkShare <= 0.2 ? `**${pct(moved, session)}**` : (moved > 0 ? `n/a (${(100 * bulkShare).toFixed(0)}% bulk)` : "n/a");
  let sliceCells = `${MB(moved)} → ${MB(session)}`;
  if (port.sliceCmd) {                                       // the port's own reporter wins
    const own = summaryLine(sh(process.execPath, port.sliceCmd));
    if (own) {
      const sb = own.sliceBaseline as number, sp = own.slicePorted as number;
      sliceCells = `${MB(sb)} → ${MB(sp)}`;
      slice = `${own.bound ? "≥" : ""}**${pct(sb, sp)}**`;
    }
  }
  const [bP, pP] = marg.passes as [number, number];
  rows.push(`| ${port.name} | ${MB(bT)} → ${MB(pT)} · ${pct(bT, pT)} | ${MB(bM)} → ${MB(pM)} · ${pct(bM, pM)} | ${sliceCells} · ${slice} | ${wall ? `${((wall.wallMs as number[])[0] / 60000).toFixed(1)} → ${((wall.wallMs as number[])[1] / 60000).toFixed(1)} min · ${pct((wall.wallMs as number[])[0], (wall.wallMs as number[])[1])}` : "—"} |`);

  const c = [...(port.caveats ?? [])];
  if (bP !== pP) c.unshift(`Pass counts differ: baseline ${bP}, ported ${pP} — the arms did not run identical work, so the byte totals are not strictly comparable.`);
  notes.push(`**${port.name}** — ${(marg.requests as number[])[0]} baseline requests, ${(marg.requests as number[])[1]} ported.\n` + c.map((x) => `- ${x}`).join("\n"));
}

const page = `# Corpus results

GENERATED by \`node ports/summary.mts\` from the committed artifacts. Do not hand-edit:
every number here is produced by the same reporters as the per-port detail
(\`ports/report-marginal.mts\`, \`ports/report.mts\`), so this page cannot drift from the
data. Regenerate after any measured run.

The three byte columns are the SAME BYTES over different denominators, and they differ by
more than an order of magnitude. Read \`docs/corpus.md\` "Reading a byte number" before
quoting any of them.

| app | suite total | marginal (warm cache) | many-small slice | wall clock |
|---|---|---|---|---|
${rows.join("\n")}

- **suite total** — everything the suite downloaded. Dominated by what the harness
  re-downloads because Playwright gives every test a cold browser. Not a user-facing number.
- **marginal** — what remains once repeats a warm cache would serve are modelled away.
- **many-small slice** — the traffic the port actually moved onto the session, and the
  number the request-shape claim is about. Printed only when the moved traffic is not
  bulk-dominated: a session barely moves a few huge payloads, so a blended figure over a
  bulk-heavy mixture says nothing about either shape.
- **wall clock** — pass-parity pairs only, single run per arm unless stated.

## What travels with each number

${notes.join("\n\n")}
`;

console.log(page);
if (process.argv.includes("--write")) {
  writeFileSync(ROOT + "docs/results.md", page);
  console.log("\nwrote docs/results.md");
}

// Per-test measurement reporter (the corpus harness, docs/corpus.md) — the package
// export of the reporter each port used to carry as a ~60-line copy in its measure
// patch. A suite opts in from its Playwright config:
//
//   reporter: process.env.TIERLESS_MEASURE_OUT ? [["line"], ["tierless/playwright-reporter"]] : <stock>
//
// Appends one JSONL row per test ATTEMPT to TIERLESS_MEASURE_OUT — id, status, retry,
// durationMs. With TIERLESS_WIRE_URLS set (comma-separated endpoints returning flat
// JSON number counters, e.g. the gateway's /__tierless/wire and the counting relay),
// reads them around each attempt and records the deltas as wire* fields.
//
// Accounting honesty (unchanged from the port copies): suites run workers=1 under the
// run protocol, so no two tests generate traffic at once; but Playwright does NOT await
// async reporter hooks, so a snapshot can lag its boundary and mis-attribute between
// ADJACENT tests — per-test deltas are best-effort (fine for medians), while the byte
// instrument of record is the suite-total pair. A counter read that fails INVALIDATES
// the row (wireError: true, no wire fields) instead of shipping wrong deltas — a missed
// BEGIN read would silently attribute all prior suite traffic to this test;
// ports/report.mts excludes flagged rows and says so.
import { appendFileSync } from "node:fs";
import path from "node:path";

// Structural slices of @playwright/test/reporter — the suite brings its own Playwright;
// this package must not depend on it.
interface TestLocation { file: string; line: number }
interface TestCaseLike { location: TestLocation; titlePath(): string[] }
interface TestResultLike { status: string; retry: number; duration: number }
interface FullConfigLike { rootDir: string; projects?: { name: string }[] }

const OUT = process.env.TIERLESS_MEASURE_OUT;
const WIRE = (process.env.TIERLESS_WIRE_URLS || "").split(",").filter(Boolean);

// null = a configured endpoint was unreachable or non-2xx: this attempt has no valid deltas
async function counters(): Promise<Record<string, number> | null> {
  const out: Record<string, number> = {};
  for (const url of WIRE) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const j = (await r.json()) as Record<string, unknown>;
      for (const [k, v] of Object.entries(j)) if (typeof v === "number") out[k] = (out[k] || 0) + v;
    } catch {
      return null;
    }
  }
  return out;
}

export default class TierlessMeasureReporter {
  private rootDir = "";
  private projectNames = new Set<string>();
  private before: Record<string, number> | null = {};
  onBegin(config: FullConfigLike): void {
    this.rootDir = config?.rootDir || "";
    this.projectNames = new Set((config?.projects || []).map((p) => p.name).filter(Boolean));
  }
  async onTestBegin(_test: TestCaseLike): Promise<void> {
    if (WIRE.length) this.before = await counters();
  }
  async onTestEnd(test: TestCaseLike, result: TestResultLike): Promise<void> {
    if (!OUT) return;
    const after = WIRE.length ? await counters() : {};
    const wire: Record<string, number | boolean> = {};
    if (WIRE.length && (!this.before || !after)) {
      wire.wireError = true;
    } else if (after) {
      for (const k of Object.keys(after)) wire["wire" + k[0].toUpperCase() + k.slice(1)] = after[k] - (this.before![k] || 0);
    }
    // id: suite-relative file:line + the title path (project and file segments dropped —
    // the same test must produce the same id on both arms) — report.mts's join key
    const file = this.rootDir ? path.relative(this.rootDir, test.location.file) : test.location.file;
    const titles = test.titlePath().filter((t) => t && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(t) && t !== file && !this.projectNames.has(t));
    appendFileSync(OUT, JSON.stringify({ id: `${file}:${test.location.line} › ${titles.join(" › ")}`, status: result.status, retry: result.retry, durationMs: result.duration, ...wire }) + "\n");
  }
  printsToStdio(): boolean {
    return false;
  }
}

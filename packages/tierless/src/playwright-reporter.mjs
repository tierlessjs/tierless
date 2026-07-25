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
// Accounting honesty: suites run workers=1 under the run protocol, so no two tests
// generate traffic at once; but Playwright does NOT await async reporter hooks, so a
// snapshot can lag its boundary. Per-test deltas are therefore best-effort and can jitter
// between ADJACENT tests (fine for medians).
//
// What they are NOT allowed to do is LOSE bytes, so the counters are CHAINED: each test's
// opening snapshot IS the previous test's closing one, and reads are serialized through a
// promise chain so they stay ordered even unawaited. The sum of per-test deltas is then
// exactly (last read - first read) — jitter moves bytes between neighbours, conservation
// holds. Taking two independent reads per test instead leaves the gap between tests
// belonging to nobody: measured on n8n (2026-07-25) that silently dropped 155 MB of 6.13 GB
// on one arm and 64 MB of 5.25 GB on the other — a 1.3-point ASYMMETRY, an order of
// magnitude larger than the arm difference being measured, and it showed up as tests
// reporting a flat 0 bytes after loading a full app page.
//
// A failed read keeps the previous snapshot and flags the row (wireError: true) rather
// than resetting: the next successful read then covers both tests, so the bytes are
// merged into a neighbour instead of vanishing. ports/report.mts excludes flagged rows.
import { appendFileSync } from "node:fs";
import path from "node:path";
const OUT = process.env.TIERLESS_MEASURE_OUT;
const WIRE = (process.env.TIERLESS_WIRE_URLS || "").split(",").filter(Boolean);
// null = a configured endpoint was unreachable or non-2xx: this attempt has no valid deltas
async function counters() {
    const out = {};
    for (const url of WIRE) {
        try {
            const r = await fetch(url);
            if (!r.ok)
                return null;
            const j = (await r.json());
            for (const [k, v] of Object.entries(j))
                if (typeof v === "number")
                    out[k] = (out[k] || 0) + v;
        }
        catch {
            return null;
        }
    }
    return out;
}
export default class TierlessMeasureReporter {
    rootDir = "";
    projectNames = new Set();
    /** The previous test's CLOSING snapshot — this test's opening one. null until the first
     *  read lands (or after a failed read), which flags rather than resets. */
    last = null;
    /** Serializes counter reads and row appends: reporter hooks are not awaited, so without
     *  this two reads could interleave and the chain's ordering guarantee would be lost. */
    chain = Promise.resolve();
    onBegin(config) {
        this.rootDir = config?.rootDir || "";
        this.projectNames = new Set((config?.projects || []).map((p) => p.name).filter(Boolean));
        // open the ledger before any test runs, so the first test's delta is a real one
        if (WIRE.length)
            this.chain = this.chain.then(async () => { this.last = await counters(); });
    }
    onTestEnd(test, result) {
        if (!OUT)
            return;
        this.chain = this.chain.then(() => this.record(test, result));
    }
    async record(test, result) {
        if (!OUT)
            return;
        const after = WIRE.length ? await counters() : {};
        const wire = {};
        if (WIRE.length && (!this.last || !after)) {
            wire.wireError = true; // keep this.last: the next delta absorbs this test rather than losing it
        }
        else if (after) {
            for (const k of Object.keys(after))
                wire["wire" + k[0].toUpperCase() + k.slice(1)] = after[k] - (this.last[k] || 0);
        }
        if (after)
            this.last = after; // CHAIN: this closing snapshot opens the next test
        // id: suite-relative file:line + the title path (project and file segments dropped —
        // the same test must produce the same id on both arms) — report.mts's join key
        const file = this.rootDir ? path.relative(this.rootDir, test.location.file) : test.location.file;
        const titles = test.titlePath().filter((t) => t && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(t) && t !== file && !this.projectNames.has(t));
        appendFileSync(OUT, JSON.stringify({ id: `${file}:${test.location.line} › ${titles.join(" › ")}`, status: result.status, retry: result.retry, durationMs: result.duration, ...wire }) + "\n");
    }
    printsToStdio() {
        return false;
    }
}

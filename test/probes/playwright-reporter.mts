// tierless/playwright-reporter — the corpus measure reporter as a package export
// (docs/corpus.md; each port used to carry a copy). This probe drives the reporter's
// hooks directly: JSONL rows keyed suite-relative (same id on both arms), wire counter
// deltas around each attempt, and the honesty rule — a failed counter read INVALIDATES
// the row (wireError) instead of shipping wrong deltas.
//
// Run:  node test/probes/playwright-reporter.mts
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeCounter } from "../lib/check.mts";

const { check, counts } = makeCounter();

// a live counter endpoint (what the gateway's /__tierless/wire serves)
let wsIn = 100, wsOut = 200, up = true;
const counter = createServer((_req, res) => {
  if (!up) { res.statusCode = 500; res.end(); return; }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ wsIn, wsOut }));
});
await new Promise<void>((r) => counter.listen(0, r));

const OUT = path.join(mkdtempSync(path.join(tmpdir(), "tierless-reporter-")), "measure.jsonl");
process.env.TIERLESS_MEASURE_OUT = OUT;
process.env.TIERLESS_WIRE_URLS = "http://127.0.0.1:" + (counter.address() as { port: number }).port + "/__tierless/wire";
// env is read at import time — set it BEFORE the module loads (as a suite config would)
const { default: Reporter } = await import("tierless/playwright-reporter");

const reporter = new Reporter();
reporter.onBegin({ rootDir: "/suite", projects: [{ name: "chromium" }] });
const test = (file: string, line: number, titles: string[]) => ({
  location: { file, line },
  titlePath: () => ["", "chromium", path.relative("/suite", file), ...titles],
});

// attempt 1: counters move by (23, 45) during the test
await reporter.onTestBegin(test("/suite/tests/e2e/foo.spec.ts", 42, ["Suite", "does thing"]));
wsIn += 23; wsOut += 45;
await reporter.onTestEnd(test("/suite/tests/e2e/foo.spec.ts", 42, ["Suite", "does thing"]), { status: "passed", retry: 0, duration: 123 });

// attempt 2: the counter endpoint dies mid-test — the row must be flagged, not wrong
await reporter.onTestBegin(test("/suite/tests/e2e/bar.spec.ts", 7, ["fails to read wire"]));
up = false;
await reporter.onTestEnd(test("/suite/tests/e2e/bar.spec.ts", 7, ["fails to read wire"]), { status: "failed", retry: 1, duration: 55 });

const rows = readFileSync(OUT, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
check("one JSONL row per attempt", rows.length === 2);
check("id is suite-relative file:line › titles (project and file segments dropped — the join key matches across arms)", rows[0].id === "tests/e2e/foo.spec.ts:42 › Suite › does thing", rows[0].id);
check("status/retry/duration recorded", rows[0].status === "passed" && rows[0].retry === 0 && rows[0].durationMs === 123);
check("wire deltas are the counter movement across the attempt", rows[0].wireWsIn === 23 && rows[0].wireWsOut === 45, JSON.stringify(rows[0]));
check("a failed counter read flags the row instead of shipping wrong deltas", rows[1].wireError === true && !("wireWsIn" in rows[1]), JSON.stringify(rows[1]));
check("reporter stays out of the suite's own stdout", new Reporter().printsToStdio() === false);

counter.close();
const { pass, fail } = counts();
console.log(fail === 0
  ? `OK — the measure reporter ships as tierless/playwright-reporter: arm-stable JSONL ids, per-attempt wire deltas, and flagged (never fabricated) rows on counter failure (${pass} checks)`
  : `FAIL (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

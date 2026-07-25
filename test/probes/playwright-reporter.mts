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

// The hooks are NOT awaited by Playwright, so the probe does not await them either —
// ordering must come from the reporter's own chain, not from the caller.
const t1 = test("/suite/tests/e2e/foo.spec.ts", 42, ["Suite", "does thing"]);
const t2 = test("/suite/tests/e2e/bar.spec.ts", 7, ["fails to read wire"]);
const t3 = test("/suite/tests/e2e/baz.spec.ts", 9, ["after the failure"]);
const t4 = test("/suite/tests/e2e/qux.spec.ts", 11, ["between-test traffic"]);

// Time passes between hooks in a real run, so the probe lets the reporter's chain drain
// between steps — but never awaits a hook's return value, since Playwright does not.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25));
await settle();               // onBegin's opening snapshot lands

// attempt 1: counters move by (23, 45) during the test
wsIn += 23; wsOut += 45;
reporter.onTestEnd(t1, { status: "passed", retry: 0, duration: 123 });
await settle();

// attempt 2: the counter endpoint dies — the row must be flagged, not wrong
up = false;
reporter.onTestEnd(t2, { status: "failed", retry: 1, duration: 55 });
await settle();

// attempt 3: the endpoint recovers; the ledger must still balance across the outage
up = true;
wsIn += 7; wsOut += 11;
reporter.onTestEnd(t3, { status: "passed", retry: 0, duration: 60 });
await settle();

// attempt 4: traffic BETWEEN tests (fixture setup, teardown). Two independent reads per
// test would drop it on the floor; chaining hands it to the next test.
wsIn += 100; wsOut += 200;   // <- after t3 closed, before t4 "runs"
wsIn += 5;   wsOut += 5;     // <- during t4
reporter.onTestEnd(t4, { status: "passed", retry: 0, duration: 20 });
await settle();
const rows = readFileSync(OUT, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
check("one JSONL row per attempt, in order, without the caller awaiting the hooks", rows.length === 4 && String(rows[3].id).includes("qux"), rows.length + " rows");

// CONSERVATION is the property that matters: per-test deltas may jitter across a
// boundary, but their sum must equal the counters' total movement. Two independent reads
// per test lost the between-test traffic — 155 MB of 6.13 GB on one n8n arm, and
// ASYMMETRICALLY (1.21% on the other), which is larger than the difference being measured.
const summed = rows.reduce((a, r) => a + ((r.wireWsIn as number) ?? 0) + ((r.wireWsOut as number) ?? 0), 0);
check("sum of per-test deltas === total counter movement (nothing lost between tests)", summed === (23 + 45) + (7 + 11) + (100 + 200) + (5 + 5), summed + " vs " + ((23 + 45) + (7 + 11) + (100 + 200) + (5 + 5)));
check("traffic occurring BETWEEN tests is attributed to the next test, not dropped", ((rows[3].wireWsIn as number) + (rows[3].wireWsOut as number)) === 310, JSON.stringify(rows[3]));
check("a failed read does not reset the ledger — the next good read absorbs the gap", ((rows[2].wireWsIn as number) + (rows[2].wireWsOut as number)) === 18, JSON.stringify(rows[2]));
check("id is suite-relative file:line › titles (project and file segments dropped — the join key matches across arms)", rows[0].id === "tests/e2e/foo.spec.ts:42 › Suite › does thing", rows[0].id);
check("status/retry/duration recorded", rows[0].status === "passed" && rows[0].retry === 0 && rows[0].durationMs === 123);
check("wire deltas are the counter movement across the attempt", rows[0].wireWsIn === 23 && rows[0].wireWsOut === 45, JSON.stringify(rows[0]));
check("a failed counter read flags the row instead of shipping wrong deltas", rows[1].wireError === true && !("wireWsIn" in rows[1]), JSON.stringify(rows[1]));
check("reporter stays out of the suite's own stdout", new Reporter().printsToStdio() === false);

counter.close();
const { pass, fail } = counts();
console.log(fail === 0
  ? `OK — the measure reporter ships as tierless/playwright-reporter: arm-stable JSONL ids, CONSERVING per-attempt wire deltas (nothing lost between tests), and flagged (never fabricated) rows on counter failure (${pass} checks)`
  : `FAIL (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

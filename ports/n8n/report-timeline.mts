// Per-test request timelines for the wall regression (#32) — distinguishes, per test of
// one spec run in budget mode on both arms:
//   (a) ISSUED LATER  — the same request starts later relative to navigation (phase shift)
//   (b) SERVED SLOWER — the same request takes longer start->end
//   (c) POST-SETTLE   — network goes quiet at the same point but the test still ends later
//       (render/main-thread contention after the last byte)
// Inputs (ports/n8n/results/timeline/, written by the timeline driver):
//   {arm}-http.jsonl      http-log-proxy lines {ts,startedAt,method,path,...} — ALL browser HTTP
//   ported-session.jsonl  gateway TIERLESS_WIRE_LOG {ts,d,k,t,p} frames + {ph:"exec",ms,p}
//   {arm}-measure.jsonl   reporter rows, index-aligned across arms (same spec, workers=1)
// Tests are segmented by the per-test navigation anchor (GET /workflow/new): 8 per arm on
// canvas-nodes. Relay cost is symmetric within an arm, so timeline SHAPE is comparable;
// absolute wall is not quoted from this instrument.
//   node ports/n8n/report-timeline.mts
import { fileURLToPath } from "node:url";
import { readJsonl } from "../read-jsonl.mts";

const DIR = fileURLToPath(new URL("./results/timeline/", import.meta.url));
const load = (f: string) => readJsonl(DIR + f);

interface Http { ts: number; startedAt: number; method: string; path: string; status: number }
interface Ev { rel: number; dur: number; path: string; kind: "http" | "crossing" }

// IDs differ across arms (each run seeds its own workflows) — normalize so paths join.
const norm = (p: string) =>
  p.split("?")[0]
    .replace(/\/workflows\/[A-Za-z0-9]{10,}/, "/workflows/:id")
    .replace(/\/workflow-history\/workflow\/[A-Za-z0-9]{10,}/, "/workflow-history/workflow/:id")
    .replace(/\/version\/[0-9a-f-]{36}/, "/version/:v")
    .replace(/\/executions\/\d+/, "/executions/:n")
  + (p.includes("?") ? "?" + p.split("?")[1].replace(/=[A-Za-z0-9-]+/g, "=:v") : "");

function windows(http: Http[]): { anchor: number; end: number }[] {
  const anchors = http.filter((r) => r.method === "GET" && r.path.split("?")[0] === "/workflow/new").map((r) => r.startedAt);
  return anchors.map((a, i) => ({ anchor: a, end: anchors[i + 1] ?? Infinity }));
}

function arm(name: "baseline" | "ported") {
  const http = load(`${name}-http.jsonl`) as Http[];
  const ws = windows(http);
  const tests: Ev[][] = ws.map(() => []);
  const place = (t: number): number => ws.findIndex((w) => t >= w.anchor && t < w.end);
  for (const r of http) {
    const i = place(r.startedAt);
    if (i >= 0) tests[i].push({ rel: r.startedAt - ws[i].anchor, dur: r.ts - r.startedAt, path: norm(r.path), kind: "http" });
  }
  if (name === "ported") {
    // crossings: "in" exec frame = browser request arrival at gateway; the matching
    // "out" reply (same normalized path, FIFO within a path) ends it
    const ses = load("ported-session.jsonl");
    const pend = new Map<string, number[]>();
    for (const r of ses) {
      if (r.d === "in" && r.t === "exec") (pend.get(norm(r.p)) ?? pend.set(norm(r.p), []).get(norm(r.p))!).push(r.ts);
      else if (r.d === "out" && r.k === "reply" && r.p !== undefined) {
        const q = pend.get(norm(r.p));
        const t0 = q?.shift();
        if (t0 === undefined) continue;
        const i = place(t0);
        if (i >= 0) tests[i].push({ rel: t0 - ws[i].anchor, dur: r.ts - t0, path: norm(r.p), kind: "crossing" });
      }
    }
  }
  const measure = load(`${name}-measure.jsonl`).filter((r) => r.retry === 0);
  return { ws, tests, measure };
}

const med = (a: number[]) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : NaN);

const B = arm("baseline"), P = arm("ported");
if (B.ws.length !== P.ws.length) throw new Error(`window mismatch: ${B.ws.length} vs ${P.ws.length}`);

console.log(`tests: ${B.ws.length} (windowed by GET /workflow/new)\n`);
console.log("per-test: wall delta vs where the time sits (all ms; rel = since navigation)");
console.log("  quiet = last network activity ends; tailGap = wall - quiet (post-settle time)");

const shifts: { path: string; dRel: number; dDur: number; n: number }[] = [];
for (let i = 0; i < B.ws.length; i++) {
  const bw = B.measure[i].durationMs, pw = P.measure[i].durationMs;
  const quiet = (evs: Ev[]) => Math.max(...evs.map((e) => e.rel + e.dur), 0);
  const bq = quiet(B.tests[i]), pq = quiet(P.tests[i]);
  console.log(
    `#${i} wall ${bw}->${pw} (${pw - bw >= 0 ? "+" : ""}${pw - bw})  ` +
    `reqs ${B.tests[i].length}->${P.tests[i].length}  quiet@ ${bq}->${pq} (${pq - bq >= 0 ? "+" : ""}${pq - bq})  ` +
    `tailGap ${bw - bq}->${pw - pq}`
  );
  // per-path join within this test
  const by = (evs: Ev[]) => {
    const m = new Map<string, Ev[]>();
    evs.forEach((e) => (m.get(e.path) ?? m.set(e.path, []).get(e.path)!).push(e));
    return m;
  };
  const bm = by(B.tests[i]), pm = by(P.tests[i]);
  for (const [path, bes] of bm) {
    const pes = pm.get(path);
    if (!pes) continue;
    shifts.push({ path, dRel: med(pes.map((e) => e.rel)) - med(bes.map((e) => e.rel)), dDur: med(pes.map((e) => e.dur)) - med(bes.map((e) => e.dur)), n: Math.min(bes.length, pes.length) });
  }
}

// aggregate: which paths shifted (issued later) or slowed (served slower), suite-wide
const agg = new Map<string, { dRel: number[]; dDur: number[]; n: number }>();
for (const s of shifts) {
  const a = agg.get(s.path) ?? { dRel: [], dDur: [], n: 0 };
  a.dRel.push(s.dRel); a.dDur.push(s.dDur); a.n += s.n;
  agg.set(s.path, a);
}
const rows = [...agg].map(([path, a]) => ({ path, dRel: med(a.dRel), dDur: med(a.dDur), n: a.n }))
  .filter((r) => Math.abs(r.dRel) > 30 || Math.abs(r.dDur) > 30)
  .sort((x, y) => Math.abs(y.dRel) + Math.abs(y.dDur) - (Math.abs(x.dRel) + Math.abs(x.dDur)));
console.log("\npaths shifted >30ms (median across tests; +dRel = ported issues LATER, +dDur = ported serves SLOWER):");
for (const r of rows.slice(0, 25)) console.log(`  dRel ${String(Math.round(r.dRel)).padStart(6)}  dDur ${String(Math.round(r.dDur)).padStart(6)}  n=${String(r.n).padStart(3)}  ${r.path.slice(0, 80)}`);

const totRel = med(shifts.map((s) => s.dRel)), totDur = med(shifts.map((s) => s.dDur));
console.log(`\nmedians over all matched paths: dRel ${Math.round(totRel)} ms, dDur ${Math.round(totDur)} ms`);
console.log("read: (a) phase-shift if dRel dominates; (b) service if dDur dominates; (c) post-settle if tailGap grows while quiet@ holds");

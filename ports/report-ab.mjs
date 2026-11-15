#!/usr/bin/env node
// Two builds, same suite (an A/B of the framework): I/O wait per arm, crossings by kind,
// resumes per test, and the gateway's time per crossing from the wire log.
//
//   node ports/report-ab.mjs <oldDir> <newDir>      (e.g. ports/keycloak/results/ab-20mbit/{old,new})
//
// Per dir, kind K in {fetch, profile}, round r in 1..3 (any may be missing):
//   K-r<r>.jsonl        Playwright rows {id, status, retry, durationMs, startMs, ioWaitMs}
//   K-r<r>.io           "<t0> <t1> <kind> <label>" intervals (relay crossings, HTTP, socket opens)
//   wire-K-r<r>.jsonl   gateway wire log, TIERLESS_WIRE_LOG (optional)
//   parks-K-r<r>.jsonl  park log, TIERLESS_PARK_LOG (optional)
// I/O wait here is the mean of per-round sums; ports/report-io.mts sums per-test medians.
// A migrated chain's REST calls run on the gateway's twin and log no exec line, so a
// resume's gateway time includes them.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [oldDir, newDir] = process.argv.slice(2);
if (!oldDir || !newDir) { console.error("usage: node ports/report-ab.mjs <oldDir> <newDir>"); process.exit(2); }
const DIRS = [["old", oldDir], ["new", newDir]];
const KINDS = ["fetch", "profile"];
const ROUNDS = [1, 2, 3];

// ---------- helpers
const out = (s = "") => console.log(s);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (x, d = 0) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(d));
const sgn = (x, d = 0) => (Number.isFinite(x) ? (x > 0 ? "+" : "") + x.toFixed(d) : "-");
const sec = (ms) => fmt(ms / 1000, 1);
function table(rows, left = 1, indent = "  ") {
  const w = [];
  for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] ?? 0, String(c).length); });
  for (const r of rows) out(indent + r.map((c, i) => (i < left ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join("  ").trimEnd());
}
// union length of [s, e] intervals clipped to [from, to]
function unionMs(xs, from, to) {
  const ys = xs.map(([s, e]) => [Math.max(s, from), Math.min(e, to)]).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0, cs = 0, ce = -Infinity;
  for (const [s, e] of ys) { if (s > ce) { if (ce > cs) total += ce - cs; cs = s; ce = e; } else if (e > ce) ce = e; }
  return ce > cs ? total + ce - cs : total;
}
const short = (id) => {
  const parts = id.replace(/^[^/]*\//, "").split(" › ");
  const s = parts.length > 1 ? parts[0] + " " + parts[parts.length - 1] : parts[0];
  return s.length > 50 ? s.slice(0, 47) + "..." : s;
};
const normPath = (p) => p.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>");

// ---------- readers (never throw; count malformed lines)
const malformed = [];
const readLines = (file) => { try { return readFileSync(file, "utf8").split("\n"); } catch { return null; } };
function readJsonl(file, valid = () => true) {
  const ls = readLines(file); if (!ls) return null;
  const rows = []; let bad = 0;
  for (const l of ls) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o && typeof o === "object" && !Array.isArray(o) && valid(o)) rows.push(o); else bad++; } catch { bad++; }
  }
  if (bad) malformed.push(`${file}: ${bad} skipped`);
  return rows;
}
const category = (kind, label) => (kind === "cross" ? "cross " + label.split(":")[0] : kind === "http" ? "http" : kind === "open" ? "open " + label : kind);
function readIo(file) {
  const ls = readLines(file); if (!ls) return null;
  const xs = []; let bad = 0;
  for (const l of ls) {
    if (!l.trim()) continue;
    const m = /^(\d+) (\d+) (\S+)(?: (.*))?$/.exec(l.trim());
    if (!m || +m[2] < +m[1]) { bad++; continue; }
    const label = m[4] ?? "";
    xs.push({ t0: +m[1], t1: +m[2], ms: +m[2] - +m[1], cat: category(m[3], label), label });
  }
  if (bad) malformed.push(`${file}: ${bad} skipped`);
  return xs.sort((a, b) => a.t0 - b.t0);
}
const fin = Number.isFinite;
const validRow = (r) => typeof r.id === "string" && typeof r.status === "string" && fin(r.startMs) && fin(r.durationMs) && fin(r.ioWaitMs);
const validWire = (o) => fin(o.ts) && (o.ph !== "exec" || fin(o.ms));
const validPark = (o) => fin(o.ts);

// ---------- load
const runs = [];
for (const [dir, path] of DIRS) for (const kind of KINDS) for (const round of ROUNDS) {
  const base = `${kind}-r${round}`;
  runs.push({
    dir, kind, round, name: `${dir}/${base}`,
    rows: readJsonl(join(path, base + ".jsonl"), validRow),
    io: readIo(join(path, base + ".io")),
    wire: readJsonl(join(path, `wire-${base}.jsonl`), validWire),
    parks: readJsonl(join(path, `parks-${base}.jsonl`), validPark),
  });
}
out(`A/B analysis  old=${oldDir}  new=${newDir}`);
out();
out("Inputs found (line counts; - = missing)");
table([["run", "jsonl", "io", "wire", "parks"], ...runs.map((r) => [r.name, r.rows?.length ?? "-", r.io?.length ?? "-", r.wire?.length ?? "-", r.parks?.length ?? "-"])]);
for (const m of malformed) out("  malformed: " + m);
const present = runs.filter((r) => r.rows?.length);
const absentJsonl = runs.filter((r) => r.rows && !r.rows.length);
for (const r of absentJsonl) out(`  ${r.name}.jsonl has no valid rows: run ignored`);
if (!present.length) { out("no runs with Playwright rows: nothing to report"); process.exit(0); }
const get = (dir, kind, round) => present.find((r) => r.dir === dir && r.kind === kind && r.round === round);
const runsOf = (dir, kind) => present.filter((r) => r.dir === dir && r.kind === kind);

// ---------- 1. test set
for (const r of present) {
  r.byId = new Map();
  for (const x of r.rows) { const a = r.byId.get(x.id) ?? []; a.push(x); r.byId.set(x.id, a); }
}
const passRow = (r, id) => r.byId.get(id)?.find((x) => x.status === "passed" && !(x.retry > 0));
const universe = [...new Set(present.flatMap((r) => [...r.byId.keys()]))].sort();
const testSet = universe.filter((id) => present.every((r) => passRow(r, id)));
const inSet = new Set(testSet);
out();
out(`1. Test set: ${testSet.length} of ${universe.length} tests pass (first attempt) in all ${present.length} present runs; ${universe.length - testSet.length} dropped`);
for (const id of universe.filter((id) => !inSet.has(id))) {
  const bad = present.filter((r) => !passRow(r, id)).map((r) => [r.name, (r.byId.get(id) ?? []).map((x) => x.status + (x.retry > 0 ? "@retry" + x.retry : "")).join("/") || "missing"]);
  const statuses = new Set(bad.map((b) => b[1]));
  const why = bad.length === present.length && statuses.size === 1 ? `${[...statuses][0]} in all ${present.length} runs` : bad.map((b) => `${b[0]} ${b[1]}`).join(", ");
  out(`  dropped: ${id.replace(/^[^/]*\//, "")}  (${why})`);
}
// test-set windows per run; an interval belongs to the first window holding its start
for (const r of present) {
  r.win = testSet.map((id) => { const x = passRow(r, id); return { id, s: x.startMs, e: x.startMs + x.durationMs }; }).sort((a, b) => a.s - b.s);
  let overlaps = 0;
  for (let i = 1; i < r.win.length; i++) if (r.win[i].s < r.win[i - 1].e) overlaps++;
  if (overlaps) out(`  warning: ${r.name} has ${overlaps} overlapping test windows (intervals go to the earlier test)`);
  r.testOf = (t) => r.win.find((w) => w.s <= t && t <= w.e)?.id;
  r.ioIn = r.io?.map((x) => ({ ...x, test: r.testOf(x.t0) })).filter((x) => x.test);
}

// ---------- 2. I/O wait
const ioWait = (r) => sum(testSet.map((id) => passRow(r, id).ioWaitMs));
const stats = (xs) => ({ xs, mean: mean(xs), min: Math.min(...xs), max: Math.max(...xs), spread: xs.length ? Math.max(...xs) - Math.min(...xs) : NaN });
const perRound = (f) => ROUNDS.map(f);
out();
out(`2. I/O wait over the test set (s, sum of ioWaitMs over ${testSet.length} tests)`);
const ioRows = [["", "", ...ROUNDS.map((n) => "r" + n), "mean", "min-max", "spread"]];
const ioStat = {};
for (const [dir] of DIRS) {
  for (const kind of KINDS) {
    const v = perRound((n) => (get(dir, kind, n) ? ioWait(get(dir, kind, n)) : NaN));
    const st = stats(v.filter(fin)); ioStat[`${dir}/${kind}`] = st;
    ioRows.push([dir, kind, ...v.map(sec), sec(st.mean), st.xs.length ? `${sec(st.min)}-${sec(st.max)}` : "-", sec(st.spread)]);
  }
  const v = perRound((n) => (get(dir, "fetch", n) && get(dir, "profile", n) ? ioWait(get(dir, "fetch", n)) - ioWait(get(dir, "profile", n)) : NaN));
  const st = stats(v.filter(fin)); ioStat[`${dir}/saving`] = st;
  ioRows.push([dir, "saving", ...v.map(sec), sec(st.mean), st.xs.length ? `${sec(st.min)}-${sec(st.max)}` : "-", sec(st.spread)]);
}
table(ioRows, 2);
out("  old vs new (spread = max-min over rounds; 'exceeds' = |new-old| > larger spread)");
const cmpRows = [["", "old", "new", "new-old", "old spread", "new spread", "exceeds"]];
for (const k of [...KINDS, "saving"]) {
  const o = ioStat[`old/${k}`], n = ioStat[`new/${k}`], d = n.mean - o.mean;
  const verdict = !fin(d) ? "-" : o.xs.length < 2 || n.xs.length < 2 ? "n/a (<2 rounds)" : Math.abs(d) > Math.max(o.spread, n.spread) ? "yes" : "no";
  cmpRows.push([k, sec(o.mean), sec(n.mean), sgn(d / 1000, 1), sec(o.spread), sec(n.spread), verdict]);
}
table(cmpRows);

// ---------- 3. interval kinds from .io
const CAT_ORDER = ["cross resume", "cross exec", "http", "open socket"];
const cats = [...new Set(present.flatMap((r) => (r.ioIn ?? []).map((x) => x.cat)))]
  .sort((a, b) => (CAT_ORDER.indexOf(a) + 1 || 99) - (CAT_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
out();
out("3. Intervals from .io starting inside test-set windows (count/run, ms; ms/run = summed durations, not union)");
const iRows = [["interval", "kind", "dir", "runs", "n/run", "mean", "median", "ms/run"]];
for (const cat of cats) for (const kind of KINDS) for (const [dir] of DIRS) {
  const rs = runsOf(dir, kind).filter((r) => r.ioIn);
  if (!rs.length) continue;
  const d = rs.flatMap((r) => r.ioIn.filter((x) => x.cat === cat).map((x) => x.ms));
  if (!d.length) continue;
  iRows.push([cat, kind, dir, rs.length, fmt(d.length / rs.length), fmt(mean(d)), fmt(median(d)), fmt(sum(d) / rs.length)]);
}
table(iRows, 3);

// ---------- 4. resume composition per test
out();
out("4. Resume composition per test (from .io; per run = mean over rounds with .io)");
for (const kind of KINDS) {
  const rs = Object.fromEntries(DIRS.map(([dir]) => [dir, runsOf(dir, kind).filter((r) => r.ioIn)]));
  if (!rs.old.length || !rs.new.length) { out(`  ${kind}: skipped (needs .io in both dirs)`); continue; }
  // each run's first resume in the test set: a one-time warm-up cost, not a per-crossing one
  const firstOf = (r) => r.ioIn.find((x) => x.cat === "cross resume");
  const firsts = new Set([...rs.old, ...rs.new].map(firstOf).filter(Boolean));
  const res = (r, id) => r.ioIn.filter((x) => x.cat === "cross resume" && x.test === id);
  // per-run lists -> mean count/run, mean ms/run, pooled durations
  const agg = (perRun, keep = () => true) => { const a = perRun.map((xs) => xs.filter(keep)); return { n: mean(a.map((xs) => xs.length)), ms: mean(a.map((xs) => sum(xs.map((x) => x.ms)))), d: a.flat().map((x) => x.ms) }; };
  const perTest = testSet.map((id) => {
    const o = rs.old.map((r) => res(r, id)), n = rs.new.map((r) => res(r, id));
    const t = { id, o, n, O: agg(o), N: agg(n) };
    t.group = t.O.n === t.N.n ? "same" : t.N.n < t.O.n ? "fewer" : "more";
    return t;
  }).filter((t) => t.O.n > 0 || t.N.n > 0);
  if (!perTest.length) { out(`  ${kind}: no resumes`); continue; }
  out(`  ${kind}: ${perTest.length} tests with resumes; runs old ${rs.old.length}, new ${rs.new.length}`);
  table([["test", "old n/run", "new n/run", "old ms/run", "new ms/run", "group"],
    ...perTest.map((t) => [short(t.id), fmt(t.O.n, 1), fmt(t.N.n, 1), fmt(t.O.ms), fmt(t.N.ms), t.group])], 1, "    ");
  out(`  ${kind} by group (mean/median = per resume, pooled over runs; "w/o 1st" = each run's first test-set resume left out)`);
  const gRows = [["group", "tests", "old n/run", "new n/run", "old ms/run", "new ms/run", "old mean", "new mean", "new-old", "old med", "new med"]];
  const notFirst = (x) => !firsts.has(x);
  for (const g of ["same", "fewer", "more", "all"]) {
    const ts = perTest.filter((t) => g === "all" || t.group === g);
    if (!ts.length) continue;
    const variants = [[g, undefined]];
    if (ts.some((t) => [...t.o, ...t.n].flat().some((x) => firsts.has(x)))) variants.push([g + " w/o 1st", notFirst]);
    for (const [label, keep] of variants) {
      const O = ts.map((t) => agg(t.o, keep)), N = ts.map((t) => agg(t.n, keep));
      const od = O.flatMap((a) => a.d), nd = N.flatMap((a) => a.d);
      gRows.push([label, ts.length, fmt(sum(O.map((a) => a.n)), 1), fmt(sum(N.map((a) => a.n)), 1), fmt(sum(O.map((a) => a.ms))), fmt(sum(N.map((a) => a.ms))),
        fmt(mean(od)), fmt(mean(nd)), sgn(mean(nd) - mean(od)), fmt(median(od)), fmt(median(nd))]);
    }
  }
  table(gRows, 1, "    ");
  out(`    first test-set resume per run (ms, test): ${DIRS.map(([dir]) => `${dir} ` + rs[dir].map((r) => { const x = firstOf(r); return `r${r.round} ${x ? x.ms + " " + short(x.test).split(" ")[0] : "-"}`; }).join(", ")).join("; ")}`);
  out(`    resumes before the first test-set window (warm-up outside the set): ${DIRS.map(([dir]) => `${dir} ` + rs[dir].map((r) => `r${r.round} ${r.io.filter((x) => x.cat === "cross resume" && x.t0 < r.win[0].s).length}`).join(", ")).join("; ")}`);
  const parks = DIRS.map(([dir]) => {
    const pr = runsOf(dir, kind).filter((r) => r.parks);
    return `${dir} ${pr.length ? fmt(mean(pr.map((r) => r.parks.filter((p) => r.testOf(p.ts)).length)), 1) + "/run (" + pr.length + " runs)" : "-"}`;
  });
  out(`    parks in test set: ${parks.join(", ")}`);
}
// migrated chains call Keycloak through the gateway's twin client, which logs no exec line;
// the fetch arm crosses every such call as an exec, so the count gap estimates them
out("  REST calls inside resumes, estimate = (fetch exec n/run - profile exec n/run) / profile resumes n/run (assumes both arms make the same calls)");
const nPerRun = (dir, kind, cat) => { const rs = runsOf(dir, kind).filter((r) => r.ioIn); return rs.length ? mean(rs.map((r) => r.ioIn.filter((x) => x.cat === cat).length)) : NaN; };
table([["dir", "fetch exec n/run", "profile exec n/run", "resumes n/run", "REST calls/resume"], ...DIRS.map(([dir]) => {
  const f = nPerRun(dir, "fetch", "cross exec"), p = nPerRun(dir, "profile", "cross exec"), n = nPerRun(dir, "profile", "cross resume");
  return [dir, fmt(f, 1), fmt(p, 1), fmt(n, 1), fmt((f - p) / n, 2)];
})], 1, "    ");
// exec crossings compared path by path: removes the path mix from the per-crossing comparison
out("  exec crossings by API path, paths seen in both dirs (diff = per-path mean diff, weighted by count)");
for (const kind of KINDS) {
  const byPath = Object.fromEntries(DIRS.map(([dir]) => {
    const m = new Map(), rs = runsOf(dir, kind).filter((r) => r.ioIn);
    for (const r of rs) for (const x of r.ioIn) {
      if (x.cat !== "cross exec") continue;
      const p = normPath(x.label.replace(/^exec:/, ""));
      (m.get(p) ?? m.set(p, []).get(p)).push(x.ms);
    }
    return [dir, { m, runs: rs.length }];
  }));
  const common = [...byPath.old.m.keys()].filter((p) => byPath.new.m.has(p));
  if (!common.length) { out(`    ${kind}: no common paths`); continue; }
  const rows = common.map((p) => { const o = byPath.old.m.get(p), n = byPath.new.m.get(p); return { p, no: o.length, nn: n.length, mo: mean(o), mn: mean(n), w: o.length + n.length }; }).sort((a, b) => b.w - a.w);
  const wd = sum(rows.map((x) => x.w * (x.mn - x.mo))) / sum(rows.map((x) => x.w));
  out(`    ${kind}: ${common.length} paths, ${sum(rows.map((x) => x.no))} old / ${sum(rows.map((x) => x.nn))} new crossings; weighted diff new-old ${sgn(wd, 1)} ms`);
  table([["path (top 6)", "old n/run", "new n/run", "old mean", "new mean", "new-old"],
    ...rows.slice(0, 6).map((x) => [x.p.length > 60 ? x.p.slice(0, 57) + "..." : x.p, fmt(x.no / byPath.old.runs, 1), fmt(x.nn / byPath.new.runs, 1), fmt(x.mo), fmt(x.mn), sgn(x.mn - x.mo)])], 1, "      ");
}

// ---------- 5. wire log
// Request ids restart at 1 on every socket and the log has no socket id. An exec reply carries
// its request's API path (wireLogPort's per-socket map); a resume and its reply carry none.
// So a reply pairs with a pending same-id request of the same path, the latest one (an earlier
// one still pending means a lost reply). Two same-id, same-path requests pending at once cannot
// be told apart: both are ambiguous and left out of attribution and every metric.
function analyzeWire(r) {
  const pairs = [], pending = new Map(), ph = [];
  const pathOf = (o) => o.p ?? null;
  let orphan = 0;
  for (const o of r.wire) {
    if (o.ph === "exec") { ph.push(o); continue; }
    if (o.d === "in" && o.k === "request") {
      const q = pending.get(o.id) ?? [];
      const req = { ...o, amb: false };
      for (const x of q) if (pathOf(x) === pathOf(req)) x.amb = req.amb = true;
      q.push(req); pending.set(o.id, q);
    } else if (o.d === "out" && o.k === "reply") {
      const q = pending.get(o.id) ?? [];
      const k = q.findLastIndex((x) => pathOf(x) === pathOf(o));
      if (k < 0) { orphan++; continue; }
      const [req] = q.splice(k, 1);
      pairs.push({ t: req.t, req, rep: o, amb: req.amb, gw: o.ts - req.ts, execs: [] });
    }
  }
  const unanswered = [...pending.values()].flat();
  // attribute each exec phase line among clean pairs open over the whole call (request in
  // before the call started, reply out after it ended): first to an exec request with the
  // same path, closest reply first; else to the one open resume; several = ambiguous, left out
  const clean = pairs.filter((x) => !x.amb).sort((a, b) => a.req.ts - b.req.ts);
  let i = 0, phAmb = 0, phNone = 0; const active = [];
  for (const e of ph.sort((a, b) => a.ts - b.ts)) {
    while (i < clean.length && clean[i].req.ts <= e.ts) active.push(clean[i++]);
    for (let k = active.length - 1; k >= 0; k--) if (active[k].rep.ts < e.ts) active.splice(k, 1);
    const p = String(e.p ?? ""), open = active.filter((x) => x.req.ts <= e.ts - e.ms);
    const ex = open.filter((x) => (x.t === "exec" && !x.execs.length && (x.req.p === undefined || x.req.p === p)) || x.t === "execBatch");
    if (ex.length) { ex.sort((a, b) => a.rep.ts - b.rep.ts)[0].execs.push(e); continue; }
    const rs = open.filter((x) => x.t === "resume");
    if (rs.length === 1) rs[0].execs.push(e); else if (rs.length > 1) phAmb++; else phNone++;
  }
  for (const x of pairs) {
    x.test = r.testOf(x.req.ts);
    x.execMs = sum(x.execs.map((e) => e.ms));
    x.execUnion = unionMs(x.execs.map((e) => [e.ts - e.ms, e.ts]), x.req.ts, x.rep.ts);
    x.resid = x.gw - x.execUnion;
  }
  return { pairs, inSet: pairs.filter((x) => x.test && !x.amb), ambIn: pairs.filter((x) => x.test && x.amb).length, orphan, unanswered, phTotal: ph.length, phAmb, phNone };
}
const wireRuns = present.filter((r) => r.wire);
for (const r of wireRuns) r.w = analyzeWire(r);
out();
out("5. Gateway wire log (pairs whose request starts inside a test-set window)");
if (!wireRuns.length) out("  no wire logs found");
for (const kind of KINDS) {
  const wr = Object.fromEntries(DIRS.map(([dir]) => [dir, wireRuns.filter((r) => r.dir === dir && r.kind === kind)]));
  if (!wr.old.length && !wr.new.length) continue;
  out(`  ${kind}: wire runs old ${wr.old.map((r) => "r" + r.round).join(",") || "-"}, new ${wr.new.map((r) => "r" + r.round).join(",") || "-"}`);
  for (const [dir] of DIRS) for (const r of wr[dir]) {
    const w = r.w, c = (t) => w.pairs.filter((x) => x.t === t).length;
    out(`    ${r.name}: pairs ${w.pairs.length} (resume ${c("resume")}, exec ${c("exec")}${c("execBatch") ? ", execBatch " + c("execBatch") : ""}), in test set ${w.inSet.length} + ${w.ambIn} ambiguous left out, orphan replies ${w.orphan}, unanswered ${w.unanswered.length}; exec lines ${w.phTotal}, unattributed ${w.phNone}, ambiguous ${w.phAmb}`);
    if (w.unanswered.length) out(`      warning: ${w.unanswered.length} unanswered (lost reply?): ${w.unanswered.slice(0, 3).map((x) => `${x.t} id ${x.id} at ${x.ts}${x.p !== undefined ? " " + x.p : ""}`).join(", ")}${w.unanswered.length > 3 ? ", ..." : ""}`);
  }
  for (const t of ["resume", "exec", "execBatch"]) {
    const ps = Object.fromEntries(DIRS.map(([dir]) => [dir, wr[dir].flatMap((r) => r.w.inSet.filter((x) => x.t === t))]));
    if (!ps.old.length && !ps.new.length) continue;
    const metrics = [["gateway ms", (x) => x.gw], ["app exec calls", (x) => x.execs.length, 2], ["app exec ms (sum)", (x) => x.execMs], ["app exec ms (union)", (x) => x.execUnion],
      ["gw - app exec ms", (x) => x.resid], ["request bytes", (x) => x.req.n], ["reply bytes", (x) => x.rep.n]];
    const col = (dir, f, d = 0) => { const v = ps[dir].map(f).filter(fin); return [fmt(mean(v), d), fmt(median(v))]; };
    out(`    ${t}: n old ${ps.old.length}, new ${ps.new.length} (gw - app exec = gateway ms - app exec ms union)`);
    if (t === "resume") out("      app exec only: twin REST calls (migrated chains' Keycloak calls) log no exec line, so 'gw - app exec' includes them; it is not framework time");
    table([["", "old mean", "old med", "new mean", "new med"], ...metrics.map(([name, f, d]) => [name, ...col("old", f, d), ...col("new", f, d)])], 1, "      ");
    const dist = (dir, f) => { const m = {}; for (const x of ps[dir]) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return Object.entries(m).sort((a, b) => (+a[0] - +b[0]) || a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join(" ") || "-"; };
    out(`      reply types: old ${dist("old", (x) => x.rep.t)}; new ${dist("new", (x) => x.rep.t)}`);
    if (t === "resume") out(`      app exec calls per resume (twin REST calls not logged): old ${dist("old", (x) => x.execs.length)}; new ${dist("new", (x) => x.execs.length)}`);
  }
}

// ---------- 6. network share of a crossing: relay time minus gateway time
// matched: a wire pair whose request and reply both fall inside the relay interval (+-1 ms rounding);
// exec pairs must also carry the same API path
function match(ioXs, pairs, byPath) {
  const used = new Set(), nets = [];
  let j0 = 0;
  for (const x of ioXs) {
    while (j0 < pairs.length && pairs[j0].req.ts < x.t0 - 1) j0++;
    for (let j = j0; j < pairs.length && pairs[j].req.ts <= x.t1 + 1; j++) {
      const p = pairs[j];
      if (used.has(p) || p.rep.ts > x.t1 + 1) continue;
      if (byPath && p.req.p !== undefined && /\((.*)\)/.exec(x.label)?.[1] !== String(p.req.p).split("?")[0]) continue;
      used.add(p); nets.push(x.ms - p.gw); break;
    }
  }
  return nets;
}
out();
// the relay interval runs from the request reaching the relay to the modelled delivery of the
// reply, so no browser-side work falls inside it
out("6. Network share (relay delay + link serialization + gateway transport) = relay crossing (.io) - gateway time (wire), runs with both files; ambiguous wire pairs left out");
const nRows = [["crossing", "kind", "dir", "runs", "relay n", "relay mean", "gw n", "gw mean", "relay-gw", "matched", "share mean", "share med"]];
for (const t of ["resume", "exec"]) for (const kind of KINDS) for (const [dir] of DIRS) {
  const rs = wireRuns.filter((r) => r.dir === dir && r.kind === kind && r.ioIn);
  if (!rs.length) continue;
  const io = rs.flatMap((r) => r.ioIn.filter((x) => x.cat === "cross " + t));
  const gw = rs.flatMap((r) => r.w.inSet.filter((x) => x.t === t));
  if (!io.length && !gw.length) continue;
  const nets = rs.flatMap((r) => match(r.ioIn.filter((x) => x.cat === "cross " + t), r.w.inSet.filter((x) => x.t === t).sort((a, b) => a.req.ts - b.req.ts), t === "exec"));
  const rm = mean(io.map((x) => x.ms)), gm = mean(gw.map((x) => x.gw));
  nRows.push([t, kind, dir, rs.length, io.length, fmt(rm), gw.length, fmt(gm), fmt(rm - gm), nets.length, fmt(mean(nets)), fmt(median(nets))]);
}
if (nRows.length > 1) table(nRows, 3); else out("  no run has both .io and a wire log");

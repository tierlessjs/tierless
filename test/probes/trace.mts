// Probe: the trace recorder and profile/decide library, headless — every mechanism the
// live trio test composes, exercised alone:
//   sampling     deterministic in (id, rate), run-level, honest fractions
//   __trace      rides the real binary wire like any frame field (the __h precedent),
//                costs a few dozen bytes per hop when on and exactly ZERO when off
//   recorder     one global cross-tier order from the stack-carried seq; the ship path
//                bumps counters BEFORE encoding so the peer's records sort after
//   profile      truncated runs feed size models but NEVER trajectory statistics; sizes
//                bucket per argument features (the §1.2 per-site variance fix)
//   decide       cold -> migrate; side effect -> migrate; unstable suffix -> greedy;
//                stable suffix -> trajectory pricing; stale bundle hash -> refused
import { encodeWireBinary, decodeWireBinary } from "tierless/wire";
import { sampleTrace, argFeatures, makeRecorder, memorySink, buildProfile, loadProfile, decide, expectedFetch, siteKey } from "tierless/trace";
import type { TraceRecord, TraceFlag } from "tierless/trace";
import type { Frame } from "tierless/runtime";
import { makeCounter } from "../lib/check.mts";

const { check, counts } = makeCounter();
console.log("Probe: trace recording + trajectory pricing — the mechanisms, headless\n");

// ---- sampling ---------------------------------------------------------------------------
check("sampling is deterministic in (id, rate)", sampleTrace("run-42", 0.5) === sampleTrace("run-42", 0.5));
check("rate 0 samples nothing, rate 1 everything", !sampleTrace("x", 0) && sampleTrace("x", 1));
{
  let on = 0;
  for (let i = 0; i < 10_000; i++) if (sampleTrace("id-" + i, 0.1)) on++;
  check("a 10% rate traces ~10% of runs", on > 700 && on < 1300, on);
}
check("argFeatures keeps numbers, reduces the rest to shape", JSON.stringify(argFeatures([300, "abc", [1, 2], { a: 1 }, null])) === JSON.stringify(["300", "s3", "a2", "o1", "_"]));

// ---- __trace on the wire ----------------------------------------------------------------
{
  const stack: Frame[] = [{ fn: "Go", pc: 3, args: [1], work: ["a", "b"] }];
  const req = { op: "resource" as const, tier: "server", name: "api.get", args: [7] };
  const bare = encodeWireBinary(stack, req).length;
  (stack[0] as any).__trace = { id: "t-1", hop: 2, seq: 5, on: 1 };
  const wire = encodeWireBinary(stack, req);
  const { stack: back } = decodeWireBinary(wire);
  const flag = (back[0] as any).__trace;
  check("__trace round-trips the binary wire intact", flag && flag.id === "t-1" && flag.hop === 2 && flag.seq === 5 && flag.on === 1, flag);
  check(`the flag costs a few dozen bytes per hop when on (${wire.length - bare} B) and 0 when off`, wire.length - bare > 0 && wire.length - bare < 100);
}

// ---- recorder: order, the ship path, end-after-pop --------------------------------------
{
  const { sink, records } = memorySink();
  const rec = makeRecorder({ rate: 0, sink });
  check("rate 0 with no explicit ask samples out (no field, no records)", rec.spawn("Go") === null);
  check("an explicit {trace: true} overrides the rate", typeof rec.spawn("Go", true) === "string");
  check("a force-listed entry always traces", typeof makeRecorder({ rate: 0, force: ["Go"], sink }).spawn("Go") === "string");

  const stack: Frame[] = [{ fn: "Go", pc: 0, args: [] }];
  rec.stamp(stack, "run-1");
  const flag = rec.flagOf(stack) as TraceFlag;
  rec.res(stack, { name: "api.a", tier: "server", args: [3] }, { rows: [1, 2, 3] });
  const wire = rec.ship(stack, { name: "api.b" }, () => encodeWireBinary(stack, null), "migrate");
  const peerFlag = (decodeWireBinary(wire).stack[0] as any).__trace;
  check("ship bumps the stack-carried counters BEFORE encoding — the peer sorts after the crossing",
    peerFlag.hop === 1 && peerFlag.seq === 2 && records[1].t === "hop" && records[1].seq === 1 && records[1].hop === 0);
  rec.end(flag, "done");
  const seqs = records.map((r) => r.seq);
  check("records carry one strictly increasing seq", JSON.stringify(seqs) === JSON.stringify([0, 1, 2]), seqs);
  const hop = records[1];
  check("the crossing record has the site and the REAL shipped bytes", hop.t === "hop" && hop.contBytes === wire.length && hop.choice === "migrate");
}

// ---- profile: truncation, size buckets, stability ---------------------------------------
const R = (id: string, seq: number, resource: string, features: string[], bytes: number): TraceRecord =>
  ({ t: "res", id, hop: 0, seq, fn: "Go", pc: 4, resource, tier: "server", argFeatures: features, resultBytes: bytes });
const END = (id: string, seq: number): TraceRecord => ({ t: "end", id, hop: 1, seq, outcome: "done" });
{
  // two complete runs with suffix [B], one TRUNCATED run (no end) that saw a different suffix
  const records: TraceRecord[] = [
    R("r1", 0, "api.a", ["300"], 7000), R("r1", 1, "api.b", ["300"], 7000), END("r1", 2),
    R("r2", 0, "api.a", ["300"], 7000), R("r2", 1, "api.b", ["300"], 7000), END("r2", 2),
    R("r3", 0, "api.a", ["1"], 23),                                    // truncated: sizes count, trajectory must not
  ];
  const p = buildProfile(records, "cafe0001");
  const a = p.sites[siteKey("Go", 4, "api.a")];
  check("truncated runs feed the size model", a.n === 3 && p.runs.total === 3 && p.runs.complete === 2);
  check("truncated runs are EXCLUDED from trajectory statistics", a.complete === 2 && a.stability === 1 && a.modal !== null);
  check("sizes bucket per argument features — the per-site variance fix",
    expectedFetch(a, ["300"]) === 7000 && expectedFetch(a, ["1"]) === 23, a.sizes);
  check("unseen features fall back to the site's overall mean", Math.round(expectedFetch(a, ["999"])) === Math.round(a.meanSize));

  // decide, across its branches
  check("side effect -> migrate", decide(50, siteKey("Go", 4, "api.a"), p, { fetchable: false }).choice === "migrate");
  check("cold (no site) -> migrate", decide(50, "Go|99|api.z", p).choice === "migrate");
  check("greedy prices THIS fetch alone", decide(8000, siteKey("Go", 4, "api.a"), p, { mode: "greedy", argFeatures: ["300"] }).choice === "fetch");
  const t = decide(8000, siteKey("Go", 4, "api.a"), p, { mode: "trajectory", argFeatures: ["300"] });
  check("trajectory prices the suffix and flips the same hop to migrate", t.choice === "migrate" && t.fetchSide === 14000, t);
  // §1.2: same site, small arguments. The site's mean (~4.7 KB) would migrate this 3 KB
  // continuation; the per-feature bucket prices the 1-row fetch at 23 B and fetches.
  const small = decide(3000, siteKey("Go", 4, "api.a"), p, { mode: "greedy", argFeatures: ["1"] });
  check("small arguments reprice the same site (no locked sample)", small.choice === "fetch" && small.fetchSide === 23 && 3000 <= a.meanSize, small);

  // the stability gate: a site whose suffixes disagree degrades to greedy
  const unstable = buildProfile([
    R("u1", 0, "api.a", ["300"], 7000), R("u1", 1, "api.b", ["300"], 7000), END("u1", 2),
    R("u2", 0, "api.a", ["300"], 7000), R("u2", 1, "api.c", ["300"], 7000), END("u2", 2),
  ], "cafe0001");
  const g = decide(8000, siteKey("Go", 4, "api.a"), unstable, { mode: "trajectory", argFeatures: ["300"], stability: 0.9 });
  check("an unstable suffix (50% modal) degrades to the greedy rule", g.choice === "fetch" && g.why.includes("unstable"), g.why);

  // unserializable results (resultBytes -1) are no size sample: they must not skew the
  // mean, and a site with ONLY them has no price — cold, not "fetch costs 0"
  const opaque = buildProfile([
    R("o1", 0, "api.a", ["300"], 7000), R("o1", 1, "api.a", ["300"], -1), END("o1", 2),
    R("o2", 0, "api.x", ["1"], -1), END("o2", 1),
  ], "cafe0001");
  check("an unserializable result does not skew the site mean", opaque.sites[siteKey("Go", 4, "api.a")].meanSize === 7000);
  check("a site with only unserializable results stays cold", decide(50, siteKey("Go", 4, "api.x"), opaque).why.includes("cold"));

  // a SUFFIX holding an unserializable result cannot be traversed by fetching at all —
  // pricing it at 0 would bias toward fetch, the wrong direction. It must force migrate.
  const unfetchable = buildProfile([
    R("f1", 0, "api.a", ["300"], 7000), R("f1", 1, "api.b", ["300"], -1), END("f1", 2),
    R("f2", 0, "api.a", ["300"], 7000), R("f2", 1, "api.b", ["300"], 9000), END("f2", 2),
  ], "cafe0001");
  const fa = unfetchable.sites[siteKey("Go", 4, "api.a")];
  check("one unserializable occurrence marks the whole suffix unfetchable; fetchSum means over the priced rest",
    fa.suffixes[fa.modal!].fetchable === false && fa.suffixes[fa.modal!].fetchSum === 9000 && fa.suffixes[fa.modal!].n === 2, fa.suffixes);
  const forced = decide(50_000, siteKey("Go", 4, "api.a"), unfetchable, { mode: "trajectory", argFeatures: ["300"] });
  check("an unfetchable suffix forces MIGRATE however big the continuation", forced.choice === "migrate" && forced.why.includes("cannot traverse"), forced.why);

  // the bundle-identity gate
  check("loadProfile accepts the matching bundle", loadProfile(p, "cafe0001") === p);
  check("loadProfile refuses a mismatched bundle (stale = silent misattribution)", loadProfile(p, "cafe0002") === null);
}

const { pass, fail } = counts();
const okAll = fail === 0;
console.log(okAll
  ? `\nOK — run-level sampling, a wire-borne trace flag with one cross-tier order, truncation-safe profiles with per-feature size models, and a stability-gated trajectory rule over a greedy floor (${pass} checks)`
  : `\nFAILED (${pass} passed, ${fail} failed)`);
process.exit(okAll ? 0 : 1);

// Trajectory-priced placement — the trace recorder and the profile/decide library.
//
// The §6 migrate-vs-fetch rule is greedy per-hop: at a foreign data resource it compares
// the continuation's real wire bytes against one sampled fetch size. Two measured failure
// modes (see the trajectory design): a workflow whose SUFFIX holds more same-tier resources
// can be sized so every per-hop fetch is locally cheaper yet one early migration beats them
// all (each fetched result also inflates the continuation, so deferring migration makes it
// strictly dearer); and one locked sample per site misprices argument-dependent results.
//
// Three pieces, one data structure:
//   recorder  — runtime-only instrumentation at the pump boundary (host.mts). Per traced
//               run, the ordered sequence of resource touches with sizes and argument
//               FEATURES (shapes/sizes — never payload values), plus each crossing's real
//               wire bytes. The trace flag rides the continuation itself (F0.__trace, the
//               same mechanism that carries __h for cross-tier try/catch), so the host
//               stays stateless per message; a __trace.seq counter rides with it, giving a
//               global cross-tier ordering with no synchronized clocks.
//   profile   — derived OFFLINE from trace records by buildProfile(): per site (fn, pc,
//               resource), a size model keyed on argument features, the distribution of
//               same-tier suffixes observed after the site with their summed fetch cost,
//               and a stability fraction. Stamped with the BUNDLE_HASH of the machine that
//               produced the traces: site identity is (fn, pc) and pcs silently change
//               meaning across edits, so loadProfile() refuses a mismatched profile.
//   decide    — the placement rule. Trajectory mode prices the whole same-tier suffix;
//               the per-site stability gate degrades to the greedy per-hop rule where
//               trajectories are inconsistent; no profile entry at all migrates (the cold
//               "fetch not yet priced" floor). Greedy remains the floor everywhere.
//
// Browser-safe: no Node imports. Sinks are plain callbacks; JSONL/file persistence is the
// caller's three lines.
// ---------------------------------------------------------------- sampling ------------
// Deterministic id-hash sampling: the decision is a pure function of (id, rate), so a rate
// change needs no redeploy and affects new spawns only. The unit is the RUN, decided once
// at spawn, immutable: per-hop skipping saves nothing (a record is an in-memory append,
// orders of magnitude under the wire encode the hop already pays), hop-level sampling
// destroys the suffix estimator the profile feeds (a k-hop sequence survives with p^k),
// and mid-run toggling makes truncation indistinguishable from genuine early completion.
export function sampleTrace(id, rate) {
    if (rate >= 1)
        return true;
    if (rate <= 0)
        return false;
    return fnv1a(id) % 10_000 < rate * 10_000;
}
export const mintTraceId = () => Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffffffff).toString(36);
function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/** Argument FEATURES, never values: numbers stay (they are structure — a row count), everything else reduces to type + size. */
export const argFeatures = (args) => args.map((a) => {
    if (typeof a === "number")
        return String(a);
    if (typeof a === "string")
        return "s" + a.length;
    if (Array.isArray(a))
        return "a" + a.length;
    if (a === null || a === undefined)
        return "_";
    if (typeof a === "object")
        return "o" + Object.keys(a).length;
    return typeof a;
});
/** Measure a resource result the way the fetch path would ship it. -1 when unserializable. */
export const resultBytes = (v) => {
    try {
        const s = JSON.stringify(v);
        return s === undefined ? 0 : s.length;
    }
    catch {
        return -1;
    }
};
export function makeRecorder({ rate = 0, force = [], sink }) {
    const forced = new Set(force);
    const top = (stack) => stack[stack.length - 1];
    const flagOf = (stack) => {
        const f = stack.length && stack[0].__trace;
        return f && f.on ? f : null;
    };
    return {
        flagOf,
        spawn(entry, explicit) {
            if (explicit === false)
                return null;
            const id = mintTraceId();
            return explicit === true || forced.has(entry) || sampleTrace(id, rate) ? id : null; // sampled out: no field at all — 0 wire bytes
        },
        stamp(stack, id) {
            if (stack.length)
                stack[0].__trace = { id, hop: 0, seq: 0, on: 1 };
        },
        res(stack, req, result) {
            const f = flagOf(stack);
            if (!f)
                return;
            const { fn, pc } = top(stack);
            sink({ t: "res", id: f.id, hop: f.hop, seq: f.seq++, fn, pc, resource: req.name, tier: req.tier, argFeatures: argFeatures(req.args), resultBytes: resultBytes(result) });
        },
        ship(stack, req, encode, choice) {
            const f = flagOf(stack);
            if (!f)
                return encode();
            const { fn, pc } = top(stack);
            const hop = f.hop, seq = f.seq;
            f.hop++;
            f.seq++; // bump BEFORE encoding: the wire carries the advanced counters, so the peer's records sort after this one
            const wire = encode();
            sink({ t: "hop", id: f.id, hop, seq, fn, pc, resource: req.name, contBytes: wire.length, ...(choice ? { choice } : {}) });
            return wire;
        },
        end(flag, outcome) {
            if (!flag)
                return;
            sink({ t: "end", id: flag.id, hop: flag.hop, seq: flag.seq++, outcome });
        },
    };
}
/** Collect records in memory (tests, small runs). Real deployments pass their own sink (e.g. JSONL appends). */
export function memorySink() {
    const records = [];
    return { sink: (r) => { records.push(r); }, records };
}
// ---------------------------------------------------------------- profile -------------
export const siteKey = (fn, pc, resource) => fn + "|" + pc + "|" + resource;
// Derive the profile from raw records, offline. Size/variance models use every run —
// truncated ones included, a partial run's sizes are real. Trajectory statistics use ONLY
// complete runs (those with an "end" record): a truncated suffix is indistinguishable from
// a genuinely short one and would poison the stability gate.
export function buildProfile(records, bundle) {
    const byRun = new Map();
    for (const r of records) {
        if (!byRun.has(r.id))
            byRun.set(r.id, []);
        byRun.get(r.id).push(r);
    }
    const sites = {};
    const site = (k) => (sites[k] ||= { n: 0, meanSize: 0, sizes: {}, contMean: 0, contN: 0, suffixes: {}, modal: null, stability: 0, complete: 0 });
    let completeRuns = 0;
    for (const recs of byRun.values()) {
        recs.sort((a, b) => a.seq - b.seq); // seq rides the continuation: one global order across both tiers
        const complete = recs.some((r) => r.t === "end" && r.outcome === "done");
        if (complete)
            completeRuns++;
        const touches = recs.filter((r) => r.t === "res");
        for (const r of touches) { // size model: every run, truncated included
            const s = site(siteKey(r.fn, r.pc, r.resource));
            if (r.resultBytes >= 0) {
                s.meanSize += (r.resultBytes - s.meanSize) / (s.n + 1);
                const bucket = (s.sizes[r.argFeatures.join(",")] ||= { n: 0, mean: 0 });
                bucket.mean += (r.resultBytes - bucket.mean) / (bucket.n + 1);
                bucket.n++;
            }
            s.n++;
        }
        for (const r of recs) { // continuation sizes: what migrating really cost at this site
            if (r.t !== "hop")
                continue;
            const s = site(siteKey(r.fn, r.pc, r.resource));
            s.contMean += (r.contBytes - s.contMean) / (s.contN + 1);
            s.contN++;
        }
        if (!complete)
            continue; // trajectory statistics: complete runs only
        for (let i = 0; i < touches.length; i++) {
            const r = touches[i];
            const s = site(siteKey(r.fn, r.pc, r.resource));
            const suffix = touches.slice(i + 1).filter((x) => x.tier === r.tier); // future SAME-tier resources
            const sig = suffix.map((x) => siteKey(x.fn, x.pc, x.resource)).join(">");
            const sum = suffix.reduce((acc, x) => acc + Math.max(0, x.resultBytes), 0);
            const e = (s.suffixes[sig] ||= { n: 0, fetchSum: 0 });
            e.fetchSum += (sum - e.fetchSum) / (e.n + 1);
            e.n++;
            s.complete++;
        }
    }
    for (const s of Object.values(sites)) {
        let best = null, bestN = 0;
        for (const [sig, e] of Object.entries(s.suffixes))
            if (e.n > bestN) {
                best = sig;
                bestN = e.n;
            }
        s.modal = best;
        s.stability = s.complete ? bestN / s.complete : 0;
    }
    return { v: 1, bundle, runs: { total: byRun.size, complete: completeRuns }, sites };
}
/** Accept a profile only for the exact bundle it was traced against — a stale profile does
 *  not miss, it silently MISATTRIBUTES (a pc renumbered by an edit inherits another site's
 *  whole trajectory history). Mismatch ⇒ null ⇒ the greedy/cold floor. */
export function loadProfile(profile, bundleHash) {
    if (!profile || profile.v !== 1 || !bundleHash || profile.bundle !== bundleHash)
        return null;
    return profile;
}
/** Expected result bytes for a site given the CURRENT call's argument features — the
 *  bucket if these features were seen before, else the site's overall mean. */
export function expectedFetch(s, features) {
    const bucket = s.sizes[features.join(",")];
    return bucket ? bucket.mean : s.meanSize;
}
// The placement rule. Cold (no profile / no site) migrates — "fetch not yet priced", the
// pre-§6 behavior and the floor everywhere. Greedy prices this hop's fetch alone (the
// current §6 rule, with the size model replacing the one locked sample). Trajectory adds
// the expected cost of the same-tier suffix recorded after this site — gated per site on
// suffix stability, degrading to greedy where history is absent or inconsistent.
export function decide(contBytes, key, profile, { fetchable = true, mode = "trajectory", stability = 0.9, argFeatures = [] } = {}) {
    if (!fetchable)
        return { choice: "migrate", why: "side effect: cannot fetch", fetchSide: Infinity };
    const s = profile?.sites[key];
    if (!s || !s.n)
        return { choice: "migrate", why: "fetch not yet priced (cold)", fetchSide: Infinity };
    const here = expectedFetch(s, argFeatures);
    let fetchSide = here, how = "greedy: this fetch";
    if (mode === "trajectory" && s.modal !== null && s.stability >= stability) {
        fetchSide = here + s.suffixes[s.modal].fetchSum;
        how = `trajectory: this fetch + suffix (stability ${(s.stability * 100).toFixed(0)}%)`;
    }
    else if (mode === "trajectory") {
        how = s.complete ? `greedy: suffix unstable (${(s.stability * 100).toFixed(0)}% < ${(stability * 100).toFixed(0)}%)` : "greedy: no complete trajectories";
    }
    return contBytes <= fetchSide
        ? { choice: "migrate", why: `${how}; continuation ${contBytes} B <= fetch side ${Math.round(fetchSide)} B`, fetchSide }
        : { choice: "fetch", why: `${how}; fetch side ${Math.round(fetchSide)} B < continuation ${contBytes} B`, fetchSide };
}

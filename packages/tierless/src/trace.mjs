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
/** Argument FEATURES, never values: numbers stay (they are structure — a row count),
 *  everything else reduces to type + size. TOTAL: inspection itself can throw (a revoked
 *  proxy's ownKeys trap) and observability must never fail the observed run — such an
 *  argument reduces to a coarse fallback feature instead. */
export const argFeatures = (args) => args.map((a) => {
    try {
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
    }
    catch {
        return "?";
    }
});
const utf8 = new TextEncoder();
/** Measure a resource result the way the fetch path would ship it: encoded bytes,
 *  not UTF-16 code units (non-ASCII payloads differ). -1 when unserializable. */
export const resultBytes = (v) => {
    try {
        const s = JSON.stringify(v);
        return s === undefined ? 0 : utf8.encode(s).length;
    }
    catch {
        return -1;
    }
};
export function makeRecorder({ rate = 0, force = [], sink }) {
    const forced = new Set(force);
    let dropped = 0;
    // Sinks are user-written callbacks in every deployment; a sink that throws must not
    // become a fault injector for exactly the sampled fraction of traffic (a heisencrash
    // that vanishes when tracing turns off). A throw here would even route through the
    // pump's error unwinding and could be CAUGHT BY APP CODE as a fake resource failure.
    // So: swallow and count, never propagate.
    // An ASYNC sink's rejection would otherwise escape as an unhandled rejection — same
    // fault-injection hazard, one tick later. Observe and count it like a sync throw.
    const emit = (r) => {
        try {
            const p = sink(r);
            if (p && typeof p.catch === "function")
                p.catch(() => { dropped++; });
        }
        catch {
            dropped++;
        }
    };
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
        stamp(stack, id, entry) {
            // entry rides the flag (and every record): the METHOD boundary's trajectory stats
            // are conditioned on the run's entry — a touch site shared by many callers would
            // otherwise drown a chain-bearing caller in single-touch occurrences
            if (stack.length)
                stack[0].__trace = { id, hop: 0, seq: 0, on: 1, ...(entry ? { entry } : {}) };
        },
        res(stack, req, result) {
            const f = flagOf(stack);
            if (!f)
                return;
            const { fn, pc } = top(stack);
            emit({ t: "res", id: f.id, hop: f.hop, seq: f.seq++, fn, pc, resource: req.name, tier: req.tier, argFeatures: argFeatures(req.args), resultBytes: resultBytes(result), ...(f.entry ? { entry: f.entry } : {}) });
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
            emit({ t: "hop", id: f.id, hop, seq, fn, pc, resource: req.name, contBytes: wire.length, ...(choice ? { choice } : {}) });
            return wire;
        },
        end(flag, outcome) {
            if (!flag)
                return;
            emit({ t: "end", id: flag.id, hop: flag.hop, seq: flag.seq++, outcome });
        },
        get dropped() { return dropped; },
    };
}
/** Collect records in memory (tests, small runs). Real deployments pass their own sink (e.g. JSONL appends). */
export function memorySink() {
    const records = [];
    return { sink: (r) => { records.push(r); }, records };
}
// ---------------------------------------------------------------- profile -------------
export const siteKey = (fn, pc, resource) => fn + "|" + pc + "|" + resource;
/** The method boundary's site: the same touch site, conditioned on the RUN's entry. */
export const entrySiteKey = (entry, fn, pc, resource) => entry + ">" + siteKey(fn, pc, resource);
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
    const site = (k) => (sites[k] ||= { n: 0, sized: 0, meanSize: 0, sizes: {}, contMean: 0, contN: 0, suffixes: {}, modal: null, stability: 0, complete: 0 });
    let completeRuns = 0;
    for (const recs of byRun.values()) {
        recs.sort((a, b) => a.seq - b.seq); // seq rides the continuation: one global order across both tiers
        const complete = recs.some((r) => r.t === "end" && r.outcome === "done");
        if (complete)
            completeRuns++;
        const touches = recs.filter((r) => r.t === "res");
        for (const r of touches) { // size model: every run, truncated included
            const s = site(siteKey(r.fn, r.pc, r.resource));
            if (r.resultBytes >= 0) { // an unserializable result contributes no size sample
                s.meanSize += (r.resultBytes - s.meanSize) / (s.sized + 1);
                s.sized++;
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
            // suffix stats land under the aggregate site AND, when the run carries its entry,
            // under the ENTRY-CONDITIONED site: a touch site shared by many callers (every
            // service getM) would otherwise drown a chain-bearing caller's trajectory in
            // single-touch occurrences — the method boundary decides per (entry, site).
            const keys = [siteKey(r.fn, r.pc, r.resource)];
            if (r.entry)
                keys.push(entrySiteKey(r.entry, r.fn, r.pc, r.resource));
            // CONTIGUOUS same-tier, same-SEGMENT suffix only: a foreign-tier touch means the
            // continuation bounced away, and a hop change means it CROSSED (a §5 home park has
            // no touch of its own — the hop counter is its trace). Later resources are separate
            // crossings whose bytes a migration at THIS site cannot fold in; filtering them in
            // would inflate fetchSum and flip decide() toward migrations that don't deliver.
            const rest = touches.slice(i + 1);
            const cut = rest.findIndex((x) => x.tier !== r.tier || x.hop !== r.hop);
            const suffix = cut === -1 ? rest : rest.slice(0, cut);
            const sig = suffix.map((x) => siteKey(x.fn, x.pc, x.resource)).join(">");
            for (const k of keys) {
                const s = site(k);
                const e = (s.suffixes[sig] ||= { n: 0, priced: 0, fetchSum: 0, fetchable: true });
                if (suffix.every((x) => x.resultBytes >= 0)) { // a fully fetchable occurrence prices the suffix
                    const sum = suffix.reduce((acc, x) => acc + x.resultBytes, 0);
                    e.fetchSum += (sum - e.fetchSum) / (e.priced + 1);
                    e.priced++;
                }
                else {
                    e.fetchable = false; // one unserializable result: fetch cannot traverse this suffix
                }
                e.n++; // shape statistics (modal/stability) count every occurrence
                s.complete++;
            }
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
    if (!s || !s.sized)
        return { choice: "migrate", why: "fetch not yet priced (cold)", fetchSide: Infinity }; // touches without a measurable size are no price
    const here = expectedFetch(s, argFeatures);
    let fetchSide = here, how = "greedy: this fetch";
    if (mode === "trajectory" && s.modal !== null && s.stability >= stability) {
        const m = s.suffixes[s.modal];
        if (!m.fetchable)
            return { choice: "migrate", why: "trajectory: the suffix holds an unserializable result — fetch cannot traverse it", fetchSide: Infinity };
        fetchSide = here + m.fetchSum;
        how = `trajectory: this fetch + suffix (stability ${(s.stability * 100).toFixed(0)}%)`;
    }
    else if (mode === "trajectory") {
        how = s.complete ? `greedy: suffix unstable (${(s.stability * 100).toFixed(0)}% < ${(stability * 100).toFixed(0)}%)` : "greedy: no complete trajectories";
    }
    return contBytes <= fetchSide
        ? { choice: "migrate", why: `${how}; continuation ${contBytes} B <= fetch side ${Math.round(fetchSide)} B`, fetchSide }
        : { choice: "fetch", why: `${how}; fetch side ${Math.round(fetchSide)} B < continuation ${contBytes} B`, fetchSide };
}
/** The §6 rule at a compiled METHOD's park (docs/migrate-arm.md slice 2) — the mirror
 *  image of decide()'s workflow rule. There, cold migrates: the continuation must reach
 *  its resources somehow, and fetch is the unpriced arm. Here, cold FETCHES: the fetch
 *  arm is free (the stack never ships) and migrating unpriced risks paying the shipping
 *  for a one-call method that bounces straight home. Migrate only on evidence: the
 *  profile — locked, from a profiling run, per the run protocol — shows this exact site
 *  (fn, pc, resource) starting a STABLE same-tier chain, each suffix touch a round trip
 *  the migration folds into one crossing. */
export function methodMigrate(profile, { stability = 0.9, minSuffix = 1 } = {}) {
    if (!profile)
        return () => false;
    return (req, site) => {
        // prefer the ENTRY-CONDITIONED site: chains live in callers, and a shared touch
        // site's aggregate stats can hide a caller whose runs chain 100% of the time
        const s = (site.entry ? profile.sites[entrySiteKey(site.entry, site.fn, site.pc, req.name)] : undefined)
            ?? profile.sites[siteKey(site.fn, site.pc, req.name)];
        if (!s || s.modal === null || s.stability < stability)
            return false;
        return s.modal.split(">").filter(Boolean).length >= minSuffix;
    };
}

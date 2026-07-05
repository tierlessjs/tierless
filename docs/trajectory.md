# Trajectory-priced placement

The §6 migrate-vs-fetch rule (design.md §6) is greedy per-hop: at a foreign data resource
it compares this continuation's real wire bytes against one sampled fetch size. Two
measured failure modes, and what ships to fix them.

## The failure modes

**Trajectory blindness.** A workflow touching several same-tier resources in sequence can
be sized so fetch is locally cheaper at *every* hop, yet one migration at the first hop
serves all downstream resources inline. `test/e2e/trio-live.mts` measures it over a real
websocket: greedy fetches three times and crosses 19.7 KB; one trace-informed migration
crosses 8.5 KB — **57% fewer bytes**, with every greedy hop individually correct by the
per-hop rule (asserted). The effect compounds: each fetched result lands in the frame, so
the continuation grows with every fetch (8.4 → 13.5 → 18.6 KB) and migration gets strictly
more expensive the longer it's deferred. No per-hop comparison can recover the flip — the
information ("two more server resources follow") exists only in a trace of a prior run.

**Per-site variance blindness.** The §6 profile locked one sample per call path; result
size is argument-dependent. Sample a site at 4,000 rows and later call it for 1 row, and
the informed rule ships a fat continuation to avoid a 23 B transfer. Fixed by keying size
models on argument *features* (shapes and sizes, never payload values).

## What ships (`tierless/trace`)

**Trace recorder** — runtime-only instrumentation in the host; no compiler changes, one
bundle for traced and untraced runs. Sampling is per RUN, decided once at spawn
(deterministic in `(id, rate)`, so a rate change needs no redeploy), immutable mid-run:
hop-level sampling would blind the suffix estimator (a k-hop sequence survives with
probability p^k), and mid-run toggling makes truncation indistinguishable from genuine
early completion. The flag rides the continuation itself — `F0.__trace = {id, hop, seq,
on}`, the same mechanism that carries `__h` for cross-tier try/catch — so the host stays
stateless per message; it costs ~49 B/hop when on and exactly 0 when off. The
stack-carried `seq` gives both tiers' records one global order with no synchronized
clocks. Per traced run: every resource touch (site `(fn, pc, resource)`, argument
features, result bytes) and every crossing (real shipped wire bytes, the choice made).
Configure per host: `makeHost({ ..., trace: { rate, force, sink } })` (or pass a
pre-built `makeRecorder(...)` to keep a handle on it); per call:
`host.run(peer, entry, args, { trace: true })`. A sink that throws is contained and
counted (`recorder.dropped`), never propagated — observability must not change the
observed run's outcome, and an uncontained sink bug would fault exactly the sampled
fraction of traffic (`test/e2e/sink-throw.mts`).

**Profile** — `buildProfile(records, BUNDLE_HASH)`, derived offline. Per site: a size
model bucketed by argument features, the continuation bytes observed at its crossings,
the distribution of ordered same-tier suffixes seen after it with their summed fetch
cost, and a stability fraction. Truncated runs (no `end` record) feed size models but are
excluded from trajectory statistics; error-ended runs are treated the same (note: an
error on the *driving* tier propagates out of `run()` with no end marker at all, so it
reads as truncated — same handling, zero profile effect). A suffix containing an
unserializable result is marked `fetchable: false` — the fetch path cannot traverse it
at all, so `decide()` forces migrate there rather than pricing the unfetchable touch at
0 (which would bias toward fetch, the wrong direction).

**Bundle identity** — every compiled bundle exports `BUNDLE_HASH` (hashed over the
emitted machine code, identical on both tiers). Site identity is `(fn, pc)` and pcs
silently change meaning across edits — a stale profile doesn't miss, it *misattributes*
(a renumbered pc inherits another site's whole trajectory history) — so `loadProfile()`
refuses a mismatched profile and the rule falls back to the cold floor.

**`decide(contBytes, siteKey, profile, opts)`** — the placement rule. Side-effecting
resources migrate (as today). Cold (no site history) migrates — "fetch not yet priced".
Greedy mode prices this hop's fetch alone from the size model. Trajectory mode adds the
expected cost of the recorded same-tier suffix, gated per site: below the stability
threshold (default 90% of complete runs sharing the modal suffix) it degrades to greedy.
Greedy remains the floor everywhere.

## Boundaries (deliberate)

- The shipped host always migrates; the §6 decide loop lives in the driver
  (`test/e2e/trio-live.mts`, `test/e2e/policy-live.mts`). Landing it in the host — with
  fetch as a first-class protocol message — is on the ROADMAP.
- The suffix horizon is run completion. Long-running sessions need a horizon (e.g. up to
  the first foreign-tier return crossing); semantics to be settled against real traces.
- Per-site suffix stability in real applications is the load-bearing empirical unknown:
  the recorder is the instrument that answers it, and the stability gate makes the answer
  safe to act on either way.

Proofs: `test/probes/trace.mts` (mechanisms, headless), `test/e2e/trio-live.mts` (the
whole loop over a real websocket: traced runs through the real host → profile → the
suffix flips a locally-losing hop; hash gate refusal).

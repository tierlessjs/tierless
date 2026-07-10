# Compiling Vikunja's real code — coverage checklist

Direction (supersedes the shadow-workflow port): the app's own service layer becomes
the migrating continuation. No parallel statement of intent, no XHR interception —
the I/O bottom moves to tierless resources (patch 0005, the axios adapter) and the
compiler carries their actual code. `node ports/vikunja/compile-coverage.mts` runs
their real files through the transform; this file tracks what it finds.

## Findings (2026-07-06)

1. ~~Class methods are not compilation units~~ **DONE.** Methods of top-level named
   classes with tier calls compile into PROGRAMS (`Cls$method`, receiver as frame
   arg 0, `this` rewritten arrow-aware); the kept class's method becomes a stub that
   routes through `__bindTierlessMethods` and falls back to the untouched original —
   unbound bundles behave stock. Per-method graceful: blockers are reported in
   meta.methods, never a whole-file failure. `await` of a tier call is absorbed into
   the suspension. Result on their real code: **AbstractService compiles 6/6 of its
   http-bearing methods** (getM, getAll, create, post, delete, uploadFormData) —
   and every service subclass inherits the stubbed base, so this one class covers
   the whole service layer. ProjectService.removeBackground also compiles.

2. **`this.http.get(...)` recognition DONE** (config `resources: {"this.http":
   "server"}`; the receiver is dropped from the request — the namespace binds per
   tier via exec). Still open from the original item: the server-side exec for the
   `http.*` namespace — the twin instance built by THEIR `HTTPFactory()` with the
   adapter at the bottom, plus leases for `window.API_URL`/`getToken()`.

3. **The UI layer correctly stays put.** `useTaskList` (ref/computed/watch) is kept
   verbatim as a pure export — right outcome: the migration boundary is the service
   method call, reactivity stays in the browser.

## Open items (in order)

Resolved since first written: runtime wiring (bindMethods + shared host, shipped
and measured below) and method-to-method suspendability (dynamic call parks —
awaited member calls compile and dispatch in the pump). Still open:

- **`super` in compiled methods** (TaskCollectionService.getReplacedRoute) — carry
  super dispatch in the frame, or inline the parent method.
- **Non-resource `await` inside otherwise-compilable methods** — local-await
  suspension kind (park, await natively, resume in place; a barrier for migration
  but not for compilation).

## Status

- Patch 0005 (axios adapter at the I/O bottom) CERTIFIED behaviorally invisible:
  full suite 196/199, identical failure set to stock (the two drag flakes upstream
  retries for + Dex), zero session-socket traffic, same wall time (8.5 min).
- Patch 0006 (compile AbstractService): **project suite 59/59 in stock wall time
  (2.1 min)** — their real compiled getAll/create/post/delete running reads AND
  writes over the session's fetch arm. Three boundary defects found and fixed by
  their suite on the way (each in tierless, never worked around): the service's
  own request-interceptor chain now runs browser-side with the post-chain config
  crossing (= what axios hands its adapter); the wire body is literally axios's
  JSON pass (toJSON/Dates); exec errors carry error.response whole. Eleven more
  network-wait accommodations joined 0004 (writes cross the session now too).
- Patches 0001/0002 (route workflow + shim) removed from the recipe: superseded.
  The measured shadow-port results live in git history and the README's record.

## First compiled-native measurement (2026-07-06, results/native-*.jsonl)

196/196 pass parity (identical exclusions), **186 pairs through the session**.
Trips: 15% fewer suite-wide, 22% median per test (preflights gone). Bytes:
median 32% MORE per test — every request is its own crossing today, paying the
module path (~85 B), envelope framing, and UNCOMPRESSED JSON [correction 2026-07-10: stock API is raw too — the echo gzip middleware skips /api/; the overhead was framing, not an encoding gap]
on each one; large payloads still win big (a gantt spec: 892 KB -> 29 KB).
Wall time on localhost: ~0% (as always; shaped runs are the timing instrument).

The overhead fixes are mechanical: hash the module id on the wire, trim
envelope headers to content-type + x-* (all their code reads), enable
permessage-deflate on the session socket. The structural fix is the §6 migrate
arm: batching a method's chain into one crossing — the shadow port's
amortization, earned back for real code.

## Streaming compression + the wire-truth instrument (2026-07-06)

The session socket now negotiates permessage-deflate WITH context takeover: the
deflate window persists across messages, so every crossing compresses against the
whole session's history — cross-request redundancy per-response HTTP gzip cannot
reach. Measured at the SOCKET (counting TCP relays — CDP reports ws frames
post-inflate and cannot see this), same warm open-project interaction:

    stock    24.1 KB on the wire (4,491 out / 19,630 in; static assets gzip,
             API responses raw — echo's gzip middleware skips /api/, verified 2026-07-10)
    ported    6.2 KB on the wire — the session data path itself: 284 BYTES

Scope: the 284 B is repeat-navigation best case (the window had seen the shape;
stock re-pays ~20 KB for the same revisit). Instrument correction: the CDP suite
numbers count inflated payloads and now UNDERCOUNT the ported arm severely —
socket-level counting is the byte instrument of record from here.


## The suite at the socket (2026-07-07, results/truth-*.jsonl)

The full 199-test suite, both arms, TCP-true accounting (TIERLESS_WIRE_TRUTH=1):
session ws bytes counted inside the gateway (deflate included), browser API
bytes through a counting TCP relay. Node-side seeding/login is split off via
TIERLESS_BROWSER_API_URL and never counted; the boot tool refuses already-bound
ports, so a stale stack can no longer serve a measured run.

196/196 pass parity (the 3 exclusions fail identically on both arms, stock too).
186 of 196 pairs touch the session. The distribution of record:

    suite-wide   31.5 MB -> 27.5 MB  (13% less IO) · trips 6,229 -> 5,259 (16% fewer)
    per test     median 35% fewer bytes, 22% fewer trips (covered subset)
    best case    236 KB -> 18 KB (comment pagination: 112 -> 13 trips)

This corrects the CDP-era claim above: "bytes median 32% MORE" was the
instrument, not the port. At the socket, streaming deflate turns the same
crossings into a 35% median per-test byte SAVING. Wall time on localhost: ~0%,
as always — the shaped-RTT runs are the timing instrument.

Coverage note: 11 tests (login-failure/email-confirmation flows) never inject
the browser API override and their page traffic bypasses both counters —
symmetric on both arms, zeros in both files, excluded from nothing.

## Shaped timing, native arms (2026-07-07, results/rtt80-*.jsonl)

TIERLESS_RTT_MS=80, full suite, both arms: 195/195 pass parity (the extra
exclusion is an attachment-paste spec failing under RTT on stock too). Total
wall time 13.1 -> 12.7 min (3% less), median per test 1% less, trips 12% fewer
suite-wide / 22% median covered. The honest read: per-request crossings pay
per-request RTTs — the trip savings that exist today (preflights, dependent
refetches) are real but small against UI-bound test time. Chain batching
(§6 migrate arm) is where trips-fewer becomes seconds-faster.

## The §6 verdict for this app (2026-07-07, profile from their whole suite)

The three-run protocol closed: profiling run (196/199, traced fetch arm, 5,042
records, 3,916 complete method runs) -> locked profile -> comparison. The store
surface compiled (22 setup-store functions + all 10 abstractService methods,
delegation wrappers included, certified 196/199), so same-run chains COULD form
and be shipped. The profile's answer: of 3,916 complete runs, THREE are
multi-touch chains (the saved-filter favorite toggle: getM -> post). Every
(fn, pc, resource) site's modal suffix is empty; the rare chains are <2% at
their shared sites, far under the 90% stability gate.

methodMigrate therefore ships NOTHING — the frozen comparison arm is
behaviorally identical to the certified fetch arm (zero migrations), and its
numbers are the certified ones: bytes -35% median at the socket, trips -14%
suite / -22% median, wall time ±2% under real 80 ms RTT, 196/196 pass parity.

That is the finding, stated plainly: THIS app, driven by ITS OWN test suite,
has no stable request chains to batch — its interactions are single-call, and
its one real multi-call flow is too rare at shared sites to ship profitably.
The §6 machinery works end to end (fixtures prove N-call chains collapse to
one crossing when they exist); this corpus program simply doesn't have them.
Wall-time wins here would need the session-twin registry on flows the suite
doesn't exercise, or an app whose orchestration layer actually chains.

## The 3 chains, measured head-to-head (2026-07-07, saved-filter spec, RTT 80)

Targeted experiment (TIERLESS_SPEC): the one chain-bearing spec, both arms, same
build — fetch arm vs a synthetic profile shipping the chain site (getM@8, 100%
stable). Per-test wall clock:

    Can mark a saved filter as favorite            2945 -> 2920 ms   (-25 ms)
    Can remove a saved filter from favorites       2884 -> 2890 ms   ( +6 ms)
    Favorite status persists after page reload     4527 -> 4521 ms   ( -6 ms)

Delta ~0: noise on 3-4.5 s tests. The mechanism is the predicted crossing
parity: the chain's second half dispatches on a SUBCLASS service instance
(unstamped by the correctness guard) and a mutated model instance — both park
the shipped continuation home between the two calls. Ship + park-home + one
exec = the fetch arm's two execs, round trip for round trip. The measurement
confirms the analysis empirically. The chain becomes a win only with the
session-twin registry (the real subclass constructed server-side) — and the
ceiling is 1 RTT (80 ms) on a ~3,000 ms test: ~3% even then.

## Chains and twins, completed and measured (2026-07-07)

The full §6 pipeline ran end to end on the stores-compiled build: profiling run
(4,997 records, 3,886 complete method runs) -> entry-conditioned profile ->
locked comparison. Three findings, in causal order:

1. **Entry conditioning was the missing granularity.** The favorite-toggle chain
   traces perfectly (getM -> update in one run), but suffix stats keyed by the
   touching frame's site drown it: getM@8 is shared by ~204 single-touch callers
   (1.5% stability -> correctly refused). Keyed by (run entry, site), the chain
   is 100% stable and ships: `project$toggleSavedFilterFavorite>getM@8`. The
   earlier "nothing stable to batch" verdicts were this blindness, not the app.
2. **That is the app's ONE stable chain.** Their suite drives every other
   multi-call flow through reactive composition or non-compiling store functions.
   The site list is the honest census.
3. **The chain's win, measured with repetition** (5 runs per arm, medians,
   RTT 20): the migrating test saves 52 ms (2,506 -> 2,454 ms; wsOut 7 -> 6 —
   one crossing folded), served by a SavedFilterService session twin whose
   state changes ride the reply home (write-back; browser instance reads its
   writes). Non-migrating tests: +3/+24 ms — shipping never regresses. At the
   ceiling this is one RTT per chain occurrence: real, small at residential
   latency, linear in RTT.

Twin audit outcome: TaskService, LabelTaskService, ProjectService twin directly;
SavedFilterService's thin class twins with its browser-bound co-module imports
stubbed (vite twinsStubs — loud runtime error if a twin path ever calls one).

Instrument corrections folded into all of the above: TCP_NODELAY on the shaped
relay AND the gateway socket (Nagle + delayed ACK read as ~40 ms/message and
was most of an apparent ported regression on request-heavy specs); per-test
time decomposition (report-time.mts) separating network waits from the
render/Playwright floor; TIERLESS_BPS bandwidth modeling (1 Gbps: measured
zero effect at this app's payload sizes).

## The "request-heavy regression," diagnosed to closure (2026-07-07)

Two causes, both now measured; no residual regression exists.
1. REAL, FIXED: Nagle + delayed ACK on the gateway socket (~40 ms per small ws
   frame, worst on 170-request tests; halved that family's net waits when fixed).
2. INSTRUMENT: the date-display family is NON-STATIONARY across runs — its
   workload depends on wall-clock time (relative-date rendering over now-seeded
   tasks), drifting ±1 s/test between runs. Proof: the stock arm's own unshaped
   floor ran ~1 s/test SLOWER than its shaped run. Every cross-run number for
   this family — including the apparent ported regression — was drift.
   Verdict by drift-neutral interleaved A/B (3 reps/arm, RTT 20, 18 tests):
   stock median 35.5 s vs ported 35.4 s — parity (-0.3%).
Standing rule: a test family whose workload depends on wall-clock time is only
measurable WITHIN a time window (interleaved arms), never across runs; suite
totals quoting this family across runs inherit +/-10 s of noise.

## Burst coalescing, implemented and measured (2026-07-09)

The chains work closed with a structural lesson: sequential multi-call chains are
what §6 migration harvests, and this app has exactly one — reactive apps express
multi-call flows as CONCURRENT bursts instead (N components mount, N service
calls fire in the same tick, each its own ws frame). Burst coalescing harvests
that shape at the exec boundary, with no compiler or profile involvement:

- Browser (`batchExec`, host.mts; DEFAULT OFF after the verdict below —
  `__TIERLESS_EXEC_BATCH__` page global / TIERLESS_EXEC_BATCH suite env
  enables): exec requests queue for one timer turn (setTimeout 0 —
  microtasks drain first, so every pump that can reach a park this tick does);
  same-(tier, module) groups re-encode as ONE `execBatch` frame sharing one
  interned string table. A lone request passes through as a plain exec.
- Gateway (`handleExecBatch`): fans the vector out through the same exec
  concurrently, returns per-element `{ok, value}` / `{ok, message, response}` —
  each caller's catch sees exactly what its own single exec would have.
- Safe by construction: only requests ALREADY in flight together merge;
  ordering between concurrent execs was never defined. Probe coverage in
  test/probes/migrate-arm.mts (burst = one frame per round, per-element error
  isolation incl. error.response, lone-request passthrough).

Measured, ported build vs itself with batching off (one variable; 195/195 pass
parity both arms; results/truth-batch-*.jsonl, rtt20-batch-*.jsonl):

    ws frames    1,094 -> 834 out, 1,076 -> 805 in   (24-25% fewer)
                 no test sent MORE frames under batching
    ws bytes     -1% TCP-true (stationary subset) — the win is frames, not
                 bytes; deflate already amortizes payload repetition
    wall time    parity at RTT 0 (6.8 min both) and RTT 20 (median per-test
                 delta -3 ms) — the one-timer-turn hold costs nothing
                 measurable, and concurrent crossings already overlapped
                 their RTTs

Where it bites instead: per-frame costs the suite doesn't model — radio wakeups
and packet counts on mobile, per-message broker/lambda pricing, head-of-line
processing on chatty views (kanban mounts a getAll per bucket). The honest
census: 185 of 195 tests touch the session; the biggest single-test reduction
was 40 -> 28 frames (project-history). comment-pagination's huge trip delta in
the raw report is seeding variance in that spec (107 vs 9 HTTP requests), not
batching — its ws frames went 4 -> 2.

Verdict (2026-07-09): neutral on every metric this corpus prices — wall time and
bytes at parity, frames-only win. DEFAULT OFF. Roadmap: re-review after more
ports — if no app in the corpus surfaces a case where frame count is the paid
unit, remove the mechanism and keep these results as the recorded answer.
